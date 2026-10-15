// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createSubprocessProvider } from "./subprocess.js";
import { spawnGuest, spawnSpec } from "./test-support.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("spawn exposes the requested workflow control channel immediately", async () => {
  const fake = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(spawnSpec({
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe", control: "pipe" },
  }));
  try {
    assert.ok(
      handle.control instanceof Duplex,
      "workflow needs a separate duplex control channel",
    );
    assert.notEqual(
      handle.control,
      handle.stdout,
      "control traffic must not alias stdout",
    );
    await tick();
    assert.equal(fake.starts[0].start.controlPipe, true);
    fake.streams[0].emitData({ processId: "7", controlReady: true });
    assert.equal(
      handle.pid,
      7,
      "the returned handle must see the asynchronous process id",
    );
    const read: Buffer[] = [];
    handle.control.on("data", (chunk: Buffer) => read.push(chunk));
    handle.control.write("command");
    fake.streams[0].emitData({ controlChunk: Buffer.from("response") });
    await tick();
    assert.equal(Buffer.concat(read).toString(), "response");
    assert.equal(fake.starts.at(-1)!.controlChunk.toString(), "command");
  } finally {
    await tick();
    fake.streams[0].emitData({ exit: { exitCode: 0, signaled: false } });
    await handle.done;
    provider.dispose();
  }
});

test("spawn exposes writable stdin before the guest binding resolves", async () => {
  const fake = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({ stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } }),
  );
  try {
    assert.ok(
      handle.stdin,
      "returning a snapshot must not lose the later-assigned stdin pipe",
    );
    handle.stdin.end("early input");
    await tick();
    assert.equal(fake.starts[1].stdinChunk.toString(), "early input");
  } finally {
    await tick();
    fake.streams[0].emitData({ exit: { exitCode: 0, signaled: false } });
    await handle.done;
    provider.dispose();
  }
});

test("a guest without control support fails explicitly and is cancelled", async () => {
  const fake = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({
      stdio: {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        control: "pipe",
      },
    }),
  );
  const failed = assert.rejects(handle.done, /rebuild the guest agent/);
  await tick();
  fake.streams[0].emitData({ processId: "7" });
  await failed;
  assert.equal(handle.control.destroyed, true);
  assert.equal(fake.streams[0].cancelled, true);
  assert.ok(fake.signals.some((signal) => signal.signal === "SIGTERM"));
  provider.dispose();
});

test("workspace resolution failure closes the immediately returned handles", async () => {
  const provider = createSubprocessProvider({
    resolve: async () => {
      throw new Error("unreachable workspace");
    },
  } as any);
  const handle = provider.spawn(
    spawnSpec({
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe", control: "pipe" },
    }),
  );
  handle.control.write("early");
  handle.stdin.write("early");
  await assert.rejects(handle.done, /unreachable workspace/);
  assert.equal(handle.control.destroyed, true);
  assert.equal(handle.stdin.destroyed, true);
  provider.dispose();
});
