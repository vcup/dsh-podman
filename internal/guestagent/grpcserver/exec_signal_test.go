// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

// Signal exit metadata follows the terminal convention even without control:
// exit code -1 and the human-readable signal name, not its SIG-prefixed token.
func TestExecReportsSignalExitWithoutControl(t *testing.T) {
	for _, tc := range []struct {
		signal     string
		wantSignal string
	}{
		{signal: "TERM", wantSignal: "terminated"},
		{signal: "KILL", wantSignal: "killed"},
	} {
		t.Run("SIG"+tc.signal, func(t *testing.T) {
			server, root := newTestServer(t)
			stream := &execStream{inputs: []*guest.ExecInput{{Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
				Argv: []string{"sh", "-c", "kill -" + tc.signal + " $$"}, Cwd: root,
			}}}}}
			if err := server.Exec(stream); err != nil {
				t.Fatal(err)
			}
			exit := stream.exit()
			if exit == nil {
				t.Fatal("missing exit message")
			}
			if !exit.GetSignaled() || exit.GetSignal() != tc.wantSignal || exit.GetExitCode() != -1 {
				t.Fatalf("exit = %v, want signaled=true signal=%q exit_code=-1", exit, tc.wantSignal)
			}
		})
	}
}
