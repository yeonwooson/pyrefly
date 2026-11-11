// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";

import { createGuestWasi } from "./benchmark.mjs";

const MAX_BYTES = 1024 * 1024;
const METHODS = {
  initialize: "direct_initialize",
  "typeServer/getSupportedProtocolVersion": "direct_protocol",
  "textDocument/didOpen": "direct_open",
  "textDocument/didChange": "direct_change",
  "typeServer/getSnapshot": "direct_snapshot",
  "typeServer/getComputedType": "direct_query",
};

class DirectGuestError extends Error {
  constructor(error) {
    super(`Direct guest: ${JSON.stringify(error)}`);
    this.code = error.code;
  }
}

/** Call exported functions on this thread; only JSON buffers cross the ABI. */
export async function directHost(module, files) {
  let hostFailure;
  const wasi = createGuestWasi(files, (message) => {
    hostFailure ??= new Error(
      `Unexpected direct guest ${message.kind}: ${Buffer.from(message.bytes).toString("utf8")}`
    );
    throw hostFailure;
  });
  let instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(instance);
  let exports = instance.exports;
  assert(exports.memory instanceof WebAssembly.Memory, "Direct guest must export memory");
  assert(!(exports.memory.buffer instanceof SharedArrayBuffer), "Direct guest must own nonshared memory");
  for (const name of [
    "direct_reserve",
    "direct_output_ptr",
    "direct_output_len",
    "direct_dispose",
    ...Object.values(METHODS),
  ]) {
    assert.equal(typeof exports[name], "function", `Missing direct export ${name}`);
  }
  let closed = false;
  let busy = false;
  let trapped;
  const reply = (status) => {
    assert(status === 0 || status === 1, "Invalid direct result status");
    const pointer = exports.direct_output_ptr() >>> 0;
    const length = exports.direct_output_len() >>> 0;
    const memory = exports.memory.buffer;
    assert(length > 0 && length <= MAX_BYTES && pointer + length <= memory.byteLength, "Invalid direct result buffer");
    const message = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memory, pointer, length))
    );
    assert.equal(status !== 0, Object.hasOwn(message, "error"), "Direct status/result mismatch");
    if (message.error) {
      throw new DirectGuestError(message.error);
    }
    assert(Object.hasOwn(message, "value"), "Direct reply omitted its value");
    assert(Array.isArray(message.diagnostics), "Direct reply omitted diagnostics");
    for (const diagnostics of message.diagnostics) {
      assert.deepEqual(diagnostics.diagnostics, [], "Direct guest reported Python diagnostics");
    }
    return message.value;
  };
  return {
    // Exposed for ABI negative tests, never used to bypass checks in measurements.
    get raw() {
      return exports;
    },
    async request(method, params = null) {
      assert(!closed, "Direct host is closed");
      if (hostFailure) throw hostFailure;
      if (trapped) throw trapped;
      assert(!busy, "Direct calls must be serial");
      const name = METHODS[method];
      assert(name, `Unsupported direct operation ${method}`);
      const input = new TextEncoder().encode(JSON.stringify(params));
      assert(input.length > 0 && input.length <= MAX_BYTES, "Direct input exceeds budget");
      busy = true;
      try {
        const pointer = exports.direct_reserve(input.length) >>> 0;
        if (pointer === 0) return reply(1);
        assert(pointer + input.length <= exports.memory.buffer.byteLength, "Invalid direct input buffer");
        new Uint8Array(exports.memory.buffer, pointer, input.length).set(input);
        // A call may grow memory; reply() must acquire a new buffer view.
        return reply(exports[name]());
      } catch (error) {
        // WASI proc_exit and malformed ABI replies are fatal too, not only Wasm traps.
        if (!(error instanceof DirectGuestError)) trapped = error;
        throw error;
      } finally {
        busy = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (trapped || hostFailure) throw trapped ?? hostFailure;
        reply(exports.direct_dispose());
      } finally {
        // The reactor drops DocumentGuest; memory reclamation still belongs to GC.
        wasi.inst = undefined;
        instance = undefined;
        exports = undefined;
      }
    },
  };
}
