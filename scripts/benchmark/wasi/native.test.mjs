// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { frameReader } from "./benchmark.mjs";
import { ARMS, assertAnswer, fixtureHash, optionsFrom, StdioClient, summarize } from "./native.mjs";
import { bounded, childEnvironment, exited, startResources } from "./resources.mjs";

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function client(t, timeout = 100) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  t.after(() => {
    child.stdin.destroy();
    child.stdout.destroy();
  });
  return { child, rpc: new StdioClient(child, timeout) };
}

test("native options reject invalid counts, overrides and unsupported modes", () => {
  for (const args of [
    ["--samples", "0"],
    ["--size", "501"],
    ["--blocks", "11"],
    ["--samples", "1.5"],
    ["--native", "other-binary"],
    ["--inline"],
    ["--check-edits"],
  ])
    assert.throws(() => optionsFrom(args));
  const options = optionsFrom(["--blocks", "1", "--samples", "2", "--size", "3", "--no-sample"]);
  assert.equal(options.blocks, 1);
  assert.equal(options.samples, 2);
  assert.equal(options.size, 3);
  assert(options["no-sample"]);
});

test("saved-file oracle rejects widening, stale literals and false builtin identities", () => {
  const valid = {
    kind: 3,
    literalValue: 0,
    flags: 2,
    declaration: { kind: 0, name: "int", node: { uri: "file:///typeshed/builtins.pyi" } },
  };
  assertAnswer(valid);
  for (const type of [
    null,
    { kind: 0 },
    { ...valid, literalValue: 1 },
    { ...valid, flags: "2" },
    { ...valid, declaration: { ...valid.declaration, node: { uri: "file:///not-builtins.pyi" } } },
    { ...valid, declaration: { ...valid.declaration, node: { uri: "https://example.invalid/builtins.pyi" } } },
  ])
    assert.throws(() => assertAnswer(type));
});

test("shared framing exposes an explicit truncated-EOF failure", () => {
  const read = frameReader(() => {});
  read(Buffer.from("Content-Length: 2\r\n\r\n{"));
  assert.throws(() => read.end(), /Truncated/);
});

test("saved-file identity matches across disk enumeration order, but not changed contents", () => {
  assert.equal(
    fixtureHash(
      new Map([
        ["a.py", "a"],
        ["b.py", "b"],
      ])
    ),
    fixtureHash(
      new Map([
        ["b.py", "b"],
        ["a.py", "a"],
      ])
    )
  );
  assert.notEqual(fixtureHash(new Map([["a.py", "a"]])), fixtureHash(new Map([["a.py", "b"]])));
});

test("native RPC correlates exact replies and clears all pending requests", async (t) => {
  const { child, rpc } = client(t);
  const response = rpc.request("test");
  child.stdout.write(frame({ jsonrpc: "2.0", id: 1, result: 0 }));
  assert.equal(await response, 0);
  assert.equal(rpc.pending.size, 0);
});

test("malformed stdio rejects the current and subsequent RPC with the same error", async (t) => {
  const { child, rpc } = client(t);
  const response = rpc.request("test");
  child.stdout.write(Buffer.from("Content-Length: 1\r\n\r\n{"));
  await assert.rejects(response, (error) => error === rpc.failure);
  await assert.rejects(rpc.request("later"), (error) => error === rpc.failure);
  assert.equal(rpc.pending.size, 0);
});

test("RPC timeout, output budget and truncated EOF never become successful samples", async (t) => {
  const timed = client(t, 5);
  await assert.rejects(timed.rpc.request("blocked"), /timed out/);
  const huge = client(t);
  huge.rpc.outputBytes = 64 * 1024 * 1024;
  const response = huge.rpc.request("test");
  huge.child.stdout.write(frame({ jsonrpc: "2.0", id: 1, result: 0 }));
  await assert.rejects(response, /output budget/);
  const truncated = client(t);
  const pending = truncated.rpc.request("test");
  truncated.child.stdout.end(Buffer.from("Content-Length: 2\r\n\r\n{"));
  await assert.rejects(pending, /Truncated/);
});

