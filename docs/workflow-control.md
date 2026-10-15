<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Workflow subprocess control transport

English | [中文](workflow-control.zh.md)

Harness workflows request `stdio.control: "pipe"` and immediately build a
channel. The Podman provider must return a separate `Duplex` synchronously,
alongside stdout/stderr. Without it, Harness fails before workflow code or model
calls run:

```text
subprocess provider did not supply the requested control and output pipes
```

[subprocess.ts](../src/subprocess.ts) creates input handles before workspace
resolution. [exec-inputs.ts](../src/exec-inputs.ts) queues early writes,
separates stdin from control bytes, and forwards their EOFs independently.
Writes use 32 KiB messages and await transport receipts, allowing a single write
above gRPC's default 4 MiB message limit. Control reads apply backpressure
without echoing caller writes.

The guest passes one end of a Unix socket pair to the child as fd 7 and sets
`DSH_SUBPROCESS_CONTROL=pipe`, matching `@deepseek-ai/dsh-subprocess/control`.
The guest owns this marker and removes it when no channel is requested. Its
first process-id reply acknowledges control support. An updated plugin rejects
an old guest with an explicit rebuild-and-recreate message rather than waiting
for a worker handshake. Commands without control keep the legacy stdin EOF
convention.

## Transport limits

EOFs are independent, but the channels share gRPC backpressure. The guest writes
incoming chunks serially: if a child stops reading one input, that write can
block later chunks on either input. A caller must not fill stdin while the child
waits for a control message that would tell it to read stdin, or vice versa.
Harness workflows use `stdin: "ignore"`, avoiding this cross-input dependency.

The guest drains stdout, stderr, and control before reporting exit. A descendant
that inherits fd 7 can therefore delay exit reporting after the direct child
exits, just as an inherited stdout/stderr pipe can. Children must close unused
inherited descriptors; cancelling the RPC closes the guest endpoints and cancels
the command's process group.

## Regression checks

Run the TypeScript and Go tests and checks:

```bash
pnpm install --frozen-lockfile
make test
make vet
make fmt-check
```

On Linux, run [the real transport test](../scripts/test-workflow-control.mjs):

```bash
make test-workflow-control
```

It builds a Go guest, starts it on a private Unix socket, and runs Node children
through the provider. It checks binary round trips above 4 MiB, separate
diagnostics, independent stdin/control EOF, termination, and failed startup. No
Podman daemon or model endpoint is needed. On native ARM64, pass `GOARCH=arm64`;
the default target is Linux amd64.

To also test the co-shipped Harness workflow worker, point to the
`@deepseek-ai/dsh-ptc-runtime-node/process` bundle from the **same Harness
version**:

```bash
DSH_PODMAN_TEST_PTC_BOOTSTRAP=/absolute/path/to/process.js make test-workflow-control
```

This adds `ready → boot → done` and `ready → boot → call → reply → done` checks.
The second echoes a binding argument; neither calls an LLM or establishes model
routing or provider availability. Without the variable, only the four Node
transport tests are registered.

## Deploy both halves

Passing tests or editing a checkout does not update a running plugin. Install
the new npm archive in the actual DSH profile, then build and configure the
matching guest-agent image; see
[local deployment](development.md#install-a-local-plugin-build). Recreate
workspace containers after switching the guest image: reusing a local image tag
does not update agents already running in containers.

The subprocess executable and workflow bootstrap must exist **inside the
workspace container**. For Node, set `nodeExecutable` and, if host paths are not
mounted, `bootstrapPath` to container paths. Use the bootstrap from the running
Harness version. Installing Node alone does not expose the host's npm modules.

Then run a minimal workflow through the original Harness tool:

```javascript
return { transportCheck: "ok", modelCalls: 0, fileWrites: 0 };
```

Check model dispatch only after this succeeds. The isolated tests verify the
transport and worker protocol; the original tool also checks the installed
plugin, guest image, runtime paths, and Harness configuration.
