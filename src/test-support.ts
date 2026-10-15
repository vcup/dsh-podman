// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { createFilesystemProvider } from "./index.js";

// WORKSPACE_ID is a valid workspace id: slugs are UUIDs, and the pod/container
// names are derived from one.
export const WORKSPACE_ID = "2c573001-4171-4900-904b-12a5cc02737a";

export class FakeTerminalCall extends EventEmitter {
  readonly stdinChunks: Buffer[] = [];
  readonly resizes: Array<{ rows: number; cols: number }> = [];
  start: any;
  closed = false;
  ended = false;

  write(message: any): void {
    if (message.close) {
      this.closed = true;
      return;
    }
    if (message.start) {
      this.start = message.start;
      queueMicrotask(() => this.emit("data", { started: { pid: 42 } }));
      return;
    }
    if (message.resize) {
      this.resizes.push({
        rows: message.resize.rows,
        cols: message.resize.cols,
      });
      return;
    }
    if (message.stdinChunk) {
      this.stdinChunks.push(Buffer.from(message.stdinChunk));
      return;
    }
    if (message.inspectRequestId !== undefined) {
      const requestId = message.inspectRequestId;
      queueMicrotask(() =>
        this.emit("data", {
          foreground: {
            requestId,
            found: true,
            processGroupId: 7,
            inputWaiting: true,
          },
        })
      );
      return;
    }
    if (message.signal) {
      const requestId = message.signal.requestId;
      queueMicrotask(() =>
        this.emit("data", {
          signalled: { requestId, found: true, processGroupId: 7 },
        })
      );
    }
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {}

  emitStdout(data: Buffer): void {
    this.emit("data", { stdoutChunk: data });
  }

  emitExit(exitCode = 0, signaled = false): void {
    this.emit("data", { exit: { exitCode, signaled, signal: "" } });
    this.emit("end");
  }
}

export const fakeTerminalResolver = (fake: FakeTerminalCall): any => ({
  resolveForPath: async () => ({
    guest: { terminal: () => fake },
    token: "t",
  }),
});

export const stubResolver = {
  resolve: async () => ({ kind: "binding" }),
  resolveForPath: async () => ({ kind: "binding" }),
} as any;

export const EXPECTED_TOOLS = [
  "image_list",
  "image_get",
  "image_build",
  "image_rebuild",
  "image_rebuild_all",
  "image_remove",
  "container_list",
  "container_start",
  "container_recreate",
  "container_remove",
  "container_bash",
  "container_exec",
  "container_read",
  "container_write",
  "container_edit",
  "container_glob",
  "container_grep",
  "container_mount_list",
  "container_mount_add",
  "container_mount_remove",
  "container_mount_update",
  "container_publish_port",
  "container_unpublish_port",
  "container_path_set",
  "container_path_add",
  "container_path_remove",
  "volume_list",
  "volume_create",
  "volume_remove",
  "secret_list",
  "secret_create",
  "secret_remove",
  "container_secret_add",
  "container_secret_remove",
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

// The session facts the policy reads. The real `readSession` asks the harness
// services; tests put the facts straight on the session stand-in.
export interface TestSessionFacts {
  mode?: string;
  policy?: string;
  preset?: string;
}

export const testReadSession = (session: any): TestSessionFacts =>
  session?.facts ?? {};

export const sessionExec = (
  name: string,
  facts: TestSessionFacts = { mode: "read-only" },
): any => ({
  name,
  agent: { session: { facts } },
});

export const presetExec = (
  name: string,
  preset: string,
  args?: unknown,
  facts: TestSessionFacts = {},
): any => ({
  name,
  arguments: args,
  agent: {
    session: { header: { agentPreset: preset }, facts: { ...facts, preset } },
  },
});

export const MOUNT_TOOLS = [
  "container_mount_list",
  "container_mount_add",
  "container_mount_remove",
  "container_mount_update",
];

export const VOLUME_TOOLS = ["volume_list", "volume_create", "volume_remove"];

export const SECRET_TOOLS = [
  "secret_list",
  "secret_create",
  "secret_remove",
  "container_secret_add",
  "container_secret_remove",
];

export function mountRequestRecorder() {
  const requests: Array<[string, Record<string, unknown>]> = [];
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    async control(method: string, request: unknown) {
      requests.push([method, request as Record<string, unknown>]);
      return {};
    },
  };
  return { requests, resolver };
}

export const MOUNT_EXEC = { agent: { session: { header: { cwd: "/proj" } } } };

export const DAEMON_TOOLS = [
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

export const SECRET_BEARING_CONTAINER = {
  workspaceSlug: WORKSPACE_ID,
  containerName: "default",
  imageId: "img-1",
  status: "running",
  createdAt: "2026-01-01T00:00:00Z",
  podmanName: `dsh-podman-${WORKSPACE_ID}-default`,
  agentSocketPath: `/run/dsh-podman/${WORKSPACE_ID}-default/guest.sock`,
  agentToken: "super-secret-token",
  mounts: [
    {
      projectName: "team",
      mode: "MOUNT_MODE_READ_WRITE",
      kind: "MOUNT_KIND_PROJECT",
    },
  ],
  env: { PATH: "/bin", DB_PASSWORD: "hunter2" },
  secretEnv: { DB_PASS: "db-pass" },
};

export function secretBearingResolver() {
  return {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    control: async () => SECRET_BEARING_CONTAINER,
  };
}

// Stubs the guest agent's streaming ReadFile/WriteFile calls, recording the
// paths the tools ask for.
export function guestFileRecorder(content = "hello", exists = true) {
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const mkdirs: string[] = [];
  const guest = {
    readFile: (request: any) => {
      reads.push(request.path);
      return {
        async *[Symbol.asyncIterator]() {
          yield { data: Buffer.from(content) };
        },
        cancel() {},
      };
    },
    mkdir: (request: any, _metadata: unknown, callback: any) => {
      mkdirs.push(request.path);
      callback(null, {});
      return { cancel() {} };
    },
    stat: (_request: any, _metadata: unknown, callback: any) => {
      callback(
        null,
        exists
          ? {
            exists: true,
            isDir: false,
            size: Buffer.byteLength(content),
            modifiedAt: "1",
            mode: 0o644,
          }
          : { exists: false },
      );
      return { cancel() {} };
    },
    writeFile: (
      _metadata: unknown,
      _options: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      let path = "";
      let body = "";
      return {
        write(message: any) {
          if (message.start !== undefined) path = message.start.path;
          if (message.dataChunk !== undefined) {
            body += String(message.dataChunk);
          }
        },
        end() {
          writes.push({ path, content: body });
          callback(null, { bytesWritten: body.length });
        },
      };
    },
  };
  const binding = { guest, token: "t", socket: "/run/x.sock" };
  const resolver = {
    resolve: async () => binding,
    containerBinding: async () => binding,
    resolveForPath: async () => binding,
  };
  return { reads, writes, mkdirs, resolver };
}

// fakeToolContext is the minimal cordis context the container file tools need:
// the plugin's real filesystem provider over the given resolver, the fs
// observation waterfalls stubbed to "no intent" (an unconditional write), and
// an `emit` that records the `fs/observed` events the tools report.
export function fakeToolContext(resolver: any): any {
  const observed: { target: any; observation: any }[] = [];
  return {
    fs: createFilesystemProvider(resolver),
    observed,
    async waterfall(
      _name: string,
      _target: any,
      _actor: any,
      next: () => unknown,
    ) {
      return await next();
    },
    emit(event: string, target: any, observation: any) {
      if (event === "fs/observed") observed.push({ target, observation });
    },
  };
}

// Stubs the guest agent's streaming Exec call, recording the start message.
export function guestExecRecorder(defaultCwd?: string, stdout?: string) {
  const starts: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    uid?: number;
    gid?: number;
    groups?: number[];
  }[] = [];
  const guest = {
    exec: () => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
        },
        write(message: any) {
          starts.push({
            argv: message.start.argv,
            cwd: message.start.cwd,
            env: message.start.env,
            ...(message.start.uid !== undefined
              ? { uid: message.start.uid.value }
              : {}),
            ...(message.start.gid !== undefined
              ? { gid: message.start.gid.value }
              : {}),
            ...(message.start.groups !== undefined
              ? { groups: message.start.groups }
              : {}),
          });
        },
        end() {
          for (const handler of handlers.data ?? []) {
            if (stdout !== undefined) {
              handler({ stdoutChunk: Buffer.from(stdout) });
            }
            handler({ exit: { exitCode: 0, signaled: false } });
          }
        },
      };
    },
  };
  const binding = {
    guest,
    token: "t",
    socket: "/run/x.sock",
    ...(defaultCwd === undefined ? {} : { defaultCwd }),
  };
  const resolver = {
    resolve: async () => binding,
    containerBinding: async () => binding,
  };
  return { starts, resolver };
}

