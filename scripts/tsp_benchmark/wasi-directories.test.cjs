"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { addDirectoryReading } = require("./wasi-directories.cjs");

function harness(t, originalResult = 52) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-wasi-directory-"));
  fs.writeFileSync(path.join(root, "first.py"), "");
  fs.writeFileSync(path.join(root, "\u03bb.py"), "");
  fs.mkdirSync(path.join(root, "nested"));
  t.after(() => {
    fs.unlinkSync(path.join(root, "first.py"));
    fs.unlinkSync(path.join(root, "\u03bb.py"));
    fs.rmdirSync(path.join(root, "nested"));
    fs.rmdirSync(root);
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const imports = {
    path_open: (...args) => {
      view.setUint32(args[8], 10, true);
      return 0;
    },
    fd_close: () => 0,
    fd_readdir: () => originalResult,
  };
  const observations = addDirectoryReading(imports, () => memory, {
    "/workspace": root,
  });
  function read(fd, length = 4096, cookie = 0n) {
    const errno = imports.fd_readdir(fd, 1024, length, cookie, 512);
    const used = view.getUint32(512, true);
    return {
      errno,
      bytes: Buffer.from(new Uint8Array(memory.buffer, 1024, used)),
    };
  }
  return { imports, memory, view, read, observations };
}

function records(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.readUInt32LE(offset + 16);
    result.push({
      next: bytes.readBigUInt64LE(offset),
      name: bytes.toString("utf8", offset + 24, offset + 24 + length),
      type: bytes[offset + 20],
    });
    offset += 24 + length;
  }
  return result;
}

test("directory adapter encodes real UTF-8 entries and resume cookies", (t) => {
  const h = harness(t);
  const full = h.read(3);
  assert.equal(full.errno, 0);
  const entries = records(full.bytes);
  assert.deepEqual(
    new Set(entries.map((entry) => entry.name)),
    new Set(["first.py", "\u03bb.py", "nested"])
  );
  assert.equal(entries.find((entry) => entry.name === "nested").type, 3);
  assert.equal(entries.find((entry) => entry.name === "first.py").type, 4);
  assert.deepEqual(
    records(h.read(3, 4096, entries[0].next).bytes),
    entries.slice(1)
  );
  assert.equal(h.read(3, 4096, 3n).bytes.length, 0);
  assert.equal(h.observations().adaptedReads, 3);
});

test("short directory buffers retain the exact record prefix", (t) => {
  const h = harness(t);
  const full = h.read(3).bytes;
  assert.deepEqual(h.read(3, 12).bytes, full.subarray(0, 12));
  assert.equal(h.read(3, 0).bytes.length, 0);
});

test("successful directory opens are tracked and closes invalidate them", (t) => {
  const h = harness(t);
  Buffer.from(h.memory.buffer).write("nested", 64);
  assert.equal(h.imports.path_open(3, 1, 64, 6, 2, 0n, 0n, 0, 256), 0);
  assert.equal(h.view.getUint32(256, true), 10);
  assert.equal(h.read(10).bytes.length, 0);
  assert.equal(h.imports.fd_close(10), 0);
  assert.equal(h.read(10).errno, 8);
});

test("directory adapter rejects invalid cookies and unknown descriptors", (t) => {
  const h = harness(t);
  assert.equal(h.read(50).errno, 8);
  for (const cookie of [-1n, 4n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    assert.equal(h.read(3, 4096, cookie).errno, 28);
  }
});

test("directory adapter preserves a host implementation and host errors", (t) => {
  for (const result of [0, 8, 28, 54]) {
    const h = harness(t, result);
    assert.equal(h.read(3).errno, result);
    assert.equal(h.observations().adaptedReads, 0);
  }
});

test("directory opens cannot escape a tracked preopen", (t) => {
  const h = harness(t);
  Buffer.from(h.memory.buffer).write("..", 64);
  assert.throws(
    () => h.imports.path_open(3, 1, 64, 2, 2, 0n, 0n, 0, 256),
    /escaped its preopen/
  );
});
