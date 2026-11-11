"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

const [wasm, workspace, typeshed] = process.argv.slice(2);
if (!wasm || !workspace || !typeshed)
  throw new Error("Expected wasm, workspace and typeshed arguments");
const input = new SharedArrayBuffer(16 + 1024 * 1024 + 8192);
const state = new Int32Array(input, 0, 4);
const bytes = new Uint8Array(input, 16);
const worker = new Worker(path.join(__dirname, "wasi-worker.cjs"), {
  workerData: { input, wasm, workspace, typeshed },
});
const workerThreadId = worker.threadId;
let ready = false;
let closed = false;
let outputBytes = 0;
let expectedExit = false;
const startedAt = performance.now();

worker.on("message", (message) => {
  if (message.kind === "stdout" || message.kind === "stderr") {
    outputBytes += message.chunk.length;
    if (outputBytes > 64 * 1024 * 1024)
      throw new Error("Guest output budget exceeded");
    (message.kind === "stdout" ? process.stdout : process.stderr).write(
      Buffer.from(message.chunk)
    );
  } else if (message.kind === "ready") {
    ready = true;
    process.send?.({
      kind: "ready",
      workerThreadId,
      bootstrapMs: performance.now() - startedAt,
    });
  } else if (message.kind === "failure") {
    process.stderr.write(message.message + "\n");
    process.exitCode = 1;
  } else if (message.kind === "exit") {
    expectedExit = true;
    process.exitCode = message.code;
    process.send?.({
      kind: "guest-exit",
      code: message.code,
      directories: message.directories,
    });
  }
});
worker.on("error", (error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
worker.on("exit", (code) => {
  closed = true;
  Atomics.store(state, 0, 2);
  Atomics.notify(state, 0);
  process.stdin.destroy();
  process.send?.({
    kind: "retired",
    code,
    expectedExit,
    workerThreadId,
  });
  if (process.connected) process.disconnect();
  if (code !== 0 || !ready || !expectedExit) process.exitCode = 1;
});

(async () => {
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      while (Atomics.load(state, 0) === 1) {
        await Atomics.waitAsync(state, 0, 1).value;
      }
      if (closed) return;
      const length = Math.min(bytes.length, chunk.length - offset);
      bytes.set(chunk.subarray(offset, offset + length));
      Atomics.store(state, 1, length);
      Atomics.store(state, 2, 0);
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      offset += length;
    }
  }
  while (Atomics.load(state, 0) === 1)
    await Atomics.waitAsync(state, 0, 1).value;
  Atomics.store(state, 0, 2);
  Atomics.notify(state, 0);
})().catch((error) => {
  if (!closed) {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
    Atomics.store(state, 0, 2);
    Atomics.notify(state, 0);
  }
});