// A resolver for the container_path_* tools: the guest stubs GetPaths/SetPaths
// (the agent's live list) and control records the setContainerPaths call.
export function pathRequestRecorder(
  options: { paths?: string[]; defaultPath?: string } = {},
) {
  const controlCalls: Array<[string, Record<string, unknown>]> = [];
  const setCalls: string[][] = [];
  const defaultPath = options.defaultPath ?? "/usr/bin";
  let paths = options.paths ?? [];
  const guest = {
    getPaths: (
      _request: unknown,
      _metadata: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => callback(null, { paths, defaultPath }),
    setPaths: (
      request: { paths: string[] },
      _metadata: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      setCalls.push(request.paths);
      paths = request.paths;
      callback(null, { paths, defaultPath });
    },
  };
  const binding = { guest, token: "t", socket: "/run/x.sock" };
  const resolver = {
    registry: { resolveByPath: async () => ({ id: WORKSPACE_ID }) },
    getConfig: () => ({ projectsRoot: "/projects" }),
    resolve: async () => binding,
    containerBinding: async () => binding,
    async control(method: string, request: unknown) {
      controlCalls.push([method, request as Record<string, unknown>]);
      return { paths: (request as { paths?: string[] }).paths ?? [] };
    },
  };
  return { controlCalls, setCalls, resolver };
}

// A fake guest whose readFile honors offset/length, so the provider's byte
// windowing and text decoding can be exercised without a container.
export function fakeGuest(source: Buffer) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    guest: {
      readFile: (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            const offset = Number(request.offset ?? 0);
            const length = Number(request.length ?? 0);
            const slice = length > 0
              ? source.subarray(offset, offset + length)
              : source.subarray(offset);
            yield { data: slice };
          },
        };
      },
    },
  };
}

