// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	osexec "os/exec"
	"sync"
	"syscall"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) Exec(stream guest.WorkspaceGuestAgent_ExecServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first exec message must be start")
	}
	argv := start.GetArgv()
	argv0 := ""
	if len(argv) > 0 {
		argv0 = argv[0]
	}
	slog.Info("guest agent Exec started", "argv0", argv0, "argc", len(argv))
	uid, err := optionalID(start.GetUid(), "uid")
	if err != nil {
		return err
	}
	gid, err := optionalID(start.GetGid(), "gid")
	if err != nil {
		return err
	}
	process, err := s.Processes.Start(stream.Context(), argv, start.GetCwd(), start.GetEnv(), identity.Options{Uid: uid, Gid: gid, Groups: start.GetGroups()}, start.GetUnsetEnv()...)
	if err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	defer s.Processes.Remove(process.ID)
	control, err := prepareExecControl(process.Command, start.GetControlPipe())
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	defer control.close()
	stdout, err := process.Command.StdoutPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	defer stdout.Close()
	stderr, err := process.Command.StderrPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	defer stderr.Close()
	// With no requested stdin pipe keep /dev/null: tools such as ripgrep
	// interpret a non-TTY pipe as input instead of searching the directory.
	var stdin io.WriteCloser
	if start.GetStdinPipe() {
		stdin, err = process.Command.StdinPipe()
		if err != nil {
			return status.Error(codes.Internal, err.Error())
		}
		defer stdin.Close()
	}
	if err := process.Command.Start(); err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	if control != nil {
		_ = control.child.Close()
	}
	waited := false
	defer func() {
		// A failed initial Send must not leave a live process or a zombie.
		if !waited {
			_ = process.Command.Cancel()
			_ = process.Command.Wait()
		}
	}()
	// Publish the handle under the process lock; Signal must not race Start.
	process.SetProcess(process.Command.Process)
	stopClose := context.AfterFunc(stream.Context(), func() {
		control.close()
		_ = stdout.Close()
		_ = stderr.Close()
		if stdin != nil {
			_ = stdin.Close()
		}
	})
	defer stopClose()
	spillStdout := s.newSpill(start.GetSpillStdout().GetPath(), start.GetSpillStdout().GetMaxBytes())
	spillStderr := s.newSpill(start.GetSpillStderr().GetPath(), start.GetSpillStderr().GetMaxBytes())
	defer spillStdout.close()
	defer spillStderr.close()
	var sendMu sync.Mutex
	send := func(output *guest.ExecOutput) error {
		output.ProcessId = process.ID
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(output)
	}
	// Acknowledge the descriptor before output; old guests cannot silently
	// accept a requested channel and leave the workflow waiting for readiness.
	if err := send(&guest.ExecOutput{ControlReady: control != nil}); err != nil {
		return err
	}
	errCh := make(chan error, 3)
	var copies sync.WaitGroup
	copyOutput := func(reader io.Reader, channel string, spill *spillWriter) {
		defer copies.Done()
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				data := append([]byte(nil), buffer[:n]...)
				if spill != nil {
					spill.write(data)
				}
				output := &guest.ExecOutput{}
				switch channel {
				case "stderr":
					output.Payload = &guest.ExecOutput_StderrChunk{StderrChunk: data}
				case "control":
					output.Payload = &guest.ExecOutput_ControlChunk{ControlChunk: data}
				default:
					output.Payload = &guest.ExecOutput_StdoutChunk{StdoutChunk: data}
				}
				if sendErr := send(output); sendErr != nil {
					errCh <- sendErr
					_ = process.Command.Cancel()
					return
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					errCh <- readErr
				} else if channel == "control" {
					if err := send(&guest.ExecOutput{Payload: &guest.ExecOutput_ControlEof{ControlEof: true}}); err != nil {
						errCh <- err
					}
				}
				return
			}
		}
	}
	copies.Add(2)
	go copyOutput(stdout, "stdout", spillStdout)
	go copyOutput(stderr, "stderr", spillStderr)
	if control != nil {
		copies.Add(1)
		go copyOutput(control.parent, "control", nil)
	}
	go func() {
		defer func() {
			if stdin != nil {
				_ = stdin.Close()
			}
			control.closeWrite()
		}()
		stdinOpen := stdin != nil
		controlOpen := control != nil
		for {
			input, recvErr := stream.Recv()
			if recvErr != nil {
				return
			}
			switch payload := input.Payload.(type) {
			case *guest.ExecInput_StdinEof:
				if payload.StdinEof && stdinOpen {
					_ = stdin.Close()
					stdinOpen = false
				}
			case *guest.ExecInput_ControlEof:
				if payload.ControlEof && controlOpen {
					control.closeWrite()
					controlOpen = false
				}
			case *guest.ExecInput_StdinChunk:
				if stdinOpen {
					if _, err := stdin.Write(payload.StdinChunk); err != nil {
						_ = stdin.Close()
						stdinOpen = false
					}
				}
			case *guest.ExecInput_ControlChunk:
				if controlOpen {
					if _, err := control.parent.Write(payload.ControlChunk); err != nil {
						control.closeWrite()
						controlOpen = false
					}
				}
			}
		}
	}()
	// Read every final byte before Wait closes the stdout/stderr pipe ends.
	// The control read half is independent of both caller input EOFs.
	copies.Wait()
	copyErr := drainErr(errCh)
	waitErr := process.Command.Wait()
	waited = true
	spillStdout.close()
	spillStderr.close()
	s.Processes.Remove(process.ID)
	exit := int32(0)
	signaled := false
	signalName := ""
	if waitErr != nil {
		exit = 1
		var exitErr *osexec.ExitError
		if errors.As(waitErr, &exitErr) {
			exit = int32(exitErr.ExitCode())
			if waitStatus, ok := exitErr.Sys().(syscall.WaitStatus); ok && waitStatus.Signaled() {
				signaled = true
				signalName = waitStatus.Signal().String()
			}
		}
	}
	if err := send(&guest.ExecOutput{Payload: &guest.ExecOutput_Exit{Exit: &guest.ExecExit{
		ExitCode:         exit,
		Signaled:         signaled,
		Signal:           signalName,
		StdoutSpillValid: spillStdout.valid(),
		StderrSpillValid: spillStderr.valid(),
	}}}); err != nil {
		if copyErr != nil {
			return copyErr
		}
		return err
	}
	if copyErr != nil {
		slog.Warn("guest agent Exec output copy failed", "error", copyErr)
	}
	slog.Info("guest agent Exec completed", "exit_code", exit, "signaled", signaled)
	return nil
}

