// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { fixture, frameReader, host, stats } from "./benchmark.mjs";
import { buildArtifacts, command, ROOT, sha256, suiteHashes } from "./build.mjs";
import { bounded, childEnvironment, exited, startResources } from "./resources.mjs";

export const ARMS = ["native-default", "native-one-worker", "wasi-worker"];
const MAX_BODY = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  assert(body.length <= MAX_BODY, "Request exceeds frame budget");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export function fixtureHash(files) {
  return sha256(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Native stdio and the existing Worker host use the suite's same frame decoder. */
export class StdioClient {
  constructor(child, timeout = 30_000) {
    this.child = child;
    this.timeout = timeout;
    this.pending = new Map();
    this.messages = [];
    this.nextId = 0;
    this.outputBytes = 0;
    const decode = frameReader((message) => this.receive(message));
    child.stdout.on("data", (bytes) => {
      if (this.failure) return;
      try {
        this.outputBytes += bytes.length;
        assert(this.outputBytes <= MAX_OUTPUT, "Backend output budget exceeded");
        decode(bytes);
      } catch (error) {
        this.fail(error);
      }
    });
    child.stdout.on("end", () => {
      try {
        decode.end();
      } catch (error) {
        this.fail(error);
      }
      if (this.pending.size) this.fail(new Error("Backend ended with pending requests"));
    });
    child.stdout.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
  }

  fail(error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  receive(message) {
    this.messages.push({ direction: "in", atMs: performance.now(), message });
    assert.equal(message.jsonrpc, "2.0");
    if (message.method) {
      if (message.id !== undefined) {
        let result;
        if (message.method === "workspace/configuration") {
          result = message.params.items.map(() => ({}));
        } else {
          assert(
            ["client/registerCapability", "window/workDoneProgress/create"].includes(message.method),
            `Unsupported client request: ${message.method}`
          );
          result = null;
        }
        this.write({ jsonrpc: "2.0", id: message.id, result });
      } else if (message.method === "textDocument/publishDiagnostics") {
        for (const diagnostic of message.params.diagnostics) {
          assert(
            diagnostic.code === "unused-import" && diagnostic.severity === 4,
            `Backend reported unexpected Python diagnostics: ${JSON.stringify(diagnostic)}`
          );
        }
      } else {
        assert.equal(message.method, "typeServer/snapshotChanged", "Unexpected backend notification");
      }
      return;
    }
    const waiter = this.pending.get(message.id);
    assert(waiter, `Uncorrelated response: ${message.id}`);
    assert(Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"));
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.messages.push({ direction: "out", atMs: performance.now(), message });
    this.child.stdin.write(frame(message));
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params = null) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${method} timed out`)), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }
}

export function optionsFrom(args) {
  const { values } = parseArgs({
    args,
    options: {
      samples: { type: "string", default: "10" },
      blocks: { type: "string", default: "3" },
      size: { type: "string", default: "20" },
      output: { type: "string" },
      python: { type: "string", default: "python" },
      "no-sample": { type: "boolean", default: false },
    },
  });
  for (const [name, maximum] of [
    ["samples", 1000],
    ["blocks", 10],
    ["size", 500],
  ]) {
    assert(
      /^[1-9][0-9]*$/.test(values[name]) && Number(values[name]) <= maximum,
      `${name} must be an integer in 1..${maximum}`
    );
    values[name] = Number(values[name]);
  }
  return values;
}

export function assertAnswer(type) {
  assert.equal(type?.kind, 3, "Expected a class type, not Any/Unknown");
  assert.equal(type.literalValue, 0, "Incorrect saved-file Literal value");
  assert.equal(type.declaration?.name, "int", "Expected builtin int");
  assert.equal(type.declaration.kind, 0, "Expected a source declaration");
  assert(Number.isInteger(type.flags) && (type.flags & 2) !== 0, "Expected instance flags");
  const uri = new URL(type.declaration.node?.uri);
  assert.equal(uri.protocol, "file:");
  assert.equal(decodeURIComponent(uri.pathname).split("/").at(-1), "builtins.pyi");
}

async function treeHash(root, excluded = new Set()) {
  const entries = [];
  const visit = async (relative) => {
    const names = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = path.join(relative, entry.name);
      if (excluded.has(name.replaceAll("\\", "/"))) continue;
      if (entry.isDirectory()) await visit(name);
      else {
        assert(entry.isFile(), "Stub archive must contain regular files");
        entries.push([name.replaceAll("\\", "/"), sha256(await readFile(path.join(root, name)))]);
      }
    }
  };
  await visit("");
  return { files: entries.length, sha256: sha256(JSON.stringify(entries)) };
}

/** Host the suite's existing in-memory WASI Worker in a separately sampled process. */
async function wasiProcess(wasm, workspace) {
  const files = new Map();
  for (const name of (await readdir(workspace)).filter((name) => name.endsWith(".py")).sort()) {
    files.set(name, await readFile(path.join(workspace, name), "utf8"));
  }
  const guest = await host(await WebAssembly.compile(await readFile(wasm)), files, "worker");
  const workerId = await guest.ready();
  process.send({ kind: "ready", workerId, inputSha256: fixtureHash(files) });
  let exitRequested = false;
  let sequence = Promise.resolve();
  let failure;
  const fail = (error) => {
    failure ??= error;
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  };
  const decode = frameReader((message) => {
    sequence = sequence.then(async () => {
      assert(!exitRequested, "Message after exit");
      if (message.method === "exit") {
        exitRequested = true;
        return;
      }
      if (message.method === "initialized") return;
      const result = await guest.request(message.method, message.params);
      if (message.id !== undefined) process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result }));
    });
    sequence.catch(fail);
  });
  process.stdin.on("data", (bytes) => {
    try {
      decode(bytes);
    } catch (error) {
      fail(error);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
      process.stdin.once("error", reject);
    });
    decode.end();
    await sequence;
    if (failure) throw failure;
    assert(exitRequested, "Worker host stdin closed without orderly exit");
  } finally {
    await guest.close();
    await new Promise((resolve, reject) =>
      process.send({ kind: "retired", workerId, clean: !failure && exitRequested }, (error) =>
        error ? reject(error) : resolve()
      )
    );
    process.disconnect();
  }
}

async function session(artifacts, workload, arm, block, options, output, typeshed) {
  const directory = path.join(output, `${block + 1}-${arm}`);
  await mkdir(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const diskFiles = new Map(workload.files);
  diskFiles.set(
    "pyrefly.toml",
    'python-version = "3.14"\npython-platform = "linux"\nsearch-path = ["."]\nsite-package-path = []\nskip-interpreter-query = true\ndisable-search-path-heuristics = true\n'
  );
  for (const [name, text] of diskFiles) await writeFile(path.join(workspace, name), text);
  const wasi = arm === "wasi-worker";
  const executable = wasi ? process.execPath : artifacts.native;
  const args = wasi
    ? [SELF, "--wasi-child", artifacts.wasm, workspace]
    : ["--threads", arm === "native-one-worker" ? "1" : "0", "tsp", "--indexing-mode", "none"];
  const record = {
    arm,
    block,
    status: "running",
    samples: [],
    configuredAnalysis: wasi
      ? "Inline portable guest in Node Worker"
      : arm === "native-one-worker"
      ? "One Rayon worker; not inline"
      : "Automatic Rayon pool",
    command: [executable, ...args],
    inputSha256: fixtureHash(workload.files),
    edits: "NOT_MEASURED: unchanged saved-file comparison only",
  };
  const started = performance.now();
  const child = spawn(executable, args, {
    cwd: workspace,
    env: childEnvironment(),
    windowsHide: true,
    stdio: wasi ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
  });
  const exit = exited(child);
  const client = new StdioClient(child);
  const events = [];
  let stderr = "";
  let sampler;
  child.on("message", (event) => events.push(event));
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString("utf8");
    if (stderr.length > 4 * 1024 * 1024) {
      client.fail(new Error("Backend stderr budget exceeded"));
      child.kill();
    }
  });
  try {
    await bounded(
      new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      15_000,
      "Backend spawn"
    );
    record.pid = child.pid;
    record.spawnMs = performance.now() - started;
    if (!options["no-sample"]) {
      sampler = await startResources(child.pid, options.python, path.join(directory, "resources.json"));
    }
    const rootUri = wasi ? "file:///workspace" : pathToFileURL(workspace).href;
    const appUri = wasi ? "file:///workspace/app.py" : pathToFileURL(path.join(workspace, "app.py")).href;
    const initializeAt = performance.now();
    await client.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "generated" }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: wasi
        ? { pythonVersion: [3, 14, 0], pythonPlatform: "linux", searchPaths: ["/workspace"] }
        : undefined,
    });
    record.initializeMs = performance.now() - initializeAt;
    client.notify("initialized", {});
    record.protocol = await client.request("typeServer/getSupportedProtocolVersion");
    for (const name of ["shared.py", "app.py"]) {
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri: wasi ? `file:///workspace/${name}` : pathToFileURL(path.join(workspace, name)).href,
          languageId: "python",
          version: 1,
          text: workload.files.get(name),
        },
      });
    }
    for (let iteration = 0; iteration < options.samples + 3; iteration++) {
      const phase = iteration === 0 ? "first" : iteration < 3 ? "warmup" : "warm";
      const sample = { phase, iteration, status: "failed" };
      record.samples.push(sample);
      const at = performance.now();
      const snapshot = await client.request("typeServer/getSnapshot");
      sample.snapshotMs = performance.now() - at;
      assert(Number.isInteger(snapshot) && snapshot >= 0 && snapshot <= 0x7fffffff, "Invalid TSP snapshot");
      const typeAt = performance.now();
      const type = await client.request("typeServer/getComputedType", {
        snapshot,
        arg: {
          uri: appUri,
          range: {
            start: { line: workload.line, character: 0 },
            end: { line: workload.line, character: 6 },
          },
        },
      });
      sample.typeMs = performance.now() - typeAt;
      sample.elapsedMs = performance.now() - at;
      assertAnswer(type);
      sample.snapshot = snapshot;
      sample.literalValue = type.literalValue;
      sample.status = "passed";
      record.builtinSourceUri ??= type.declaration.node.uri;
      assert.equal(type.declaration.node.uri, record.builtinSourceUri, "Builtin source changed");
      if (iteration === 0) record.launchToFirstCorrectMs = performance.now() - started;
    }
    const shutdownAt = performance.now();
    await client.request("shutdown");
    client.notify("exit", null);
    child.stdin.end();
    record.exit = await bounded(exit, 15_000, "Backend orderly exit");
    record.shutdownMs = performance.now() - shutdownAt;
    assert.equal(record.exit.code, 0, "Backend exited abnormally");
    assert.equal(client.pending.size, 0);
    if (client.failure) throw client.failure;
    if (wasi) {
      const ready = events.find((event) => event.kind === "ready");
      assert(ready && ready.workerId > 0, "Worker identity missing");
      assert.equal(ready.inputSha256, record.inputSha256, "Worker loaded different saved source bytes");
      assert(
        events.some((event) => event.kind === "retired" && event.clean && event.workerId === ready.workerId),
        "Worker retirement not acknowledged"
      );
    } else {
      const nativeRoot = path.dirname(fileURLToPath(record.builtinSourceUri));
      assert(path.basename(nativeRoot).startsWith("pyrefly_bundled_typeshed_"), "Expected native bundled stubs");
      record.stdlib = await treeHash(nativeRoot, new Set(["pyrefly.toml"]));
      assert.deepEqual(record.stdlib, typeshed, "Native and portable stdlib bytes differ");
    }
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.error = error.stack ?? String(error);
    client.fail(error);
    if (child.exitCode === null && child.signalCode === null) {
      record.forcedCleanup = true;
      child.kill();
    }
    try {
      record.exit = await bounded(exit, 10_000, "Failed backend retirement");
    } catch (cleanupError) {
      record.cleanupError = cleanupError.stack ?? String(cleanupError);
    }
  } finally {
    try {
      record.resources = sampler
        ? await sampler.stop()
        : { status: "NOT_MEASURED", reason: "Resource sampling disabled" };
      for (const [name, text] of diskFiles) {
        assert.equal(await readFile(path.join(workspace, name), "utf8"), text, `Disk fixture changed: ${name}`);
      }
    } catch (error) {
      record.status = "failed";
      record.resourceOrIntegrityError = error.stack ?? String(error);
    }
    record.stderr = stderr;
    record.workerEvents = events;
    await writeFile(path.join(directory, "wire.json"), `${JSON.stringify(client.messages, null, 2)}\n`, { flag: "wx" });
    await writeFile(path.join(directory, "result.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  }
  return record;
}

export function summarize(sessions, planned) {
  return ARMS.map((arm) => {
    const all = sessions.filter((session) => session.arm === arm);
    const passed = all.filter((session) => session.status === "passed");
    return {
      arm,
      planned,
      passed: passed.length,
      failed: all.length - passed.length,
      warmSnapshotAndType: passed.length
        ? stats(
            passed.flatMap((session) =>
              session.samples.filter((sample) => sample.phase === "warm").map((sample) => sample.elapsedMs)
            )
          )
        : null,
      launchToFirstCorrect: passed.length ? stats(passed.map((session) => session.launchToFirstCorrectMs)) : null,
      resources: all.map(
        (session) => session.resources ?? { status: "NOT_MEASURED", reason: "Session failed before collection" }
      ),
    };
  });
}

async function main(args) {
  const options = optionsFrom(args);
  const output = path.resolve(ROOT, options.output ?? path.join("target", `native-wasi-${Date.now()}`));
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  const report = {
    schema: "pyrefly-native-wasi/v1",
    status: "running",
    startedAt: new Date().toISOString(),
    sourceRevision: command("git", ["rev-parse", "HEAD"]),
    codeHashes: await suiteHashes(),
    options,
    trackedChangesSha256: sha256(command("git", ["diff", "HEAD", "--binary", "--no-ext-diff"])),
    sourceScope: "SAVED_UNCHANGED_FILES_ONLY",
    sessions: [],
    summary: [],
    boundary: "getSnapshot through getComputedType response decoding; answer assertions outside query clock",
    architecture:
      "Normal native TSP with disk files vs the placement suite's same portable in-memory WASI Worker in a separately sampled Node child; not isolated Wasm or IPC overhead",
    analysis: "Python3.14/linux, explicit no-interpreter native config; one-worker native is not inline",
    diagnosticPolicy:
      "Native unused-import hints (severity4) are expected for the shared fixture and retained in wire logs; every other diagnostic fails",
    sampling: options["no-sample"]
      ? "Disabled"
      : "100ms identity-scoped observer; readiness barrier included in launch-to-first-correct",
    limits:
      "Bounded descriptive saved queries, not edit parity or full-project throughput. No CPU isolation/cold-cache guarantee. OS threads include support/runtime threads, not just analysis workers. Power NOT_MEASURED.",
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "Node default; not inferred from OS thread count",
    },
  };
  try {
    const artifacts = await buildArtifacts(true);
    assert.deepEqual(await suiteHashes(), report.codeHashes, "Suite inputs changed during build");
    assert.equal(
      sha256(command("git", ["diff", "HEAD", "--binary", "--no-ext-diff"])),
      report.trackedChangesSha256,
      "Tracked source changed during paired build"
    );
    report.environment = { ...report.environment, ...artifacts.tools };
    report.artifactHashes = {
      wasm: sha256(artifacts.bytes),
      native: sha256(await readFile(artifacts.native)),
      exporter: sha256(await readFile(artifacts.exporter)),
    };
    report.lockSha256 = sha256(await readFile(path.join(ROOT, "Cargo.lock")));
    const typeshed = path.join(output, "typeshed");
    execFileSync(artifacts.exporter, ["--export-typeshed", typeshed], { encoding: "utf8", env: childEnvironment() });
    report.stdlib = await treeHash(typeshed);
    report.stdlibExclusion = "Native-only generated pyrefly.toml config is not part of the archive";
    const workload = fixture("shared", options.size);
    report.fixture = {
      name: "shared",
      size: options.size,
      pythonFiles: workload.files.size,
      sha256: fixtureHash(workload.files),
      expectedLiteral: 0,
    };
    for (let block = 0; block < options.blocks; block++) {
      for (let index = 0; index < ARMS.length; index++) {
        const arm = ARMS[(index + block) % ARMS.length];
        const record = await session(artifacts, workload, arm, block, options, output, report.stdlib);
        report.sessions.push(record);
        await writeFile(path.join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
        console.log(
          `${record.status}: ${arm}${record.error ? `\n${record.error}` : ""}${
            record.resourceOrIntegrityError ? `\n${record.resourceOrIntegrityError}` : ""
          }`
        );
      }
    }
    assert(
      report.sessions.every(
        (session) => JSON.stringify(session.protocol) === JSON.stringify(report.sessions[0].protocol)
      ),
      "Native/portable protocol versions differ"
    );
    assert.deepEqual(await treeHash(typeshed), report.stdlib, "Exported stdlib changed");
    assert.deepEqual(await suiteHashes(), report.codeHashes, "Suite inputs changed during measurement");
    report.summary = summarize(report.sessions, options.blocks);
    report.status = report.sessions.every((session) => session.status === "passed") ? "passed" : "failed";
    console.table(
      report.summary.map((row) => ({
        arm: row.arm,
        "passed / planned": `${row.passed}/${row.planned}`,
        "warm median ms": row.warmSnapshotAndType?.medianMs ?? "NOT_MEASURED",
        "warm p95 ms": row.warmSnapshotAndType?.p95Ms ?? "NOT_MEASURED",
        "launch to correct ms": row.launchToFirstCorrect?.medianMs ?? "NOT_MEASURED",
        "peak root OS threads": row.resources
          .map((resource) => resource.peakSampledThreads ?? "NOT_MEASURED")
          .join(", "),
        "tree CPU seconds": row.resources
          .map((resource) => resource.observedTreeInterval?.cpuSeconds ?? "NOT_MEASURED")
          .join(", "),
        "peak tree RSS MiB": row.resources
          .map((resource) =>
            typeof resource.peakSampledTreeRssBytes === "number"
              ? (resource.peakSampledTreeRssBytes / 1024 / 1024).toFixed(1)
              : "NOT_MEASURED"
          )
          .join(", "),
      }))
    );
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    await writeFile(path.join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Raw native/WASI results: ${path.join(output, "results.json")}`);
  }
}

if (process.argv[2] === "--wasi-child") {
  wasiProcess(process.argv[3], process.argv[4]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
