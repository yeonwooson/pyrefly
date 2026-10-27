// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";

import { File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";

import { buildArtifacts, command, ROOT, suiteHashes } from "./build.mjs";

const MAX_FRAME = 1024 * 1024;
const TIMEOUT = 120_000;
const WORKLOADS = [
  { name: "shared", size: 1024 },
  { name: "compute", size: 600 },
];

/** Decode the command's Content-Length frames, including fragmented writes. */
export function frameReader(receive) {
  let buffered = Buffer.alloc(0);
  const read = (bytes) => {
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.length) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        assert(buffered.length < 8192, "Oversized response header");
        return;
      }
      assert(end < 8192, "Oversized response header");
      const match = /^Content-Length: ([0-9]+)$/i.exec(buffered.subarray(0, end).toString("ascii"));
      assert(match, "Invalid response header");
      const length = Number(match[1]);
      assert(length <= MAX_FRAME, "Oversized response body");
      if (buffered.length < end + 4 + length) return;
      const body = buffered.subarray(end + 4, end + 4 + length);
      buffered = buffered.subarray(end + 4 + length);
      receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    }
  };
  read.end = () => assert.equal(buffered.length, 0, "Truncated response frame");
  return read;
}

/** Generate public, deterministic fixtures; no Python packages are installed. */
export function fixture(name, size, revision = 0) {
  assert(["shared", "compute"].includes(name));
  assert(Number.isSafeInteger(size) && size > 0);
  assert(Number.isSafeInteger(revision) && revision >= 0);
  const files = new Map([["shared.py", seedSource(revision)]]);
  const lines = ["from shared import seed"];
  for (let i = 0; i < size; i++) {
    if (name === "shared") {
      files.set(`module_${i}.py`, `from shared import seed\nvalue_${i} = seed + ${i}\n`);
      lines.push(`from module_${i} import value_${i}`);
    } else {
      lines.push(`value_${i}: list[int] = [seed + ${i}]`);
    }
  }
  lines.push("answer = seed", "");
  files.set("app.py", lines.join("\n"));
  return { files, line: lines.length - 2 };
}

function seedSource(revision) {
  return `from typing import Literal\nseed: Literal[${revision}] = ${revision}\n`;
}

/** Use the same guest, filesystem and mailbox in both placements. */
async function runGuest({ module, inbox, files, placement }, emit) {
  const state = new Int32Array(inbox, 0, 2);
  const data = new Uint8Array(inbox, 8);
  const output = (kind) => {
    const fd = new OpenFile(new File(new Uint8Array()));
    fd.fd_write = (bytes) => {
      emit({ kind, bytes: Buffer.from(bytes) });
      return { ret: 0, nwritten: bytes.length };
    };
    return fd;
  };
  const wasi = new WASI(
    ["pyrefly-wasi-query"],
    [],
    [
      new OpenFile(new File(new Uint8Array())),
      output("stdout"),
      output("stderr"),
      new PreopenDirectory(
        "/workspace",
        new Map([...files].map(([name, text]) => [name, new File(new TextEncoder().encode(text))]))
      ),
    ],
    { debug: false }
  );
  const originalRead = wasi.wasiImport.fd_read;
  const read = (fd, iovs, count, nread) => {
    if (fd !== 0) return originalRead(fd, iovs, count, nread);
    const memory = new DataView(wasi.inst.exports.memory.buffer);
    let cursor = Atomics.load(state, 1);
    const length = Atomics.load(state, 0);
    let copied = 0;
    for (let i = 0; length > 0 && i < count; i++) {
      const pointer = memory.getUint32(iovs + i * 8, true);
      const available = memory.getUint32(iovs + i * 8 + 4, true);
      const take = Math.min(available, length - cursor);
      new Uint8Array(memory.buffer, pointer, take).set(data.subarray(cursor, cursor + take));
      cursor += take;
      copied += take;
    }
    memory.setUint32(nread, copied, true);
    Atomics.store(state, 1, cursor);
    if (length > 0 && cursor === length) Atomics.store(state, 0, 0);
    return 0;
  };
  if (placement === "worker") {
    wasi.wasiImport.fd_read = (...args) => {
      if (args[0] === 0) {
        while (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0);
      }
      return read(...args);
    };
  } else {
    const readStdin = async (...args) => {
      while (Atomics.load(state, 0) === 0) await Atomics.waitAsync(state, 0, 0).value;
      return read(...args);
    };
    wasi.wasiImport.fd_read = new WebAssembly.Suspending((...args) => {
      return args[0] === 0 ? readStdin(...args) : originalRead(...args);
    });
  }
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize(instance);
  emit({ kind: "ready", threadId });
  try {
    if (placement === "worker") instance.exports._start();
    else await WebAssembly.promising(instance.exports._start)();
  } catch (error) {
    if (!(error instanceof WASIProcExit) || error.code !== 0) throw error;
  }
}

