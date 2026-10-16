<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Workflow/PTC Execution Environment Analysis and Remediation Proposal

English | [中文](workflow-ptc-design.zh.md)

Status: Design discussion; not implemented. This document distinguishes
inspectable code behavior, deployment prerequisites, and proposed changes. The
Harness runtime, profile, and release artifacts must be rechecked against the
exact versions used in each deployment. Repository implementation references in
this document use code baseline `5221fff3d5e08b1e54ab349a67db82d245dc73ac`. See
the [glossary](../GLOSSARY.md) for terminology.

## 1. Conclusion

The recommended complete solution centers on a **target-bound execution scope**,
complemented by runtime supply and target-aware file access. The PTC worker runs
in the selected workspace container. The execution scope fixes the target and
manages the executable, bootstrap, final environment, sandbox, file references,
and process lifecycle.

Homogeneous image deployments can explicitly set the guest `nodeExecutable` and
`bootstrapPath` as migration configuration. The complete solution gives file
consumers a target-aware interface that accepts an execution scope and an
authorized file reference, and provides shared mapping, materialization inside
the guest, and desktop access. Each request is validated against its target and
returns a distinguishable result when that target lacks the required capability.

Split responsibilities into two modules, composed through an execution scope:

- **Execution module**: Binds the execution target, validates instance identity,
  prepares and starts processes, and manages cancellation, invalidation, and
  cleanup.
- **Runtime supply module**: Supplies a compatible Node, PTC worker/bootstrap,
  and dependency closure according to the scope and version requirements.
  Workspace images and read-only runtime artifact mounts are interchangeable
  supply adapters; both return versioned leases.

The initial support matrix must list workspace operating system, CPU
architecture, libc, Node version, and sandbox mode, and be validated with real
target images and desktop clients. Combinations outside the matrix remain
unverified.

## 2. Code Facts and Failure Hypotheses

### 2.1 Launch-Asset Path Contract and Failure Conditions

The DSH world hosts Harness orchestration logic; the execution world comprises
the files, programs, and environment actually visible to subprocesses in the
workspace container. Each world resolves absolute paths independently;
shared-mount file identity must be verified against the target.

