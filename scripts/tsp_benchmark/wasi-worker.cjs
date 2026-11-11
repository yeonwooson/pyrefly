"use strict";

const fs = require("node:fs");
const { WASI } = require("node:wasi");
const { parentPort, workerData } = require("node:worker_threads");

const { addDirectoryReading } = require("./wasi-directories.cjs");

const state = new Int32Array(workerData.input, 0, 4);
const bytes = new Uint8Array(workerData.input, 16);
const preopens = {
  "/workspace": workerData.workspace,
  "/typeshed": workerData.typeshed,
};
const wasi = new WASI({
  version: "preview1",
  args: ["pyrefly-wasi-query", "--shared-documents"],
  env: {},
  preopens,
  returnOnExit: true,
});
const imports = wasi.getImportObject();
const originalRead = imports.wasi_snapshot_preview1.fd_read;
const originalWrite = imports.wasi_snapshot_preview1.fd_write;
let memory;
const directoryObservations =
  process.platform === "win32"
    ? addDirectoryReading(
        imports.wasi_snapshot_preview1,
        () => memory,
        preopens
      )
    : () => ({ adaptedReads: 0 });

imports.wasi_snapshot_preview1.fd_read = (fd, iovs, count, nread) => {
  if (fd !== 0) return originalRead(fd, iovs, count, nread);
  for (;;) {
    const status = Atomics.load(state, 0);
    if (status === 2) {
      new DataView(memory.buffer).setUint32(nread, 0, true);
      return 0;
    }
    if (status === 1) break;
    Atomics.wait(state, 0, 0);
  }
  const view = new DataView(memory.buffer);
  const available = Atomics.load(state, 1) - Atomics.load(state, 2);
  let read = 0;
  for (let index = 0; index < count && read < available; index++) {
    const pointer = view.getUint32(iovs + index * 8, true);
    const length = Math.min(
      view.getUint32(iovs + index * 8 + 4, true),
      available - read
    );
    const offset = Atomics.load(state, 2) + read;
    new Uint8Array(memory.buffer, pointer, length).set(
      bytes.subarray(offset, offset + length)
    );
    read += length;
  }
  Atomics.add(state, 2, read);
  view.setUint32(nread, read, true);
  if (Atomics.load(state, 2) === Atomics.load(state, 1)) {
    Atomics.store(state, 0, 0);
    Atomics.notify(state, 0);
  }
  return 0;
};

imports.wasi_snapshot_preview1.fd_write = (fd, iovs, count, nwritten) => {
  if (fd !== 1 && fd !== 2) return originalWrite(fd, iovs, count, nwritten);
  const view = new DataView(memory.buffer);
  let length = 0;
  for (let index = 0; index < count; index++) {
    const pointer = view.getUint32(iovs + index * 8, true);
    const size = view.getUint32(iovs + index * 8 + 4, true);
    const chunk = Uint8Array.from(new Uint8Array(memory.buffer, pointer, size));
    parentPort.postMessage({ kind: fd === 1 ? "stdout" : "stderr", chunk }, [
      chunk.buffer,
    ]);
    length += size;
  }
  view.setUint32(nwritten, length, true);
  return 0;
};

try {
  const moduleObject = new WebAssembly.Module(fs.readFileSync(workerData.wasm));
  const instance = new WebAssembly.Instance(moduleObject, imports);
  memory = instance.exports.memory;
  parentPort.postMessage({ kind: "ready" });
  const code = wasi.start(instance);
  parentPort.postMessage({
    kind: "exit",
    code,
    directories: directoryObservations(),
  });
  if (code !== 0) process.exitCode = code;
} catch (error) {
  parentPort.postMessage({
    kind: "failure",
    message: error.stack ?? String(error),
  });
  process.exitCode = 1;
}
