<!--
SPDX-FileCopyrightText: 2026 dsh-podman contributors

SPDX-License-Identifier: MIT
-->

# dsh-podman Domain Terms

This glossary defines the environment, resource, and file terms used in
dsh-podman.

## Language

**DSH world**: The environment that runs Harness orchestration logic. _Avoid_:
Ambiguous uses of “host” or “machine”.

**Execution world**: The environment whose files, executables, and variables are
visible to a particular execution. _Avoid_: Unqualified “local”.

**Workspace**: A project and the execution resources associated with it.

**DSH profile**: A set of Harness plugins and configuration that defines the
Harness runtime environment. _Avoid_: “Workspace image”.

**Workspace image**: A container image used to create a workspace container's
filesystem. _Avoid_: Unqualified “DSH image”.

**PTC worker**: A process that executes a program in a selected execution world
and exchanges calls and results with Harness. _Avoid_: Using “workflow” to mean
both the worker and Harness orchestration logic.

**Execution scope**: The target context associated with a workflow invocation in
an authorized workspace and container.

**Runtime closure**: The compatible Node, worker bundle, bootstrap, and
dependencies required to start a PTC worker in an execution world.

**Shared-file mapping**: A relationship between paths in the DSH world and
execution world that identifies the same shared file. _Avoid_: Calling files
shared based only on matching path strings.

**Materialized file**: An authorized copy in another execution world with its
own file identity. _Avoid_: Calling a copy a shared-file mapping.

**Desktop reachability**: The ability of an authorized desktop client to access
a target file through a reference it can use. _Avoid_: Treating a DSH or guest
path as a desktop path.