The repository's
[control-channel documentation](workflow-control.md#deploy-both-halves) lists
the Node executable, workflow bootstrap, and their configuration paths inside
the workspace container as deployment prerequisites. The subprocess provider
runs the PTC worker in the workspace according to its working directory. If the
executable or bootstrap path supplied by the runtime comes from the DSH world
and the target container lacks the corresponding asset, the guest will fail when
executing the program or loading the bootstrap.

The Harness runtime determines the default executable and bootstrap selection,
and behavior varies by version. Integration must pin an exact version and verify
that version's default paths, configuration options, built/source/package run
modes, and release closure. The DSH image and workspace image supply Node and
its modules separately; each must be checked.

### 2.2 Existing Interfaces Lack Stable Target Binding

- [`SubprocessProvider.resolveExecutable`](../src/subprocess.ts#L19-L57) does
  not take a workspace or cwd: absolute paths are returned unchanged, while a
  bare command reports not found. Only `spawn(spec)` selects a workspace from
  `spec.cwd`, so the path resolver cannot verify a returned path in the target
  execution environment.
- [`WorkspaceBinding`](../src/workspace-binding.ts#L16-L27) has no
  container-generation field; the recreation flow preserves the agent token, as
  shown by
  [`ensureAgentToken`](../internal/orchestrator/grpcserver/container-lifecycle.go#L51-L64).
  The execution scope needs an additional instance generation to distinguish
  containers before and after recreation.
- [`FilesystemProvider.processPathFromHostPath`](../src/fs-provider.ts#L138-L142)
  accepts only a path string and returns synchronously; the current adapter
  returns absolute paths unchanged. Target-aware shared mapping requires mount
  identity, the resolved source path, and the execution generation, none of
  which this interface provides.
- The guest
  [constructs the subprocess environment after creating the command](../internal/guestagent/exec/exec.go#L63-L71);
  [`childenv`](../internal/guestagent/childenv/childenv.go#L78-L143) then
  produces the final environment. A bare command is therefore looked up using
  the guest-agent's PATH, while the child process receives the PATH constructed
  afterward. Execution preparation must first construct the final environment,
  resolve Node using that PATH, and start it with the same environment.
  `NODE_OPTIONS` and loader variables must also be governed before Node starts.
- [`remoteArgv`](../src/guest-rpc.ts#L785-L801) unwraps the Landlock wrapper;
  the existing [read-only tool gate](../src/read-only-shell.ts#L21-L35) does not
  include Workflow/PTC. PTC file-access confinement therefore depends on the
  guest policy in the execution world, and the launch result should report the
  policy the guest actually enforced.

These conclusions are limited to the cited repository code baseline. The active
deployment profile, image, and PTC runtime version actually loaded must be
verified separately.

### 2.3 Control Channel and Path Problems Are Independent

The Workflow/PTC subprocess provider requires `control`, `stdout`, and `stderr`
channels. The [control-channel documentation](workflow-control.md) and
[real guest test](../scripts/test-workflow-control.mjs) cover this transport
contract; separate checks verify Node and bootstrap supply in the target
environment.

Existing real-transport tests cover guest gRPC, data streams, EOF, cancellation,
and the control protocol. Runtime supply across containers and file-path
semantics require test fixtures with different filesystems and target images.

## 3. Design Goals and Invariants

1. A workflow's Node, worker, bootstrap, sandbox, cwd, and subprocess all belong
   to an authorized, bound execution instance.
2. Each call routes through an explicit workspace/container reference and
   generation; concurrent calls each retain their target binding.
3. Preparation freezes the target generation and final environment; executable
   resolution, asset lookup, sandbox preparation, and `spawn` use the same
   values.
4. Container recreation or an effective configuration change invalidates any
   execution plan not yet started; the guest validates the generation when
   accepting a launch. If the launch acknowledgement is lost, query the result
   by launch ID; retry only after confirming that the process did not start.
5. Shared mapping requires both sides to refer to the same file; a materialized
   copy has its own file identity; desktop opening depends on whether the target
   client can access the file. Each capability uses a distinct typed file
   reference.
6. Every supported attachment, image spill, and file-opening scenario declares
   the file capabilities it requires. When a capability is unavailable, return
   an error or fallback the consumer can recognize.
7. The guest enforces and reports the sandbox policy for the Node process
   actually run; refuse to launch when the target cannot enforce the requested
   policy.
8. Runtime supply pins a version and records its source; acceptance checks both
   the static manifest and what the guest actually loaded.

## 4. Recommended Modules and Interfaces

The external interface boundary is target selection. The caller resolves the
workspace and container from an authorized session/workspace reference and
interprets cwd as a path inside that target; selecting a named container
performs an authorization check.

The following TypeScript illustrates the responsibilities and lifecycle of the
proposed interfaces:

```ts
interface ExecutionWorlds {
  bind(
    target: AuthorizedExecutionTarget,
    signal?: AbortSignal,
  ): Promise<ExecutionScope>;
}

interface RuntimeSupply {
  acquire(
    scope: ExecutionScope,
    requirement: RuntimeRequirement,
    signal?: AbortSignal,
  ): Promise<RuntimeLease>;
}

interface ExecutionScope {
  prepare(
    request: LaunchRequest & { runtime: RuntimeLease },
    signal?: AbortSignal,
  ): Promise<PreparedExecution>;
  spawn(prepared: PreparedExecution): SubprocessHandle;
  readonly files: ScopedFileAccess;
  close(): Promise<void>;
}

type SharedMappingResult =
  | { kind: "mapped"; file: WorldFileRef }
  | { kind: "unavailable"; reason: "not-shared" | "unverifiable" };

interface ScopedFileAccess {
  mapShared(source: AuthorizedFileRef): Promise<SharedMappingResult>;
  materialize(
    source: AuthorizedFileRef,
    options: { maxBytes: number; readOnly: true },
    signal?: AbortSignal,
  ): Promise<WorldFileLease>;
}
```

The PTC runtime owns the program, bindings, frame protocol, time limits, output
limits, and result types, and obtains the worker through the execution
interface. The Podman Execution module handles target binding, preparation, and
process startup. Ordinary shell/subprocess calls continue to use the existing
subprocess interface; calls that must resolve and start in the same target use
an execution scope.

### 4.1 Execution-Scope Identity and Lifecycle

The scope returned by `bind` fixes the workspace container, cwd, guest instance,
and effective configuration. Internal instance identity must include at least
the workspace generation, container generation, guest boot identity, and actual
image digest. Changes to mounts, environment variables, or paths that affect
visible files or the process environment must advance the generation or
configuration revision. Callers receive only an opaque reference without
credentials; secrets such as `agentToken` and socket paths must not appear in
model-visible results.

Recommended execution order:

```text
authorized target → bind scope → acquire matching runtime → freeze guest environment
→ prepare (executable, bootstrap, sandbox, stdio) → one-shot spawn
→ ready/control protocol → run/cancel/exit → close scope and release assets
```

`PreparedExecution` encapsulates the frozen cwd, env, executable, runtime,
sandbox, and stdio. Only the scope that created it can consume it, and only
once. `spawn` accepts only a prepared execution plan. `close` is idempotent; it
clears unconsumed plans, releases asset leases, and terminates running processes
owned by that scope.

The control plane issues the generation, which the guest checks during the
handshake and when accepting a launch. Container recreation and process
admission are coordinated by generation; even if a token, socket, or container
name is reused, the new instance accepts launches only for the new generation.
If an acknowledgement is lost, the caller queries the result for the original
generation by launch ID. If the result remains unknown, keep it unknown; allow a
retry only after confirming that the launch did not start.

The generation identifies the container configuration version; files in a
writable project mount can still change according to workspace semantics. To
ensure the worker closure cannot be replaced, supply all assets through a
protected, read-only mechanism; hash/stat preflight still leaves a race between
check and execution. `RuntimeLease` describes runtime assets and does not
include a snapshot of project code.

### 4.2 Runtime Supply and Platform Support

`RuntimeSupply` accepts the `RuntimeRequirement` declared by the PTC runtime and
selects an asset lease for the bound target according to a version manifest.
`RuntimeRequirement` identifies the PTC release, worker protocol version, and
target platform. The manifest lists:

- PTC package/release identity, worker protocol version, and
  bootstrap/dependency-closure digest;
- Node version or compatibility range, operating system, CPU architecture,
  libc/dynamic loader, and required system libraries;
- entry-point layout, read-only properties, and asset version; if native addons
  are present, their corresponding ABI as well.

Build and test workspace images according to the support matrix, providing a
matching Node and worker closure; a read-only runtime image mount can be an
alternative supply adapter. Node releases must match the operating system,
architecture, libc, dynamic loader, and native ABI. Release CI verifies the
actual release closure and startup behavior in a clean target image.

The existing [`image_build` parameters](../src/tool-params.ts#L127-L139) accept
only a parent image and system packages; the
[image builder](../internal/orchestrator/images/images.go#L88-L150) generates
installation steps using the distribution's package manager and currently
defines no PTC runtime manifest or supply protocol. The existing
[`DSH_PODMAN_BASE_IMAGE_PREFIX`](../internal/orchestrator/grpcserver/image-resolve.go#L22-L103)
prepends a registry prefix to fixed base-image short names, uses `:latest`, and
applies to the entire base-image set. New managed assets require a build
recipe/manifest, immutable digest, upgrade rules, and migration procedures for
derived images and existing containers.

`RuntimeSupply` provides assets within an already bound scope. If an update
requires container recreation, complete it before the workflow starts, then bind
to the new generation. A running workflow retains its container and permissions.
Return a diagnosable error for no network, no supply permission, an incompatible
version, or a missing closure; do not install the runtime while a workflow is
running.

### 4.3 File Access: Mapping, Materialization, and Desktop Opening

`processPathFromHostPath(hostPath)` accepts only a path string and carries no
target or authorization. Migrate each file consumer to the file interface within
an execution scope and select the required capability: shared mapping,
materialization, or desktop access.

- **Shared mapping**: Success requires mount and source-file identity, the
  selected workspace scope, the resolved path, and the current generation to
  prove that both sides refer to the same file. The implementation must cover
  nested workspaces, symlinks, submount shadowing, overlay filesystems, and
  container recreation. If identity cannot be proven, the request returns
  `shared mapping unavailable`.
- **Materialized copy**: `materialize` copies an authorized file into the target
  execution world and returns an independent guest file reference. The interface
  limits file size and specifies read-only properties, lifetime, cache key,
  quotas, and cleanup.
- **Desktop open/Reveal**: `DesktopOpener` accepts an authorized file reference
  and delegates the open or Reveal operation to a desktop client that can access
  the file. The adapter resolves a reference usable by that client and reports
  when the target is unreachable.

LLM attachments and images that workers need to read can use read-only
materialized references supplied by the scope. If materialization is
unavailable, the consumer uses a validated inline fallback or returns a clear
error. Text spill continues to use a bounded guest-local file handle; file
opening is handled by `DesktopOpener`. Validate each consumer's quotas, cleanup,
fallback, and desktop target separately.

Migrate file consumers in batches. Each batch implements the required scoped
mapping, materialization, or desktop access. Remove the old synchronous method
only after confirming that every call site uses a target-aware capability.

### 4.4 Final Environment, Executable, and Sandbox

The guest first constructs one final environment and defines the rules for
inheritance, explicit overrides, tombstones, and Node/loader variables. It then
resolves the executable to an absolute path using the same cwd, uid, and final
PATH that it uses to start the process.

The guest enforces the sandbox policy and reports its actual enforcement in the
handshake and launch result. [`remoteArgv`](../src/guest-rpc.ts#L785-L801)
unwraps the Landlock wrapper, so the target guest must implement the requested
mode and return a clear error if it cannot. A read-only runtime mount protects
runtime assets; the workflow sandbox separately constrains project-file access.

## 5. Options and Trade-offs

| Option                                      | Capability                                                                                                                                    | Limitations                                                                                                                                                       | Position                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Explicit `nodeExecutable` + `bootstrapPath` | Specifies guest runtime entry points for deployments with a fixed image layout                                                                | Suited to homogeneous workspace images; heterogeneous target selection, general executable validation, and target-aware file capabilities require separate design | Compatibility/transition mode   |
| Target-bound execution scope                | Unifies target, preparation, environment, sandbox, files, and process lifecycle; supports concurrent workspaces and named containers          | Requires extending Harness interfaces and Podman control/guest protocols, and coordinating generations                                                            | Recommended execution core      |
| `RuntimeSupply`                             | Provides an exact-version runtime closure for the target OS/architecture; workspace images and read-only artifact mounts can both be adapters | Requires a manifest, release validation, and image/asset upgrade procedures                                                                                       | Paired with the execution scope |

Use `ExecutionScope` as the primary launch path and have `RuntimeSupply` provide
a runtime lease for that scope. The former handles target selection, validation,
preparation, startup, and release; the latter selects a compatible closure and
records its version. Workspace images and read-only runtime mounts use the same
launch flow.

## 6. Errors, Cancellation, and Compatibility

Define stable errors for an invalidated scope, target mismatch, unavailable
runtime, unsupported platform, unverifiable shared mapping, materialization over
the limit, unsupported sandbox, missing guest capability, and unknown launch
outcome. Error types must distinguish permission denial, cancellation, file not
found, and unavailable capability, and be paired with the corresponding PTC
runtime release.

`spawn(prepared)` preserves the subprocess calling convention: `control`,
`stdout`, and `stderr` handles are available before the caller begins writing;
remote launch failures are reported through handle completion. Cancellation must
terminate the guest process group and release scope resources. Real transport
contract tests continue to cover control-channel EOF, backpressure, capability
negotiation with older guests, and exit cleanup.

The transition adapter accepts explicit Node and bootstrap paths as a pair and
validates both in the same scope. Upgrades retain the previous compatible
runtime/image combination; after container recreation, bind to the new
generation, then revalidate assets and transport.

## 7. Phased Implementation and Acceptance

Expand the support matrix in stages; record existing test coverage and new test
results for each item.

| Phase                            | Deliverable                                                                                          | Key acceptance criteria                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Interface and protocol design | Target scope, generation, prepared launch, capability negotiation, and error semantics               | Two concurrent workspaces do not cross targets; after recreation or configuration change, the guest rejects an old plan; a lost acknowledgement does not cause duplicate execution |
| 2. `RuntimeSupply`               | Version manifest, controlled image recipe, or read-only runtime artifact                             | Closure checks pass in a clean container without a DSH module mount; cover OS/architecture/libc/dynamic loader, incompatible versions, and upgrade/recreation                      |
| 3. Environment and sandbox       | Guest-side final environment, executable resolution using the same PATH, and target-side confinement | Control guest-only `NODE_OPTIONS`/loader injection before Node starts; actual file access follows policy; reject unsupported modes                                                 |
| 4. File-consumer migration       | Separate adapters for shared mapping, materialization, and desktop opening                           | Test attachment reads, image prompts/spill, inline fallback, and open/Reveal separately; unverified mappings do not leak paths                                                     |
| 5. End-to-end support matrix     | PTC workflow, control transport, workspace images, and deployment process                            | Cover different DSH/guest filesystems, real target images, container recreation, cancellation, failure, and rollback                                                               |

The existing
[`make test-workflow-control`](workflow-control.md#regression-checks) real-guest
test covers gRPC, streams, EOF, cancellation, and the control protocol. New
cross-environment tests must use different filesystems and target images, and
cover concurrent workspaces, same-name/different-content paths,
symlinks/submounts/overlay, generation invalidation, environment precedence,
Node ABI/dynamic loader, attachment quotas and cleanup, desktop capabilities,
sandbox rejection, control backpressure, and upgrade rollback.

After implementation, run `make test`, `make vet`, and `make fmt-check`.
Cross-environment acceptance must also use real images and release runtimes from
the declared support matrix. Formatting checks validate documentation and source
formatting; integration tests validate runtime behavior.

## 8. Questions for Review

1. How should execution-scope owners and callers pass trusted
   workspace/container references without exposing control-plane credentials to
   the PTC program?
2. Who issues container generations? Which mount, environment, or image changes
   must advance a generation? How does the guest coordinate validation at launch
   acceptance with container recreation?
3. Which operating systems, CPUs, libc versions, Node versions, and sandbox
   modes should the initial release support? How will the worker manifest be
   generated from actual release packages and its dependency closure verified?
4. Should runtime supply use workspace images, managed runtime image mounts, or
   both to meet upgrade, read-only, size, and administrator-control
   requirements? The existing base-image prefix mechanism uses global short
   names and `:latest`; should it gain a controlled manifest and immutable
   digest path?
5. How should `processPathFromHostPath` be migrated? May attachments and images
   be materialized in the guest under quotas? Which desktop client should handle
   open/Reveal, and what is the fallback on failure?
6. Which guest-enforced sandbox modes should be supported first, and what error
   should unsupported modes return? How will acceptance distinguish program
   confinement from a read-only runtime-asset mount?
7. How long should old configuration remain supported? How should explicit paths
   be restricted to a selected execution instance? Should a migration
   diagnostics tool be provided?

## 9. Facts and Verification Boundaries

Harness runtime defaults, the version actually loaded in a deployment, and the
release closure vary by package version. Confirm the exact package in the active
profile, then verify its default paths, configuration, and closure. Repository
source, the Containerfile, and package layout do not show what a particular
deployment has loaded. The image used by the current deployment and its desktop
topology are also deployment inputs and must be checked separately.

The interfaces, generation protocol, `RuntimeSupply` manifest, target-aware file
capabilities, and new acceptance criteria in this document are proposals. The
cited repository code describes the existing provider and transport contract;
deployed-package behavior and end-to-end results remain to be verified in the
corresponding environment.