test("native client configuration is explicit and Python diagnostics fail", async (t) => {
  const { child, rpc } = client(t);
  child.stdout.write(
    frame({
      jsonrpc: "2.0",
      id: "server-1",
      method: "workspace/configuration",
      params: { items: [{}] },
    })
  );
  assert.deepEqual(rpc.messages.at(-1).message.result, [{}]);
  const hints = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { diagnostics: [{ code: "unused-import", severity: 4, message: "Expected fixture hint" }] },
  };
  child.stdout.write(frame(hints));
  assert.deepEqual(rpc.messages.at(-1).message, hints);
  assert.equal(rpc.failure, undefined);
  const response = rpc.request("test");
  child.stdout.write(
    frame({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { diagnostics: [{ message: "missing import" }] },
    })
  );
  await assert.rejects(response, /Python diagnostics/);
});

test("unused-import warnings and other hints are not silently accepted", async (t) => {
  for (const diagnostic of [
    { code: "unused-import", severity: 2 },
    { code: "missing-import", severity: 4 },
  ]) {
    const { child, rpc } = client(t);
    const pending = rpc.request("test");
    child.stdout.write(
      frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { diagnostics: [diagnostic] } })
    );
    await assert.rejects(pending, /unexpected Python diagnostics/);
  }
});

test("child environments exclude credentials and ambient engine/thread overrides", () => {
  assert.deepEqual(
    childEnvironment({
      PATH: "tools",
      TEMP: "tmp",
      GITHUB_TOKEN: "test-secret",
      PYTHONPATH: "other",
      PYREFLY_CONFIG: "other",
      RAYON_NUM_THREADS: "99",
      UV_THREADPOOL_SIZE: "2",
    }),
    { PATH: "tools", TEMP: "tmp", UV_THREADPOOL_SIZE: "2", PYTHONIOENCODING: "utf-8", RUST_BACKTRACE: "0" }
  );
});

test("missing resource collector executable fails without leaving a child", async () => {
  await assert.rejects(startResources(process.pid, "nonexistent-benchmark-python-command"), /ENOENT/);
});

test("sampleable child host fails and retires when real Wasm exits without replying", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pyrefly-native-host-test-"));
  const wasm = path.join(root, "empty.wasm");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    wasm,
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109, 101, 109, 111, 114,
      121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
    ])
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("native.mjs", import.meta.url)), "--wasi-child", wasm, workspace],
    { stdio: ["pipe", "pipe", "pipe", "ipc"], env: childEnvironment(), windowsHide: true }
  );
  const exit = exited(child);
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString("utf8");
  });
  try {
    const rpc = new StdioClient(child, 5000);
    await assert.rejects(rpc.request("initialize"), /ended with pending|Unexpected.*exit/);
    const result = await bounded(exit, 5000, "Test child exit");
    assert.notEqual(result.code, 0);
    assert.match(stderr, /Unexpected.*exit/);
    assert.equal(rpc.pending.size, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await bounded(exit, 5000, "Test failure retirement");
    await rm(wasm);
    await rmdir(workspace);
    await rmdir(root);
  }
});

test("report denominators retain failed sessions and never impute their timing", () => {
  const sessions = [
    { arm: ARMS[0], status: "failed", samples: [{ phase: "warm", elapsedMs: 999 }] },
    { arm: ARMS[0], status: "passed", samples: [{ phase: "warm", elapsedMs: 2 }], launchToFirstCorrectMs: 4 },
  ];
  const result = summarize(sessions, 3);
  assert.equal(result[0].planned, 3);
  assert.equal(result[0].passed, 1);
  assert.equal(result[0].failed, 1);
  assert.equal(result[0].warmSnapshotAndType.count, 1);
  assert.equal(result[0].warmSnapshotAndType.medianMs, 2);
  assert.equal(result[1].warmSnapshotAndType, null);
});
