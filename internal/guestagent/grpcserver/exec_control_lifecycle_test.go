// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

func TestExecControlEOFDoesNotCloseStdin(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{
		{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv: []string{"sh", "-c", `control=$(cat <&7); input=$(cat); printf '%s:%s' "$control" "$input" >&7`},
			Cwd:  root, StdinPipe: true, ControlPipe: true,
		}}},
		{Payload: &guest.ExecInput_ControlChunk{ControlChunk: []byte("control")}},
		{Payload: &guest.ExecInput_ControlEof{ControlEof: true}},
		{Payload: &guest.ExecInput_StdinChunk{StdinChunk: []byte("input")}},
		{Payload: &guest.ExecInput_StdinEof{StdinEof: true}},
	}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if exit := stream.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("exit: %v", exit)
	}
	var control strings.Builder
	for _, output := range stream.outputs {
		control.Write(output.GetControlChunk())
	}
	if control.String() != "control:input" {
		t.Fatalf("control = %q", control.String())
	}
}

type lifecycleExecStream struct {
	*execStream
	ctx    context.Context
	onSend func(*guest.ExecOutput) error
}

func (s *lifecycleExecStream) Context() context.Context            { return s.ctx }
func (s *lifecycleExecStream) Send(output *guest.ExecOutput) error { return s.onSend(output) }

func TestExecControlCancellationUnblocksAndReaps(t *testing.T) {
	server, root := newTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{}, 1)
	stream := &lifecycleExecStream{
		execStream: &execStream{inputs: []*guest.ExecInput{{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv: []string{"sh", "-c", `trap '' TERM; printf x >&7; sleep 30`}, Cwd: root, ControlPipe: true,
		}}}}}, ctx: ctx,
		onSend: func(output *guest.ExecOutput) error {
			// Control output is sent only after the readiness Send succeeds;
			// cancel cannot accidentally exercise the failed-acknowledgement path.
			if len(output.GetControlChunk()) > 0 {
				started <- struct{}{}
			}
			return ctx.Err()
		},
	}
	done := make(chan error, 1)
	go func() { done <- server.Exec(stream) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("exec did not start")
	}
	processes := server.Processes.List()
	if len(processes) != 1 {
		t.Fatalf("processes: %v", processes)
	}
	pid := processes[0].ProcessHandle().Pid
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled control pipe kept Exec blocked")
	}
	if len(server.Processes.List()) != 0 {
		t.Fatal("cancelled process remains registered")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child was not reaped: %v", err)
	}
}

func TestExecControlFailedAcknowledgementReaps(t *testing.T) {
	server, root := newTestServer(t)
	failure := errors.New("transport lost before readiness")
	pid := 0
	stream := &lifecycleExecStream{
		execStream: &execStream{inputs: []*guest.ExecInput{{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv: []string{"sh", "-c", "sleep 30"}, Cwd: root, ControlPipe: true,
		}}}}}, ctx: context.Background(),
		onSend: func(_ *guest.ExecOutput) error {
			pid = server.Processes.List()[0].ProcessHandle().Pid
			return failure
		},
	}
	if err := server.Exec(stream); !errors.Is(err, failure) {
		t.Fatalf("error: %v", err)
	}
	if len(server.Processes.List()) != 0 {
		t.Fatal("failed process remains registered")
	}
	if pid == 0 {
		t.Fatal("no process was started")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child was not reaped: %v", err)
	}
}
