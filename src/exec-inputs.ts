// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { Duplex, Writable } from "node:stream";

type Callback = (error?: Error | null) => void;

// Writable handles exist before workspace resolution. Node's Writable queues
// early writes and bounds the producer through its normal backpressure signal.
// Control is a true duplex: caller writes must never echo to its readable side.
export class ExecInputs {
  readonly stdin: Writable | undefined;
  readonly control: Duplex | undefined;
  private stream: any;
  private pending: Array<{ message: object; callback: Callback }> = [];
  private closed = false;
  private requestEnded = false;
  private stdinEnded: boolean;
  private controlEnded: boolean;
  private resumeControl: (() => void) | undefined;

  constructor(stdin: boolean, control: boolean) {
    this.stdinEnded = !stdin;
    this.controlEnded = !control;
    if (stdin) {
      this.stdin = new Writable({
        write: (data, _encoding, callback) =>
          this.sendData("stdinChunk", Buffer.from(data), callback),
        final: (callback) => this.endInput("stdin", callback),
        destroy: (error, callback) =>
          this.endInput("stdin", () => callback(error)),
      });
      // Provider failures also reject handle.done. A caller need not subscribe
      // to the optional writable's errors just to await that outcome.
      this.stdin.on("error", () => {});
    }
    if (control) {
      this.control = new Duplex({
        allowHalfOpen: true,
        read: () => {
          const resume = this.resumeControl;
          this.resumeControl = undefined;
          resume?.();
        },
        write: (data, _encoding, callback) =>
          this.sendData("controlChunk", Buffer.from(data), callback),
        final: (callback) => this.endInput("control", callback),
        destroy: (error, callback) => {
          this.resumeControl?.();
          this.resumeControl = undefined;
          this.endInput("control", () => callback(error));
        },
      });
      this.control.on("error", () => {});
    }
  }

  private binding = false;

  bind(stream: any): void {
    this.stream = stream;
    this.binding = true;
    for (const item of this.pending.splice(0)) {
      this.send(item.message, item.callback);
    }
    this.binding = false;
    this.endIfFinished();
  }

  private sendData(
    key: "stdinChunk" | "controlChunk",
    data: Buffer,
    callback: Callback,
  ): void {
    // A Writable is a byte stream, not a gRPC message. Bound each frame well
    // below the server's message limit, and wait for its write receipt before
    // producing the next one. Write/EOF state is per input; transport
    // backpressure is shared by the RPC.
    let offset = 0;
    const next = (error?: Error | null): void => {
      // Destroy can send EOF while a frame's transport receipt is pending.
      const ended = key === "stdinChunk" ? this.stdinEnded : this.controlEnded;
      if (error || this.closed || ended || offset === data.length) {
        callback(error);
        return;
      }
      const chunk = data.subarray(offset, offset + 32 * 1024);
      offset += chunk.length;
      let synchronous = true;
      this.send({ [key]: chunk }, (error) => {
        // Test transports may acknowledge synchronously. Do not recurse once
        // per frame and exhaust the stack for a large caller write.
        if (synchronous) queueMicrotask(() => next(error));
        else next(error);
      });
      synchronous = false;
    };
    next();
  }

  private send(message: object, callback: Callback): void {
    if (this.closed) {
      callback();
    } else if (this.stream === undefined) {
      this.pending.push({ message, callback });
    } else {
      try {
        this.stream.write(message, callback);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private endInput(kind: "stdin" | "control", callback: Callback): void {
    const ended = kind === "stdin" ? this.stdinEnded : this.controlEnded;
    if (ended || this.closed) {
      callback();
      return;
    }
    if (kind === "stdin") this.stdinEnded = true;
    else this.controlEnded = true;
    // Old guests understand request-stream EOF for stdin-only processes.
    if (this.control === undefined) {
      this.endIfFinished();
      callback();
    } else {
      this.send(
        kind === "stdin" ? { stdinEof: true } : { controlEof: true },
        (error) => {
          this.endIfFinished();
          callback(error);
        },
      );
    }
  }

  private endIfFinished(): void {
    if (
      !this.closed && !this.binding && !this.requestEnded && this.stream &&
      this.stdinEnded &&
      this.controlEnded
    ) {
      this.requestEnded = true;
      this.stream.end();
    }
  }

  receive(data: Buffer, pause: () => () => void): void {
    if (this.control === undefined || this.control.destroyed) return;
    if (!this.control.push(data)) this.resumeControl ??= pause();
  }

  receiveEOF(): void {
    this.control?.push(null);
  }

  finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.resumeControl?.();
    this.resumeControl = undefined;
    for (const item of this.pending.splice(0)) item.callback(error);
    this.stdin?.destroy(error);
    if (error) this.control?.destroy(error);
    else {
      this.control?.push(null);
      this.control?.end();
    }
    if (this.stream && !this.requestEnded && !this.stream.writableEnded) {
      this.requestEnded = true;
      this.stream.end();
    }
  }
}
