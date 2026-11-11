// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { loopProbe } from "./benchmark.mjs";
import { directHost } from "./direct-host.mjs";
import { ARMS, assertAnswer, optionsFrom, summarize, workload } from "./direct.mjs";

const INITIALIZE = {
  rootUri: "file:///workspace",
  capabilities: {},
  initializationOptions: { pythonVersion: [3, 14, 0], pythonPlatform: "linux", searchPaths: ["/workspace"] },
};

function query(line, snapshot) {
  return {
    snapshot,
    arg: {
      uri: "file:///workspace/app.py",
      range: {
        start: { line, character: 0 },
        end: { line, character: 6 },
      },
    },
  };
}

test("direct experiment validates bounded counts and never accepts supplied artifacts", () => {
  for (const args of [
    ["--samples", "0"],
    ["--blocks", "7"],
    ["--size", "501"],
    ["--edits", "1.5"],
    ["--wasm", "other.wasm"],
    ["--native", "other.exe"],
    ["--unknown"],
  ])
    assert.throws(() => optionsFrom(args));
  assert.equal(optionsFrom(["--blocks", "1", "--samples", "2", "--edits", "1", "--size", "3"]).edits, 1);
});

test("same-document update fixtures preserve the imported corpus and exact query range", () => {
  const first = workload(3, 0),
    changed = workload(3, 7);
  assert.equal(first.files.size, 5);
  assert.equal(first.files.get("app.py").split("\n")[first.line], "answer: Literal[0] = 0");
  assert.equal(changed.files.get("app.py").split("\n")[changed.line], "answer: Literal[7] = 7");
  for (const [name, text] of first.files) {
    if (name !== "app.py") assert.equal(changed.files.get(name), text);
  }
});

test("direct measurement oracle rejects null, widening and stale success-shaped replies", () => {
  const valid = {
    kind: 3,
    literalValue: 7,
    flags: 2,
    declaration: { kind: 0, name: "int", node: { uri: "file:///typeshed/builtins.pyi" } },
  };
  assertAnswer(valid, 7);
  for (const value of [
    null,
    { kind: 0 },
    { ...valid, literalValue: 6 },
    { ...valid, flags: 0 },
    { ...valid, declaration: { ...valid.declaration, node: { uri: "file:///not-builtins.pyi" } } },
  ]) {
    assert.throws(() => assertAnswer(value, 7));
  }
});

test("three-arm summaries retain failures and only aggregate fully passing sessions", () => {
  const probe = { maxDelayMs: 2 };
  const good = {
    arm: ARMS[0],
    status: "passed",
    launchToFirstCorrectMs: 9,
    samples: [
      { phase: "first", elapsedMs: 3, eventLoop: probe },
      { phase: "warm", elapsedMs: 1, eventLoop: probe },
      { phase: "edit", elapsedMs: 4, eventLoop: probe },
    ],
  };
  const result = summarize([good, { arm: ARMS[0], status: "failed", samples: [{ phase: "warm", elapsedMs: 999 }] }], 3);
  assert.equal(result[0].planned, 3);
  assert.equal(result[0].failed, 1);
  assert.equal(result[0].warm.count, 1);
  assert.equal(result[0].warm.medianMs, 1);
  assert.equal(result[1].warm, null);
});

test("heartbeat includes a final direct synchronous stall even without intermediate awaits", async () => {
  const probe = loopProbe(5);
  const until = performance.now() + 40;
  while (performance.now() < until) {
    /* Intentional negative control. */
  }
  const result = await probe.stop();
  assert(result.maxDelayMs >= 20);
  assert(result.ticks.at(-1).atMs >= result.activeEndMs);
});

const actual = process.env.PYREFLY_DIRECT_WASM;
test(
  "real reactor exports direct functions and performs exact init/open/query/edit/dispose",
  {
    skip: !actual && "Set PYREFLY_DIRECT_WASM to the actually built reactor",
  },
  async () => {
    const module = await WebAssembly.compile(await readFile(actual));
    const exports = WebAssembly.Module.exports(module);
    assert(exports.some((entry) => entry.name === "direct_query"));
    assert(!exports.some((entry) => entry.name === "_start"));
    const data = workload(3);
    const guest = await directHost(module, data.files);
    try {
      await assert.rejects(guest.request("typeServer/getSnapshot"), (error) => error.code === -32002);
      await guest.request("initialize", INITIALIZE);
      await assert.rejects(guest.request("initialize", INITIALIZE), (error) => error.code === -32600);
      assert.equal(typeof (await guest.request("typeServer/getSupportedProtocolVersion")), "string");
      for (const name of ["shared.py", "app.py"]) {
        await guest.request("textDocument/didOpen", {
          textDocument: {
            uri: `file:///workspace/${name}`,
            version: 1,
            languageId: "python",
            text: data.files.get(name),
          },
        });
      }
      const snapshot = await guest.request("typeServer/getSnapshot");
      const first = await guest.request("typeServer/getComputedType", query(data.line, snapshot));
      assertAnswer(first, 0);
      const oldMemory = guest.raw.memory.buffer;
      guest.raw.memory.grow(1);
      assert.equal(oldMemory.byteLength, 0, "Expected the old nonshared memory view to detach");
      for (const revision of [1, 2, 3]) {
        await guest.request("textDocument/didChange", {
          textDocument: { uri: "file:///workspace/app.py", version: revision + 1 },
          contentChanges: [{ text: workload(3, revision).text }],
        });
        const current = await guest.request("typeServer/getSnapshot");
        assert(current > snapshot);
        await assert.rejects(
          guest.request("typeServer/getComputedType", query(data.line, snapshot)),
          (error) => error.code === -32802
        );
        assertAnswer(await guest.request("typeServer/getComputedType", query(data.line, current)), revision);
        assertAnswer(first, 0);
      }
    } finally {
      await guest.close();
    }
    await assert.rejects(guest.request("typeServer/getSnapshot"), /closed/);
  }
);

test(
  "real reactor rejects malformed ABI bytes and poisons invalid updates like the command guest",
  {
    skip: !actual && "Set PYREFLY_DIRECT_WASM to the actually built reactor",
  },
  async () => {
    const module = await WebAssembly.compile(await readFile(actual));
    const data = workload(1);
    const guest = await directHost(module, data.files);
    try {
      const raw = guest.raw;
      assert.equal(raw.direct_reserve(0), 0);
      assert.equal(raw.direct_reserve(1024 * 1024 + 1), 0);
      const pointer = raw.direct_reserve(1) >>> 0;
      new Uint8Array(raw.memory.buffer, pointer, 1)[0] = 255;
      assert.equal(raw.direct_initialize(), 1);
      const output = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(raw.memory.buffer, raw.direct_output_ptr() >>> 0, raw.direct_output_len())
        )
      );
      assert.equal(output.error.code, -32602);
      await guest.request("initialize", INITIALIZE);
      await assert.rejects(
        guest.request("textDocument/didChange", {
          textDocument: { uri: "file:///workspace/not-open.py", version: 2 },
          contentChanges: [{ text: "value = 1\n" }],
        })
      );
      await assert.rejects(guest.request("typeServer/getSnapshot"), (error) => error.code === -32603);
    } finally {
      await guest.close();
    }
  }
);
