// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// This descriptor and marker are the public dsh-subprocess/control contract.
const subprocessControlFD = 7
const subprocessControlEnv = "DSH_SUBPROCESS_CONTROL"

type execControl struct {
	parent *net.UnixConn
	child  *os.File
}

func prepareExecControl(cmd *exec.Cmd, enabled bool) (*execControl, error) {
	// Neither an ambient variable nor a caller-supplied marker can pretend a
	// descriptor was created. The guest owns this launch fact.
	env := cmd.Env[:0]
	for _, entry := range cmd.Env {
		if !strings.HasPrefix(entry, subprocessControlEnv+"=") {
			env = append(env, entry)
		}
	}
	cmd.Env = env
	if !enabled {
		return nil, nil
	}
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parentFile := os.NewFile(uintptr(pair[0]), "exec-control-parent")
	child := os.NewFile(uintptr(pair[1]), "exec-control-child")
	conn, err := net.FileConn(parentFile)
	_ = parentFile.Close() // FileConn duplicates the descriptor.
	if err != nil {
		_ = child.Close()
		return nil, err
	}
	control := &execControl{parent: conn.(*net.UnixConn), child: child}
	// ExtraFiles[0] is fd 3; the unused descriptors 3..6 remain closed.
	cmd.ExtraFiles = make([]*os.File, subprocessControlFD-2)
	cmd.ExtraFiles[subprocessControlFD-3] = child
	cmd.Env = append(cmd.Env, subprocessControlEnv+"=pipe")
	return control, nil
}

func (c *execControl) close() {
	if c == nil {
		return
	}
	_ = c.child.Close()
	_ = c.parent.Close()
}

func (c *execControl) closeWrite() {
	if c != nil {
		_ = c.parent.CloseWrite()
	}
}
