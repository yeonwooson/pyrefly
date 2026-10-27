// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { fixture, frameReader, host, loopProbe, stats } from "./benchmark.mjs";

test("framing handles arbitrary chunks and multiple UTF-8 responses", () => {
  const messages = [
    { jsonrpc: "2.0", id: 1, result: "caf\u00e9" },
    { jsonrpc: "2.0", id: 2, result: 42 },
  ];
  const frames = Buffer.concat(
    messages.map((message) => {
      const bytes = Buffer.from(JSON.stringify(message));
      return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
    })
  );
  const received = [];
  const read = frameReader((message) => received.push(message));
  for (const byte of frames) read(Buffer.from([byte]));
  assert.deepEqual(received, messages);
});

test("malformed framing and oversized bodies fail explicitly", () => {
  const read = frameReader(() => assert.fail("Invalid frame was accepted"));
  assert.throws(() => read(Buffer.from("Content-Length: nope\r\n\r\n")), /Invalid response header/);
  assert.throws(() => frameReader(() => {})(Buffer.from("Content-Length: 1048577\r\n\r\n")), /Oversized response body/);
  assert.throws(() => frameReader(() => {})(Buffer.alloc(8192, 65)), /Oversized response header/);
  assert.throws(
    () => frameReader(() => {})(Buffer.from(`Content-Length: ${"0".repeat(8192)}2\r\n\r\n{}`)),
    /Oversized response header/
  );
  assert.throws(
    () => frameReader(() => {})(Buffer.concat([Buffer.from("Content-Length: 2\r\n\r\n"), Buffer.from([0xc3, 0x28])])),
    /encoded data/
  );
});

test("statistics retain the tail and use nearest-rank p95", () => {
  assert.deepEqual(stats([4, 1, 100, 2]), {
    count: 4,
    medianMs: 3,
    p95Ms: 100,
    maxMs: 100,
  });
  assert.equal(stats([2, 1, 3]).medianMs, 2);
  assert.equal(stats(Array.from({ length: 20 }, (_, i) => i + 1)).p95Ms, 19);
  assert.throws(() => stats([]));
  assert.throws(() => stats([NaN]));
});

test("workloads are deterministic and the query range names answer", () => {
  for (const name of ["shared", "compute"]) {
    const first = fixture(name, 10);
    assert.deepEqual(first, fixture(name, 10));
    assert.equal(first.files.get("app.py").split("\n")[first.line], "answer = seed");
    assert.equal(first.files.size, name === "shared" ? 12 : 2);
    assert.equal(fixture(name, 10, 7).files.get("shared.py"), "from typing import Literal\nseed: Literal[7] = 7\n");
  }
  assert.throws(() => fixture("unknown", 10));
  assert.throws(() => fixture("compute", 0));
  assert.throws(() => fixture("compute", 10, -1));
});

test("heartbeat detects actual synchronous blocking and drains its final delayed tick", async () => {
  assert.throws(() => loopProbe(0));
  const probe = loopProbe(5);
  const until = performance.now() + 40;
  while (performance.now() < until) {
    // Deliberately block the driving thread, as a synchronous guest computation does.
  }
  const result = await probe.stop();
  assert(result.ticks.length > 0);
  assert(result.maxDelayMs >= 20, `Missed deliberate stall: ${JSON.stringify(result)}`);
  assert.equal(result.maxDelayMs, Math.max(...result.ticks.map((tick) => tick.delayMs)));
  assert(result.ticks.at(-1).atMs >= result.activeEndMs);
});

for (const placement of ["worker", "jspi"]) {
  test(
    `${placement} fails and cleans up when a real Wasm command exits without replying`,
    { timeout: 10_000 },
    async () => {
      // A real Wasm module exporting memory and an immediately returning _start.
      const module = await WebAssembly.compile(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109, 101, 109, 111,
          114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
        ])
      );
      const guest = await host(module, new Map(), placement);
      try {
        await guest.ready();
        await assert.rejects(guest.request("initialize"), /Unexpected.*exit/);
      } finally {
        await assert.rejects(guest.close(), /Unexpected.*exit/);
      }
    }
  );
}
