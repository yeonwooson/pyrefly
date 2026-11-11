"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { TextDecoder } = require("node:util");

const MAX_BODY = 1024 * 1024;
const MAX_HEADER = 8192;
const MAX_OUTPUT = 64 * 1024 * 1024;

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_BODY) throw new Error("RPC body exceeds limit");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

class FrameReader {
  constructor(accept) {
    this.accept = accept;
    this.buffer = Buffer.alloc(0);
  }

  push(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > MAX_HEADER)
          throw new Error("RPC header exceeds limit");
        return;
      }
      if (end > MAX_HEADER) throw new Error("RPC header exceeds limit");
      const header = this.buffer.subarray(0, end).toString("ascii");
      const lengths = header
        .split("\r\n")
        .filter((line) => /^Content-Length:/i.test(line));
      if (
        lengths.length !== 1 ||
        !/^Content-Length:\s*\d+$/i.test(lengths[0])
      ) {
        throw new Error("Invalid Content-Length");
      }
      const length = Number(lengths[0].split(":")[1]);
      if (!Number.isSafeInteger(length) || length > MAX_BODY)
        throw new Error("RPC body exceeds limit");
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      this.accept(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
      );
    }
  }

  end() {
    if (this.buffer.length) throw new Error("Truncated RPC frame");
  }
}

class RpcClient extends EventEmitter {
  constructor(input, output, timeoutMs = 30000) {
    super();
    this.input = input;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.failure = undefined;
    this.messages = [];
    this.outputBytes = 0;
    this.reader = new FrameReader((value) => this.receive(value));
    output.on("data", (bytes) => {
      if (this.failure) return;
      try {
        this.outputBytes += bytes.length;
        if (this.outputBytes > MAX_OUTPUT)
          throw new Error("RPC output budget exceeded");
        this.reader.push(bytes);
      } catch (error) {
        this.fail(error);
      }
    });
    output.on("error", (error) => this.fail(error));
    output.on("end", () => {
      try {
        this.reader.end();
      } catch (error) {
        this.fail(error);
      }
      if (this.pending.size)
        this.fail(new Error("RPC stream ended with pending requests"));
    });
    input.on("error", (error) => this.fail(error));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  receive(value) {
    this.messages.push({
      direction: "in",
      atMs: performance.now(),
      message: value,
    });
    if (value.method && value.id !== undefined) {
      let result;
      if (value.method === "workspace/configuration") {
        result = value.params.items.map(() => ({}));
      } else if (
        [
          "client/registerCapability",
          "window/workDoneProgress/create",
        ].includes(value.method)
      ) {
        result = null;
      } else {
        this.write({
          jsonrpc: "2.0",
          id: value.id,
          error: { code: -32601, message: "Unsupported client request" },
        });
        return;
      }
      this.write({ jsonrpc: "2.0", id: value.id, result });
      return;
    }
    if (value.id === undefined) {
      this.emit("notification", value);
      return;
    }
    const request = this.pending.get(value.id);
    if (!request) throw new Error(`Unexpected RPC response ${value.id}`);
    const elapsedMs = performance.now() - request.start;
    clearTimeout(request.timer);
    this.pending.delete(value.id);
    if (value.error) {
      const error = new Error(
        `RPC ${request.method}: ${JSON.stringify(value.error)}`
      );
      error.rpc = value.error;
      request.reject(error);
    } else {
      request.resolve({ value: value.result, elapsedMs });
    }
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.messages.push({ direction: "out", atMs: performance.now(), message });
    this.input.write(frame(message));
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params = null) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`RPC timeout: ${method}`);
        this.fail(error);
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        start: performance.now(),
        method,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }
}

function assertSnapshot(value) {
  assert(
    Number.isInteger(value) && value >= 0 && value <= 0x7fffffff,
    "Invalid TSP snapshot"
  );
}

function assertType(value, expected) {
  assert(value && value.kind === 3, "Expected a non-null TSP ClassType");
  assert.equal(value.declaration?.name, expected, "Incorrect type declaration");
  assert.equal(value.declaration?.kind, 0, "Expected a regular declaration");
  const source = new URL(value.declaration.node?.uri);
  assert.equal(source.protocol, "file:", "Expected builtin file identity");
  assert.equal(
    decodeURIComponent(source.pathname).split("/").at(-1),
    "builtins.pyi",
    "Expected builtin source identity"
  );
  assert(
    Number.isInteger(value.flags) && (value.flags & 2) !== 0,
    "Expected instance type flags"
  );
  return { kind: value.kind, name: value.declaration.name, flags: value.flags };
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted.at(-1),
  };
}

module.exports = {
  FrameReader,
  MAX_BODY,
  RpcClient,
  assertSnapshot,
  assertType,
  frame,
  stats,
};
