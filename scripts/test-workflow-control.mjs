// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// A real Go guest, gRPC transport, provider, and Node child; no Podman socket
// or Harness services are replaced. Build first, then run with node --test.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSubprocessProvider } from "../dist/subprocess.js";
import { closeClients, guestClient } from "../dist/grpc/runtime-client.js";

const root = resolve(import.meta.dirname, "..");
const binary = resolve(
  process.env.DSH_PODMAN_TEST_GUEST_BIN ??
    join(root, "bin/linux-amd64/dsh-podman-guest-agent"),
);
const helper = import.meta.resolve("@deepseek-ai/dsh-subprocess/control");
let temporary, daemon, provider;
const handles = new Set();
let daemonLogs = "";

before(async () => {
  await access(binary);
  temporary = await mkdtemp(join(tmpdir(), "dsh-exec-control-"));
  const token = randomBytes(24).toString("hex");
  daemon = spawn(binary, [], {
    env: {
      ...process.env,
      DSH_PODMAN_GUEST_SOCKET: join(temporary, "guest.sock"),
      DSH_PODMAN_GUEST_TOKEN: token,
      DSH_PODMAN_PROJECTS_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("guest readiness timeout")),
      10000,
    );
    daemon.once("error", reject);
    daemon.once(
      "exit",
      (code) => reject(new Error(`guest exited ${code}: ${daemonLogs}`)),
    );
    daemon.stderr.on("data", (data) => {
      daemonLogs += data;
    });
    daemon.stdout.on("data", (data) => {
      daemonLogs += data;
      if (daemonLogs.includes("guest agent listening")) {
        clearTimeout(deadline);
        resolveReady();
      }
    });
  });
  provider = createSubprocessProvider({
    resolve: async () => ({
      guest: guestClient(join(temporary, "guest.sock")),
      token,
    }),
  });
});

after(async () => {
  let deadline;
  try {
    for (const handle of handles) handle.terminate();
    await Promise.race([
      Promise.allSettled([...handles].map((handle) => handle.done)),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("subprocess cleanup timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    provider?.dispose();
    closeClients();
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGKILL");
      await exited;
    }
    // Only remove the private directory created above, never a caller path.
    if (temporary !== undefined) {
      assert.equal(resolve(temporary), temporary);
      assert.ok(temporary.startsWith(join(tmpdir(), "dsh-exec-control-")));
      await rm(temporary, { recursive: true });
    }
  }
});

function run(source, stdin = "ignore", extra = {}) {
  const handle = provider.spawn({
    argv: [process.execPath, "--input-type=module", "--eval", source],
    cwd: root,
    stdio: { stdin, stdout: "pipe", stderr: "pipe", control: "pipe" },
    graceMs: 200,
    ...extra,
  });
  handles.add(handle);
  void handle.done.finally(() => handles.delete(handle)).catch(() => {});
  return handle;
}
function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks);
}
function ready(stream, size = 5) {
  return new Promise((resolveReady, reject) => {
    let data = Buffer.alloc(0);
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < size) return;
      cleanup();
      resolveReady(data);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => onError(new Error("control ended before readiness"));
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}
const open = `import { openInheritedControlChannel } from ${
  JSON.stringify(helper)
}; const c = openInheritedControlChannel();`;

test(
  "real Node control channel carries binary data, half-close, and separate diagnostics",
  { timeout: 15000 },
  async () => {
    const h = run(`${open}
    if (process.env.DSH_SUBPROCESS_CONTROL !== undefined) throw Error('marker leaked');
    process.stdout.write('stdout'); process.stderr.write('stderr');
    const chunks=[]; c.on('data', b=>chunks.push(b));
    c.on('end', ()=>c.end(Buffer.concat(chunks))); c.write('ready');`);
    const greeting = ready(h.control);
    const out = collect(h.stdout),
      err = collect(h.stderr),
      control = collect(h.control);
    assert.equal((await greeting).toString(), "ready");
    // Exceeds gRPC's default 4 MiB per-message limit: the provider must
    // preserve a byte stream rather than treating one write as one RPC frame.
    const data = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    h.control.end(data);
    assert.equal((await h.done).exitCode, 0);
    assert.equal(out().toString(), "stdout");
    assert.equal(err().toString(), "stderr");
    assert.deepEqual(control(), Buffer.concat([Buffer.from("ready"), data]));
  },
);

test("stdin EOF and control EOF remain independent over real gRPC", {
  timeout: 10000,
}, async () => {
  const h = run(
    `${open}
    const input=[]; process.stdin.on('data', b=>input.push(b));
    process.stdin.on('end', ()=>c.write('stdin:'+Buffer.concat(input).toString()));
    const command=[]; c.on('data', b=>command.push(b)); c.on('end', ()=>c.end('control:'+Buffer.concat(command).toString()));`,
    "pipe",
  );
  const first = ready(h.control, Buffer.byteLength("stdin:first"));
  const control = collect(h.control);
  h.stdout.resume();
  h.stderr.resume();
  h.stdin.end("first"); // queued before asynchronous workspace resolution
  assert.equal((await first).toString(), "stdin:first");
  h.control.end("second");
  assert.equal((await h.done).exitCode, 0);
  assert.equal(control().toString(), "stdin:firstcontrol:second");
});

test("termination settles a live control process and closes its streams", {
  timeout: 10000,
}, async () => {
  const h = run(`${open} c.write('ready'); setInterval(()=>{}, 1000);`);
  h.stdout.resume();
  h.stderr.resume();
  assert.equal((await ready(h.control)).toString(), "ready");
  h.control.resume();
  h.terminate();
  const result = await h.done;
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.signal, "the guest must report signal termination");
  assert.equal(await h.waitForExit(), true);
});

