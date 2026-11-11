"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  FrameReader,
  MAX_BODY,
  RpcClient,
  assertSnapshot,
  assertType,
  frame,
  stats,
} = require("./protocol.cjs");
const {
  argumentsFrom,
  backendEnvironment,
  fixture,
  startSampler,
} = require("./run.cjs");

test("framing retains split UTF-8 and multiple messages", () => {
  const observed = [];
  const reader = new FrameReader((message) => observed.push(message));
  const input = Buffer.concat([
    frame({ message: "snowman: \u2603" }),
    frame({ id: 2, result: 3 }),
  ]);
  for (const byte of input) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(observed, [
    { message: "snowman: \u2603" },
    { id: 2, result: 3 },
  ]);
});

for (const [name, data] of [
  ["duplicate length", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"],
  ["missing length", "Other: 2\r\n\r\n{}"],
  ["negative length", "Content-Length: -1\r\n\r\n"],
  ["oversized body", `Content-Length: ${MAX_BODY + 1}\r\n\r\n`],
  ["malformed JSON", "Content-Length: 1\r\n\r\n{"],
]) {
  test(`framing rejects ${name}`, () => {
    assert.throws(() => new FrameReader(() => {}).push(Buffer.from(data)));
  });
}

test("framing rejects truncated body and invalid UTF-8", () => {
  const reader = new FrameReader(() => {});
  reader.push(Buffer.from("Content-Length: 2\r\n\r\n{"));
  assert.throws(() => reader.end(), /Truncated/);
  assert.throws(() =>
    new FrameReader(() => {}).push(
      Buffer.concat([
        Buffer.from("Content-Length: 1\r\n\r\n"),
        Buffer.from([255]),
      ])
    )
  );
});

test("RPC receives exact response and reports request elapsed time", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new RpcClient(input, output, 500);
  const result = rpc.request("test");
  output.write(frame({ jsonrpc: "2.0", id: 1, result: "answer" }));
  const response = await result;
  assert.equal(response.value, "answer");
  assert(response.elapsedMs >= 0);
  assert.equal(rpc.pending.size, 0);
  input.destroy();
  output.destroy();
});

test("malformed output rejects all pending RPCs with original error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new RpcClient(input, output, 500);
  const pending = rpc.request("test");
  output.write(Buffer.from("Content-Length: 1\r\n\r\n{"));
  const failure = rpc.failure;
  await assert.rejects(pending, (error) => error === failure);
  await assert.rejects(rpc.request("later"), (error) => error === failure);
  assert.equal(rpc.pending.size, 0);
  input.destroy();
  output.destroy();
});

test("RPC timeout is a failure, never an empty answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new RpcClient(input, output, 10);
  await assert.rejects(rpc.request("blocked"), /RPC timeout/);
  assert.equal(rpc.pending.size, 0);
  input.destroy();
  output.destroy();
});

test("RPC output budget failure rejects pending requests explicitly", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new RpcClient(input, output, 500);
  rpc.outputBytes = 64 * 1024 * 1024;
  const result = rpc.request("test");
  output.write(frame({ jsonrpc: "2.0", id: 1, result: 3 }));
  await assert.rejects(result, /output budget/);
  assert.equal(rpc.pending.size, 0);
  input.destroy();
  output.destroy();
});

test("missing sampler executable fails promptly without leaving a child", async () => {
  await assert.rejects(
    startSampler(process.pid, "public-benchmark-nonexistent-python-executable"),
    /ENOENT/
  );
});

test("correctness oracle rejects null, widening and wrong builtin identity", () => {
  const valid = {
    kind: 3,
    flags: 2,
    declaration: {
      kind: 0,
      name: "int",
      node: { uri: "file:///typeshed/builtins.pyi" },
    },
  };
  assert.deepEqual(assertType(valid, "int"), {
    kind: 3,
    name: "int",
    flags: 2,
  });
  for (const value of [
    null,
    { kind: 0 },
    { ...valid, flags: 0 },
    { ...valid, flags: "2" },
    {
      ...valid,
      declaration: {
        ...valid.declaration,
        node: { uri: "file:///typeshed/not-builtins.pyi" },
      },
    },
    {
      ...valid,
      declaration: {
        ...valid.declaration,
        node: { uri: "https://example.invalid/builtins.pyi" },
      },
    },
    { ...valid, declaration: { ...valid.declaration, name: "Any" } },
  ]) {
    assert.throws(() => assertType(value, "int"));
  }
});