// drainErr returns the first error the output copiers recorded, if any. The
// channel is buffered for all copiers, so this never blocks.
func drainErr(errCh <-chan error) error {
	var first error
	for {
		select {
		case err := <-errCh:
			if first == nil {
				first = err
			}
		default:
			return first
		}
	}
}

func (s *Server) Signal(_ context.Context, request *guest.SignalRequest) (*guest.SignalResponse, error) {
	for _, process := range s.Processes.List() {
		if process.ID != request.GetProcessId() {
			continue
		}
		// The handle is nil until Start succeeds, and Exec registers the
		// process before starting it.
		handle := process.ProcessHandle()
		if handle == nil {
			return nil, status.Error(codes.FailedPrecondition, "process is not running")
		}
		signal, err := signalForName(request.GetSignal())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		sig, ok := signal.(syscall.Signal)
		if !ok {
			return nil, status.Error(codes.InvalidArgument, "unsupported signal")
		}
		// The command leads its own process group, so signal the group rather
		// than the direct child: a shell defers a signal while its foreground
		// child runs, and the caller's kill must reach that child too.
		if err := syscall.Kill(-handle.Pid, sig); err != nil {
			if fallbackErr := handle.Signal(signal); fallbackErr != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
		}
		return &guest.SignalResponse{}, nil
	}
	return nil, status.Error(codes.NotFound, "process not found")
}

// signals maps the names callers may use onto the signal actually delivered.
// os.Interrupt is SIGINT, so SIGTERM must not be spelled with it: a process
// that ignores SIGINT but honours SIGTERM would otherwise never stop.
var signals = map[string]os.Signal{
	"SIGHUP":  syscall.SIGHUP,
	"SIGINT":  syscall.SIGINT,
	"SIGQUIT": syscall.SIGQUIT,
	"SIGKILL": syscall.SIGKILL,
	"SIGTERM": syscall.SIGTERM,
	"SIGUSR1": syscall.SIGUSR1,
	"SIGUSR2": syscall.SIGUSR2,
}

// signalForName resolves a signal name. An empty name means SIGTERM, the
// default for asking a process to stop; an unrecognised name is an error
// rather than a silent substitution.
func signalForName(name string) (os.Signal, error) {
	if name == "" {
		return syscall.SIGTERM, nil
	}
	signal, ok := signals[name]
	if !ok {
		return nil, fmt.Errorf("unknown signal %q", name)
	}
	return signal, nil
}