export function providerFor(guest: unknown) {
  return createFilesystemProvider({
    resolveForPath: async () => ({ guest, token: "t" }),
  } as any);
}

// A fake guest for the text/byte provider methods: a stat result, a one-chunk
// readFile, and a no-op writeFile.
export function editGuest(
  stat: Record<string, unknown>,
  content = Buffer.alloc(0),
) {
  const writes: Buffer[] = [];
  return {
    writes,
    guest: {
      stat: (_request: unknown, _metadata: unknown, callback: Function) =>
        callback(null, {
          exists: true,
          isDir: false,
          isSymlink: false,
          size: String(content.length),
          mode: "-rw-r--r--",
          modifiedAt: "t",
          ...stat,
        }),
      readFile: () => ({
        async *[Symbol.asyncIterator]() {
          yield { data: content };
        },
      }),
      writeFile: (
        _metadata: unknown,
        _options: unknown,
        callback: Function,
      ) => {
        const call = {
          write(message: { dataChunk?: Uint8Array }) {
            if (message?.dataChunk) writes.push(Buffer.from(message.dataChunk));
          },
          end() {},
        };
        callback(null, { bytesWritten: 0 });
        return call;
      },
    },
    token: "t",
  };
}

export function editProvider(binding: unknown) {
  return createFilesystemProvider({
    resolveForPath: async () => binding,
  } as any);
}

// The guest Exec bidi stream the subprocess provider drives, with the
// backpressure and failure controls its tests need. `write()` records the start
// message; `end()` replays the process id, the configured stdout and (unless
// disabled) the exit message, mirroring a guest that answered immediately.
export class FakeExecStream extends EventEmitter {
  paused = 0;
  resumed = 0;
  cancelled = false;
  constructor(
    private readonly starts: Array<Record<string, any>>,
    private readonly options: {
      emitExit?: boolean;
      exit?: Record<string, unknown>;
      stdout?: string;
    },
  ) {
    super();
  }
  write(message: any, callback?: (error?: Error) => void): boolean {
    this.starts.push(message);
    callback?.();
    return true;
  }
  end(): void {
    this.emitData({ processId: "7" });
    if (this.options.stdout !== undefined) {
      this.emitData({ stdoutChunk: Buffer.from(this.options.stdout) });
    }
    if (this.options.emitExit !== false) {
      this.emitData({
        exit: { exitCode: 0, signaled: false, ...this.options.exit },
      });
    }
  }
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.resumed++;
  }
  cancel(): void {
    this.cancelled = true;
  }
  emitData(message: Record<string, unknown>): void {
    this.emit("data", message);
  }
}

// A fake guest for the subprocess provider: exec emits a process id (and
// optionally an exit), and the unary signal/delete RPCs are recorded.
export function spawnGuest(
  options: {
    emitExit?: boolean;
    exit?: Record<string, unknown>;
    stdout?: string;
  } = {},
) {
  const signals: Array<{ processId: string; signal: string }> = [];
  const starts: Array<Record<string, any>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const streams: FakeExecStream[] = [];
  const guest = {
    exec: () => {
      const stream = new FakeExecStream(starts, options);
      streams.push(stream);
      return stream;
    },
    signal: (
      request: { processId: string; signal: string },
      _metadata: unknown,
      callback: Function,
    ) => {
      signals.push(request);
      callback(null, {});
    },
    delete: (
      request: Record<string, unknown>,
      _metadata: unknown,
      callback: Function,
    ) => {
      deletes.push(request);
      callback(null, {});
    },
  };
  return {
    signals,
    starts,
    deletes,
    streams,
    guest,
    resolver: { resolve: async () => ({ guest, token: "t" }) },
  };
}

export const spawnSpec = (overrides: Record<string, unknown> = {}) => ({
  argv: ["sleep", "1"],
  cwd: "/projects/team",
  stdio: {
    stdin: "ignore",
    stdout: { maxBytes: 10 },
    stderr: { maxBytes: 10 },
  },
  graceMs: 50,
  ...overrides,
});
