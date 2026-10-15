// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { ExecInputs } from "./exec-inputs.js";

function transport() {
  const writes: any[] = [];
  let ends = 0;
  return {
    writes,
    get ends() {
      return ends;
    },
    write(message: unknown, callback: () => void) {
      writes.push(message);
      callback();
    },
    end() {
      ends++;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("control queues early binary writes without echoing them to the reader", async () => {
  const input = new ExecInputs(true, true);
  const stream = transport();
  const bytes = Buffer.from([0, 255, 128, 10]);
  const incoming: Buffer[] = [];
  input.control!.on("data", (chunk) => incoming.push(chunk));
  input.control!.write(bytes);
  input.stdin!.end("stdin");
  assert.equal(stream.writes.length, 0);
  input.bind(stream);
  await tick();
  assert.deepEqual(stream.writes, [{ controlChunk: bytes }, {
    stdinChunk: Buffer.from("stdin"),
  }, { stdinEof: true }]);
  assert.equal(stream.ends, 0, "stdin EOF must leave control writable");
  assert.deepEqual(
    incoming,
    [],
    "a PassThrough would echo outgoing control bytes here",
  );
  input.receive(bytes, () => () => {});
  input.control!.end();
  await tick();
  assert.deepEqual(incoming, [bytes]);
  assert.equal(stream.ends, 1);
  input.receiveEOF();
  input.finish();
  assert.equal(stream.ends, 1, "the request stream ends only once");
});

test("control EOF does not close stdin and peer EOF preserves the write half", async () => {
  const input = new ExecInputs(true, true);
  const stream = transport();
  input.bind(stream);
  input.control!.resume();
  const eof = once(input.control!, "end");
  input.receiveEOF();
  await eof;
  input.control!.end("last control bytes");
  await tick();
  assert.equal(stream.ends, 0);
  input.stdin!.end("last stdin bytes");
  await tick();
  assert.equal(stream.ends, 1);
  assert.deepEqual(stream.writes.map((item) => Object.keys(item)[0]), [
    "controlChunk",
    "controlEof",
    "stdinChunk",
    "stdinEof",
  ]);
  input.finish();
});

test("control applies backpressure until its readable side is drained", async () => {
  const input = new ExecInputs(false, true);
  let paused = 0;
  let resumed = 0;
  input.receive(Buffer.alloc(256 * 1024, 1), () => {
    paused++;
    return () => {
      resumed++;
    };
  });
  assert.equal(paused, 1);
  input.control!.resume();
  await tick();
  assert.equal(resumed, 1);
  input.finish();
});

test("failed resolution settles queued writes and closes both handles", async () => {
  const input = new ExecInputs(true, true);
  const errors: Array<Error | null | undefined> = [];
  input.stdin!.write("pending stdin", (error) => errors.push(error));
  input.control!.write("pending control", (error) => errors.push(error));
  input.finish(new Error("binding unavailable"));
  await tick();
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error?.message === "binding unavailable"));
  assert.equal(input.stdin!.destroyed, true);
  assert.equal(input.control!.destroyed, true);
});

test("stdin-only keeps legacy request-stream EOF and sends all early writes", async () => {
  const input = new ExecInputs(true, false);
  const stream = transport();
  input.stdin!.write("one");
  input.stdin!.end("two");
  input.bind(stream);
  await tick();
  assert.deepEqual(stream.writes.map((item) => item.stdinChunk.toString()), [
    "one",
    "two",
  ]);
  assert.equal(stream.ends, 1);
  input.finish();
});

test("both early EOFs are delivered before the request stream ends", async () => {
  const input = new ExecInputs(true, true);
  const messages: string[] = [];
  input.stdin!.end();
  input.control!.end();
  input.bind({
    write: (message: object, callback: () => void) => {
      assert.ok(!messages.includes("end"), "write after request EOF");
      messages.push(Object.keys(message)[0]);
      callback();
    },
    end: () => messages.push("end"),
  });
  await tick();
  assert.deepEqual(messages, ["stdinEof", "controlEof", "end"]);
  input.finish();
});

test("input fragmentation waits for each transport receipt", async () => {
  const input = new ExecInputs(false, true);
  const data = Buffer.alloc(5 * 1024 * 1024, 17);
  const writes: Buffer[] = [];
  const receipts: Array<() => void> = [];
  input.bind({
    write: (message: any, callback: () => void) => {
      writes.push(message.controlChunk);
      receipts.push(callback);
    },
    end: () => {},
  });
  const sent = new Promise<void>((resolve, reject) =>
    input.control!.write(data, (error) => error ? reject(error) : resolve())
  );
  assert.equal(
    writes.length,
    1,
    "do not enqueue the entire large write into gRPC",
  );
  while (receipts.length > 0) receipts.shift()!();
  await sent;
  assert.ok(writes.every((chunk) => chunk.length <= 32 * 1024));
  assert.deepEqual(Buffer.concat(writes), data);
  input.finish();
});

test("destroying stdin closes only its own write half", async () => {
  for (const control of [false, true]) {
    const input = new ExecInputs(true, control);
    const stream = transport();
    input.bind(stream);
    const closed = once(input.stdin!, "close");
    input.stdin!.destroy();
    await closed;
    assert.deepEqual(stream.writes, control ? [{ stdinEof: true }] : []);
    assert.equal(stream.ends, control ? 0 : 1);
    if (control) {
      input.control!.end();
      await tick();
      assert.equal(stream.ends, 1);
    }
    input.finish();
  }
});

test("destroying control stops a fragmented write before its EOF", async () => {
  const input = new ExecInputs(false, true);
  const messages: string[] = [];
  const receipts: Array<() => void> = [];
  input.bind({
    write: (message: object, callback: () => void) => {
      messages.push(Object.keys(message)[0]);
      receipts.push(callback);
    },
    end: () => messages.push("end"),
  });
  let callbacks = 0;
  input.control!.write(Buffer.alloc(96 * 1024), () => callbacks++);
  const closed = once(input.control!, "close");
  input.control!.destroy();
  while (receipts.length > 0) receipts.shift()!();
  await closed;
  await tick();
  assert.deepEqual(messages, ["controlChunk", "controlEof", "end"]);
  assert.equal(callbacks, 1, "the interrupted write must settle exactly once");
  input.finish();
});

test("destroying stdin stops pending fragments without closing control", async () => {
  const input = new ExecInputs(true, true);
  const messages: string[] = [];
  const receipts: Array<() => void> = [];
  input.bind({
    write: (message: object, callback: () => void) => {
      messages.push(Object.keys(message)[0]);
      receipts.push(callback);
    },
    end: () => messages.push("end"),
  });
  let callbacks = 0;
  input.stdin!.write(Buffer.alloc(96 * 1024), () => callbacks++);
  const closed = once(input.stdin!, "close");
  input.stdin!.destroy();
  while (receipts.length > 0) receipts.shift()!();
  await closed;
  await tick();
  assert.deepEqual(messages, ["stdinChunk", "stdinEof"]);
  assert.equal(callbacks, 1);
  input.control!.end("still writable");
  while (receipts.length > 0) receipts.shift()!();
  await tick();
  assert.deepEqual(messages, [
    "stdinChunk",
    "stdinEof",
    "controlChunk",
    "controlEof",
    "end",
  ]);
  input.finish();
});

test("end(data) drains every fragment before its input EOF", async () => {
  for (const control of [false, true]) {
    const input = new ExecInputs(!control, control);
    const messages: string[] = [];
    const chunks: Buffer[] = [];
    const receipts: Array<() => void> = [];
    input.bind({
      write: (message: any, callback: () => void) => {
        messages.push(Object.keys(message)[0]);
        const chunk = message.stdinChunk ?? message.controlChunk;
        if (chunk !== undefined) chunks.push(chunk);
        receipts.push(callback);
      },
      end: () => messages.push("end"),
    });
    const data = Buffer.alloc(96 * 1024, 17);
    const target = control ? input.control! : input.stdin!;
    let callbacks = 0;
    target.end(data, () => callbacks++);
    assert.equal(messages.length, 1, "wait for the first transport receipt");
    while (receipts.length > 0) receipts.shift()!();
    await tick();
    assert.deepEqual(Buffer.concat(chunks), data);
    assert.deepEqual(
      messages,
      control
        ? ["controlChunk", "controlChunk", "controlChunk", "controlEof", "end"]
        : ["stdinChunk", "stdinChunk", "stdinChunk", "end"],
    );
    assert.equal(callbacks, 1);
    input.finish();
  }
});
