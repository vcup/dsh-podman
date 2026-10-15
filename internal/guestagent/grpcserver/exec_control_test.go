// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"strings"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

func TestExecControlRoundTrip(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{
		{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:        []string{"sh", "-c", `test "$DSH_SUBPROCESS_CONTROL" = pipe || exit 11; printf stdout; printf stderr >&2; IFS= read -r value <&7 || exit 12; printf 'reply:%s\n' "$value" >&7`},
			Cwd:         root,
			ControlPipe: true,
		}}},
		{Payload: &guest.ExecInput_ControlChunk{ControlChunk: []byte("request\n")}},
		{Payload: &guest.ExecInput_ControlEof{ControlEof: true}},
	}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if exit := stream.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("exit: %v", exit)
	}
	if !stream.outputs[0].GetControlReady() {
		t.Fatal("first output must acknowledge the requested channel")
	}
	var control, stderr strings.Builder
	eof := false
	for _, output := range stream.outputs {
		control.Write(output.GetControlChunk())
		stderr.Write(output.GetStderrChunk())
		if output.GetControlEof() {
			eof = true
		}
	}
	if control.String() != "reply:request\n" {
		t.Fatalf("control = %q", control.String())
	}
	if !eof {
		t.Fatal("missing control EOF")
	}
	if stream.stdout() != "stdout" || stderr.String() != "stderr" {
		t.Fatal("control must not mix with diagnostic output")
	}
	if len(server.Processes.List()) != 0 {
		t.Fatal("completed process remains registered")
	}
}

func TestExecStdinEOFDoesNotCloseControl(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{
		{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv: []string{"sh", "-c", `input=$(cat); IFS= read -r command <&7 || exit 13; printf '%s:%s\n' "$input" "$command" >&7`},
			Cwd:  root, StdinPipe: true, ControlPipe: true,
		}}},
		{Payload: &guest.ExecInput_StdinChunk{StdinChunk: []byte("input")}},
		{Payload: &guest.ExecInput_StdinEof{StdinEof: true}},
		{Payload: &guest.ExecInput_ControlChunk{ControlChunk: []byte("control\n")}},
		{Payload: &guest.ExecInput_ControlEof{ControlEof: true}},
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
	if control.String() != "input:control\n" {
		t.Fatalf("control = %q", control.String())
	}
}

func TestExecCannotForgeControlMarker(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
		Argv: []string{"sh", "-c", `test -z "${DSH_SUBPROCESS_CONTROL+x}"`}, Cwd: root,
		Env: map[string]string{"DSH_SUBPROCESS_CONTROL": "pipe"},
	}}}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if exit := stream.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("unrequested marker was inherited: %v", exit)
	}
}