test("a missing executable rejects without leaving control writes pending", {
  timeout: 10000,
}, async () => {
  const h = run("", "ignore", { argv: [join(temporary, "missing")] });
  h.stdout.resume();
  h.stderr.resume();
  let written;
  h.control.write("pending", (error) => {
    written = error ?? null;
  });
  await assert.rejects(h.done, /no such file/);
  assert.equal(h.control.destroyed, true);
  assert.notEqual(written, undefined, "the write callback must settle");
});

// Point this at the co-shipped dsh-ptc-runtime-node/process bundle to exercise
// the real workflow worker, not a reconstruction of its bootstrap logic.
const bootstrap = process.env.DSH_PODMAN_TEST_PTC_BOOTSTRAP;
if (bootstrap) {
  for (const binding of [false, true]) {
    test(
      `real PTC bootstrap completes ready/boot/${
        binding ? "call/reply/" : ""
      }done`,
      { timeout: 15000 },
      async () => {
        await access(bootstrap);
        const h = run("", "ignore", {
          argv: [process.execPath, resolve(bootstrap), String(8 * 1024 * 1024)],
        });
        const diagnostics = collect(h.stderr);
        h.stdout.resume();
        let pending = Buffer.alloc(0);
        const messages = [];
        let terminal;
        const send = (message) => {
          const body = Buffer.from(JSON.stringify(message));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          h.control.write(Buffer.concat([header, body]));
        };
        h.control.on("data", (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 4) {
            const length = pending.readUInt32BE(0);
            assert.ok(length > 0 && length <= 8 * 1024 * 1024);
            if (pending.length < length + 4) break;
            const message = JSON.parse(
              pending.subarray(4, length + 4).toString(),
            );
            pending = pending.subarray(length + 4);
            messages.push(message.type);
            if (message.type === "ready") {
              send({
                type: "boot",
                data: {
                  code: binding
                    ? "return await probe.echo({value:42});"
                    : 'return {transportCheck:"ok",modelCalls:0,fileWrites:0};',
                  namespaces: binding
                    ? [{ global: "probe", names: ["echo"] }]
                    : [],
                  maxOutputBytes: 4096,
                },
              });
            } else if (message.type === "call") {
              assert.equal(message.global, "probe");
              assert.equal(message.name, "echo");
              send({
                type: "reply",
                id: message.id,
                ok: true,
                value: message.args,
              });
            } else if (message.type === "done") {
              terminal = message;
              h.control.destroy(); // The real PTC host owns channel shutdown.
            }
          }
        });
        assert.equal((await h.done).exitCode, 0, diagnostics().toString());
        assert.deepEqual(
          messages,
          binding ? ["ready", "call", "done"] : ["ready", "done"],
        );
        assert.equal(terminal?.error, undefined);
        assert.deepEqual(
          terminal?.value,
          binding ? [{ kind: "object", keys: ["value"] }, 42] : [
            {
              kind: "object",
              keys: ["transportCheck", "modelCalls", "fileWrites"],
            },
            "ok",
            0,
            0,
          ],
        );
      },
    );
  }
}