/** Own one persistent command and fail explicitly on protocol or runtime errors. */
export async function host(module, files, placement) {
  const inbox = new SharedArrayBuffer(MAX_FRAME + 8192 + 8);
  const state = new Int32Array(inbox, 0, 2);
  const ready = Promise.withResolvers();
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let failure;
  const fail = (error) => {
    failure ??= error;
    ready.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
  };
  const decode = frameReader((message) => {
    assert.equal(message.jsonrpc, "2.0");
    if (message.method) {
      assert(["typeServer/snapshotChanged", "textDocument/publishDiagnostics"].includes(message.method));
      if (message.method === "textDocument/publishDiagnostics") {
        assert.deepEqual(message.params.diagnostics, [], "Guest reported Python diagnostics");
      }
      return;
    }
    const waiter = pending.get(message.id);
    assert(waiter, `Uncorrelated response: ${message.id}`);
    assert(Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"));
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const emit = (message) => {
    try {
      if (message.kind === "ready") ready.resolve(message.threadId);
      else if (message.kind === "stdout") decode(message.bytes);
      else if (message.kind === "stderr") throw new Error(Buffer.from(message.bytes).toString("utf8"));
      else throw new Error(`Unknown guest message: ${message.kind}`);
    } catch (error) {
      fail(error);
    }
  };
  const options = { module, files, placement, inbox };
  let worker;
  let completion;
  if (placement === "worker") {
    worker = new Worker(new URL(import.meta.url), { workerData: options });
    worker.on("message", emit);
    worker.on("error", fail);
    completion = new Promise((resolve) =>
      worker.once("exit", (code) => {
        if (!closed || code !== 0) fail(new Error(`Unexpected Worker exit: ${code}`));
        resolve();
      })
    );
  } else {
    completion = runGuest(options, emit).then(() => {
      if (!closed) fail(new Error("Unexpected main-thread guest exit"));
    }, fail);
  }
  const send = (message) => {
    if (failure) throw failure;
    assert.equal(Atomics.load(state, 0), 0, "Previous input has not been consumed");
    const body = Buffer.from(JSON.stringify(message));
    assert(body.length <= MAX_FRAME, "Request exceeds guest frame budget");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    new Uint8Array(inbox, 8).set(frame);
    Atomics.store(state, 1, 0);
    Atomics.store(state, 0, frame.length);
    Atomics.notify(state, 0);
  };
  return {
    async request(method, params = null) {
      assert(!closed, "Host is closed");
      if (failure) throw failure;
      const id = ++nextId;
      const waiter = Promise.withResolvers();
      const timer = setTimeout(() => waiter.reject(new Error(`${method} exceeded ${TIMEOUT} ms`)), TIMEOUT);
      pending.set(id, waiter);
      try {
        send({ jsonrpc: "2.0", id, method, params });
        return await waiter.promise;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    async ready() {
      return await Promise.race([
        ready.promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Guest startup timed out")), TIMEOUT);
          ready.promise.finally(() => clearTimeout(timer)).catch(fail);
        }),
      ]);
    },
    async close() {
      closed = true;
      Atomics.store(state, 0, -1);
      Atomics.notify(state, 0);
      const timer = setTimeout(() => {
        fail(new Error("Guest did not exit after stdin EOF"));
        if (worker) worker.terminate().catch(fail);
      }, 5000);
      try {
        await completion;
        if (failure) throw failure;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Descriptive distributions; p95 is nearest rank and no samples are trimmed. */
export function stats(values) {
  assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs: (sorted[middle] + sorted[Math.ceil(sorted.length / 2) - 1]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

/** Retain timer drift through the first tick after the measured work ends. */
export function loopProbe(periodMs = 10) {
  assert(Number.isSafeInteger(periodMs) && periodMs > 0 && periodMs <= 2_147_483_647);
  const started = performance.now();
  let previous = started;
  let activeEndMs;
  const ticks = [];
  const finished = Promise.withResolvers();
  const timer = setInterval(() => {
    const now = performance.now();
    ticks.push({
      atMs: now - started,
      delayMs: Math.max(0, now - previous - periodMs),
    });
    previous = now;
    if (activeEndMs !== undefined) {
      clearInterval(timer);
      finished.resolve({
        periodMs,
        activeEndMs,
        ticks,
        maxDelayMs: Math.max(...ticks.map((tick) => tick.delayMs)),
      });
    }
  }, periodMs);
  return {
    stop() {
      activeEndMs ??= performance.now() - started;
      return finished.promise;
    },
  };
}

async function session(module, workload, placement, block, samples, report) {
  const { files, line } = fixture(workload.name, workload.size);
  const guest = await host(module, files, placement);
  const record = { workload: workload.name, placement, block, samples: [] };
  report.sessions.push(record);
  try {
    record.guestThreadId = await guest.ready();
    assert.equal(record.guestThreadId === 0, placement === "jspi");
    await guest.request("initialize", {
      capabilities: {},
      rootUri: "file:///workspace",
      initializationOptions: {
        pythonVersion: [3, 14, 0],
        pythonPlatform: "linux",
        searchPaths: ["/workspace"],
      },
    });
    for (const name of ["shared.py", "app.py"]) {
      await guest.request("textDocument/didOpen", {
        textDocument: {
          uri: `file:///workspace/${name}`,
          languageId: "python",
          version: 1,
          text: files.get(name),
        },
      });
    }
    for (let iteration = 0; iteration < samples + 2; iteration++) {
      const revision = iteration + 1;
      const probe = loopProbe();
      const started = performance.now();
      const sample = {
        iteration,
        warmup: iteration < 2,
        revision,
        status: "failed",
      };
      record.samples.push(sample);
      try {
        await guest.request("textDocument/didChange", {
          textDocument: { uri: "file:///workspace/shared.py", version: revision + 1 },
          contentChanges: [{ text: seedSource(revision) }],
        });
        sample.snapshot = await guest.request("typeServer/getSnapshot");
        const type = await guest.request("typeServer/getComputedType", {
          snapshot: sample.snapshot,
          arg: {
            uri: "file:///workspace/app.py",
            range: { start: { line, character: 0 }, end: { line, character: 6 } },
          },
        });
        sample.literalValue = type?.literalValue;
        sample.typeKind = type?.kind;
        assert(Number.isSafeInteger(sample.snapshot) && sample.snapshot > 0, "Invalid snapshot");
        assert.equal(type?.kind, 3, "Expected a class type, not Any/Unknown");
        assert.equal(type.literalValue, revision, "Incorrect or stale result after edit");
        sample.status = "passed";
      } finally {
        sample.elapsedMs = performance.now() - started;
        sample.eventLoop = await probe.stop();
      }
    }
    await guest.request("shutdown");
  } finally {
    await guest.close();
  }
}

async function main() {
  assert.equal(typeof WebAssembly.Suspending, "function", "Run Node with --experimental-wasm-jspi");
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "12" },
      blocks: { type: "string", default: "2" },
      output: { type: "string" },
    },
  });
  for (const key of ["samples", "blocks"]) {
    assert(/^[1-9][0-9]*$/.test(values[key]) && Number(values[key]) <= 1000, `${key} must be an integer in 1..1000`);
  }
  const inputHashes = await suiteHashes();
  const { bytes, tools } = await buildArtifacts();
  assert.deepEqual(await suiteHashes(), inputHashes, "Suite inputs changed during build");
  const module = await WebAssembly.compile(bytes);
  const output = path.resolve(ROOT, values.output ?? path.join("target", `wasi-placement-${Date.now()}`));
  await mkdir(output, { recursive: false });
  const report = {
    schema: "pyrefly-wasi-placement/v1",
    status: "running",
    startedAt: new Date().toISOString(),
    sourceRevision: command("git", ["rev-parse", "HEAD"]),
    suiteHashes: inputHashes,
    guestSha256: createHash("sha256").update(bytes).digest("hex"),
    lockSha256: createHash("sha256")
      .update(await readFile(path.join(ROOT, "Cargo.lock")))
      .digest("hex"),
    scriptSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    buildScriptSha256: createHash("sha256")
      .update(await readFile(new URL("build.mjs", import.meta.url)))
      .digest("hex"),
    npmLockSha256: createHash("sha256")
      .update(await readFile(new URL("package-lock.json", import.meta.url)))
      .digest("hex"),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      ...tools,
    },
    boundary:
      "didChange through getSnapshot and validated getComputedType; 10 ms driving-thread timer drift through the first post-sequence drain tick",
    warmupsPerSession: 2,
    samplesPerSession: Number(values.samples),
    blocks: Number(values.blocks),
    workloads: WORKLOADS.map((workload) => ({
      ...workload,
      fixtureSha256: createHash("sha256")
        .update(JSON.stringify([...fixture(workload.name, workload.size).files]))
        .digest("hex"),
    })),
    sessions: [],
    summary: [],
  };
  try {
    for (const workload of WORKLOADS) {
      for (let block = 0; block < report.blocks; block++) {
        for (const placement of block % 2 ? ["jspi", "worker"] : ["worker", "jspi"]) {
          console.log(`${workload.name}: block ${block + 1}, ${placement}`);
          await session(module, workload, placement, block, report.samplesPerSession, report);
        }
      }
      for (const placement of ["worker", "jspi"]) {
        const samples = report.sessions
          .filter((s) => s.workload === workload.name && s.placement === placement)
          .flatMap((s) => s.samples.filter((sample) => !sample.warmup));
        report.summary.push({
          workload: workload.name,
          placement,
          editToType: stats(samples.map((s) => s.elapsedMs)),
          eventLoopDelay: stats(samples.map((s) => s.eventLoop.maxDelayMs)),
        });
      }
    }
    assert.deepEqual(await suiteHashes(), inputHashes, "Suite inputs changed during measurement");
    report.status = "passed";
    console.table(
      report.summary.map((s) => ({
        workload: s.workload,
        placement: s.placement,
        samples: s.editToType.count,
        "edit-to-type median ms": s.editToType.medianMs.toFixed(3),
        "edit-to-type p95 ms": s.editToType.p95Ms.toFixed(3),
        "loop-delay median ms": s.eventLoopDelay.medianMs.toFixed(3),
        "loop-delay p95 ms": s.eventLoopDelay.p95Ms.toFixed(3),
      }))
    );
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    throw error;
  } finally {
    const result = path.join(output, "results.json");
    await writeFile(result, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`Raw results: ${result}`);
  }
}

if (!isMainThread) {
  runGuest(workerData, (message) => parentPort.postMessage(message)).then(
    () => parentPort.close(),
    (error) => {
      throw error;
    }
  );
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