test("snapshot zero is valid, but malformed and out-of-range snapshots fail", () => {
  for (const value of [0, 1, 0x7fffffff]) assertSnapshot(value);
  for (const value of [-1, null, undefined, "0", 0.5, 0x80000000]) {
    assert.throws(() => assertSnapshot(value), /Invalid TSP snapshot/);
  }
});

test("backend environment excludes credentials and unrelated engine overrides", () => {
  const environment = backendEnvironment({
    PATH: "public-tools",
    SystemRoot: "system",
    TMP: "temporary",
    UV_THREADPOOL_SIZE: "2",
    GITHUB_TOKEN: "test-secret",
    PYTHONPATH: "unrelated",
    PYREFLY_CONFIG: "unrelated",
    RAYON_NUM_THREADS: "99",
  });
  assert.deepEqual(environment, {
    PATH: "public-tools",
    SystemRoot: "system",
    TMP: "temporary",
    UV_THREADPOOL_SIZE: "2",
    RUST_BACKTRACE: "0",
  });
});

test("CLI validates bounds and does not infer a native inline mode", () => {
  for (const args of [
    [],
    ["--source", ".", "--out", ".", "--queries", "0"],
    ["--source", ".", "--out", ".", "--repeats", "10000"],
    ["--source", ".", "--out", ".", "--unknown"],
    ["--source"],
  ])
    assert.throws(() => argumentsFrom(args));
  const options = argumentsFrom([
    "--source",
    ".",
    "--out",
    "target/test",
    "--smoke",
    "--no-sample",
    "--check-edits",
  ]);
  assert.equal(options.repeats, 1);
  assert.equal(options.modules, 3);
  assert.equal(options.sample, false);
  assert.equal(options.checkEdits, true);
  assert.equal(
    argumentsFrom(["--source", ".", "--out", "."]).checkEdits,
    false
  );
});

test("build mode cannot falsely attest externally supplied artifacts", () => {
  for (const name of ["native", "wasm", "exporter"]) {
    assert.throws(
      () =>
        argumentsFrom([
          "--source",
          ".",
          "--out",
          ".",
          "--build",
          `--${name}`,
          "external-artifact",
        ]),
      /--build cannot be combined with artifact overrides/
    );
  }
});

test("generated DAG and disk source remain deterministic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-tsp-fixture-"));
  try {
    const first = fixture(path.join(root, "a"), 3);
    const second = fixture(path.join(root, "b"), 3);
    assert.deepEqual(first.sources, second.sources);
    assert.equal(
      fs.readFileSync(path.join(root, "a", "m0000.py"), "utf8"),
      first.leaf
    );
    assert(first.main.includes("from m0001 import get_value"));
    assert(first.dirty.includes("-> str"));
    const config = fs.readFileSync(
      path.join(root, "a", "pyrefly.toml"),
      "utf8"
    );
    assert(config.includes('python-version = "3.13"'));
    assert(config.includes('python-platform = "linux"'));
    assert(!config.includes("typeshed-path"));
  } finally {
    for (const directory of ["a", "b"]) {
      for (const file of fs.readdirSync(path.join(root, directory)))
        fs.unlinkSync(path.join(root, directory, file));
      fs.rmdirSync(path.join(root, directory));
    }
    fs.rmdirSync(root);
  }
});

test("statistics show sample counts, median and nearest-rank tails", () => {
  assert.equal(stats([]), null);
  assert.deepEqual(stats([4, 1, 3, 2]), {
    count: 4,
    medianMs: 2.5,
    p95Ms: 4,
    maxMs: 4,
  });
});
