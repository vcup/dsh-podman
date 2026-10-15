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
	argv := first.GetStart().GetArgv()
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
	process, err := s.Processes.Start(stream.Context(), start.GetArgv(), start.GetCwd(), start.GetEnv(), identity.Options{Uid: uid, Gid: gid, Groups: start.GetGroups()}, start.GetUnsetEnv()...)
	if err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	// The process is registered before it is started, so every path that
	// gives up before Command.Start must drop it again. A leaked entry keeps
	// a process with no os.Process in the map for the agent's lifetime, where
	// any later Signal for that id would find it.
	started := false
	defer func() {
		if !started {
			s.Processes.Remove(process.ID)
		}
	}()
	stdout, err := process.Command.StdoutPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	stderr, err := process.Command.StderrPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	// Only a caller that will send stdin gets a pipe. Without one the child
	// keeps Go's default stdin (/dev/null): a pipe is a non-TTY stdin, and a
	// tool like ripgrep reads stdin instead of the working directory when it is
	// given no path.
	var stdin io.WriteCloser
	if start.GetStdinPipe() {
		stdin, err = process.Command.StdinPipe()
		if err != nil {
			return status.Error(codes.Internal, err.Error())
		}
	}
	if err := process.Command.Start(); err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	started = true
	// Publish the started handle so Signal never reads Command.Process while
	// Start is still writing it.
	process.SetProcess(process.Command.Process)
	spillStdout := s.newSpill(start.GetSpillStdout().GetPath(), start.GetSpillStdout().GetMaxBytes())
	spillStderr := s.newSpill(start.GetSpillStderr().GetPath(), start.GetSpillStderr().GetMaxBytes())
	var sendMu sync.Mutex
	send := func(output *guest.ExecOutput) error {
		output.ProcessId = process.ID
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(output)
	}
	// Report the process id before any output. A caller that must cancel a
	// silent command (a background job, a timed-out exec) can only signal an id
	// it has been told, and a command that produces no output until it exits
	// would otherwise leave that caller unable to signal it at all.
	if err := send(&guest.ExecOutput{}); err != nil {
		return err
	}
	errCh := make(chan error, 2)
	var copies sync.WaitGroup
	copyOutput := func(reader io.Reader, stderr bool, spill *spillWriter) {
		defer copies.Done()
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				data := append([]byte(nil), buffer[:n]...)
				spill.write(data)
				output := &guest.ExecOutput{}
				if stderr {
					output.Payload = &guest.ExecOutput_StderrChunk{StderrChunk: data}
				} else {
					output.Payload = &guest.ExecOutput_StdoutChunk{StdoutChunk: data}
				}
				if sendErr := send(output); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					errCh <- readErr
				}
				return
			}
		}
	}
	copies.Add(2)
	go copyOutput(stdout, false, spillStdout)
	go copyOutput(stderr, true, spillStderr)
	go func() {
		for {
			input, recvErr := stream.Recv()
			if recvErr != nil {
				if stdin != nil {
					_ = stdin.Close()
				}
				return
			}
			if stdin == nil {
				continue
			}
			if chunk := input.GetStdinChunk(); len(chunk) > 0 {
				if _, writeErr := stdin.Write(chunk); writeErr != nil {
					_ = stdin.Close()
					return
				}
			}
		}
	}()
	// Drain both pipes to EOF before reaping the process: Command.Wait closes
	// the pipe read ends, which would discard output the copying goroutines
	// have not read yet. The exit message is sent only after this, so the spill
	// validity and the final chunks are final when the caller sees them.
	copies.Wait()
	// Read what the copiers recorded instead of dropping it: a send or read
	// failure means the caller's stream is likely gone.
	copyErr := drainErr(errCh)
	waitErr := process.Command.Wait()
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
			// The stream is confirmed dead; the copy failure is the cause.
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
// channel is buffered for both copiers, so this never blocks.
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
