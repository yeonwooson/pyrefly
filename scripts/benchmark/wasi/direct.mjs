// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { fixture, host, loopProbe, stats } from "./benchmark.mjs";
import { buildArtifacts, command, ROOT, sha256, suiteHashes } from "./build.mjs";
import { directHost } from "./direct-host.mjs";
import { fixtureHash, StdioClient, treeHash } from "./native.mjs";
import { bounded, childEnvironment, exited } from "./resources.mjs";

export const ARMS = ["direct-wasm", "command-jspi", "native-rpc"];

export function optionsFrom(args) {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string" },
      blocks: { type: "string", default: "3" },
      samples: { type: "string", default: "24" },
      edits: { type: "string", default: "4" },
      size: { type: "string", default: "20" },
    },
  });
  for (const [name, maximum] of [
    ["blocks", 6],
    ["samples", 200],
    ["edits", 20],
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

/** Keep the same import workload, and edit only this document for native parity. */
export function workload(size, revision = 0) {
  const generated = fixture("shared", size);
  const text = `from typing import Literal\n${generated.files.get("app.py")}`.replace(
    "answer = seed",
    `answer: Literal[${revision}] = ${revision}`
  );
  generated.files.set("app.py", text);
  return { files: generated.files, line: generated.line + 1, text };
}

export function assertAnswer(type, expected) {
  assert.equal(type?.kind, 3, "Expected Class, never null/Any/Unknown");
  assert.equal(type.literalValue, expected, "Wrong or stale literal");
  assert.equal(type.declaration?.name, "int");
  assert.equal(type.declaration.kind, 0);
  assert(Number.isInteger(type.flags) && (type.flags & 2) !== 0, "Expected instance flags");
  const uri = new URL(type.declaration.node?.uri);
  assert.equal(uri.protocol, "file:");
  assert.equal(decodeURIComponent(uri.pathname).split("/").at(-1), "builtins.pyi");
}

async function nativeHost(binary, workspace, record) {
  const child = spawn(binary, ["--threads", "0", "tsp", "--indexing-mode", "none"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: childEnvironment(),
  });
  const exit = exited(child);
  const client = new StdioClient(child);
  record.stderr = "";
  record.pid = child.pid;
  child.stderr.on("data", (bytes) => {
    record.stderr += bytes.toString("utf8");
    if (record.stderr.length > 4 * 1024 * 1024) {
      client.fail(new Error("Native stderr budget exceeded"));
      child.kill();
    }
  });
  await bounded(
    new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }),
    15_000,
    "Native spawn"
  );
  record.pid = child.pid;
  let orderly = false;
  return {
    request: (method, params) => client.request(method, params),
    async open(params) {
      client.notify("textDocument/didOpen", params);
    },
    async change(params) {
      client.notify("textDocument/didChange", params);
    },
    initialized() {
      client.notify("initialized", {});
    },
    async close() {
      try {
        if (!client.failure) {
          await client.request("shutdown");
          client.notify("exit", null);
          child.stdin.end();
          record.exit = await bounded(exit, 10_000, "Native orderly exit");
          assert.equal(record.exit.code, 0, "Native exit was not clean");
          if (client.failure) throw client.failure;
          assert.equal(client.pending.size, 0);
          orderly = true;
        }
      } finally {
        if (!orderly && child.exitCode === null && child.signalCode === null) {
          record.forcedCleanup = true;
          child.kill();
        }
        record.exit ??= await bounded(exit, 10_000, "Native cleanup");
        record.wire = client.messages;
      }
      assert(orderly, "Native session required abnormal cleanup");
    },
  };
}

async function session(arm, block, options, inputs, modules, output, stdlib) {
  const directory = path.join(output, `${block + 1}-${arm}`);
  await mkdir(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const generated = workload(options.size);
  for (const [name, text] of generated.files) await writeFile(path.join(workspace, name), text);
  const config =
    'python-version = "3.14"\npython-platform = "linux"\nsearch-path = ["."]\nsite-package-path = []\nskip-interpreter-query = true\ndisable-search-path-heuristics = true\n';
  await writeFile(path.join(workspace, "pyrefly.toml"), config);
  const record = {
    arm,
    block,
    status: "running",
    samples: [],
    inputSha256: fixtureHash(generated.files),
    warmups: 2,
    measurement: "Driving-thread getSnapshot + computed-type sequence; semantic assertions outside the request timer",
  };
  const started = performance.now();
  const startupProbe = loopProbe();
  let startupStopped = false;
  let backend;
  let lastSnapshot;
  let documentVersion = 1;
  try {
    if (arm === "direct-wasm") {
      const direct = await directHost(modules.direct, generated.files);
      backend = {
        request: direct.request,
        open: (params) => direct.request("textDocument/didOpen", params),
        change: (params) => direct.request("textDocument/didChange", params),
        initialized() {},
        close: direct.close,
      };
    } else if (arm === "command-jspi") {
      const guest = await host(modules.command, generated.files, "jspi");
      assert.equal(await guest.ready(), 0, "Command guest is not on the driving thread");
      backend = {
        request: guest.request,
        open: (params) => guest.request("textDocument/didOpen", params),
        change: (params) => guest.request("textDocument/didChange", params),
        initialized() {},
        async close() {
          try {
            await guest.request("shutdown");
          } finally {
            await guest.close();
          }
        },
      };
    } else {
      backend = await nativeHost(inputs.native, workspace, record);
    }
    record.hostCreateMs = performance.now() - started;
    const native = arm === "native-rpc";
    const rootUri = native ? pathToFileURL(workspace).href : "file:///workspace";
    const appUri = native ? pathToFileURL(path.join(workspace, "app.py")).href : "file:///workspace/app.py";
    const initializeAt = performance.now();
    await backend.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "generated" }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: native
        ? undefined
        : { pythonVersion: [3, 14, 0], pythonPlatform: "linux", searchPaths: ["/workspace"] },
    });
    backend.initialized();
    record.initializeMs = performance.now() - initializeAt;
    record.protocol = await backend.request("typeServer/getSupportedProtocolVersion");
    const openAt = performance.now();
    for (const name of ["shared.py", "app.py"]) {
      await backend.open({
        textDocument: {
          uri: native ? pathToFileURL(path.join(workspace, name)).href : `file:///workspace/${name}`,
          version: 1,
          languageId: "python",
          text: generated.files.get(name),
        },
      });
    }
    record.openSubmitOrAckMs = performance.now() - openAt;
    const query = async (phase, expected, changedText) => {
      const sample = { phase, expected, status: "failed" };
      record.samples.push(sample);
      const probe = loopProbe();
      const requestStart = performance.now();
      try {
        if (changedText !== undefined) {
          await backend.change({
            textDocument: { uri: appUri, version: ++documentVersion },
            contentChanges: [{ text: changedText }],
          });
        }
        const snapshotAt = performance.now();
        const snapshot = await backend.request("typeServer/getSnapshot");
        sample.snapshotMs = performance.now() - snapshotAt;
        assert(Number.isInteger(snapshot) && snapshot >= 0 && snapshot <= 0x7fffffff, "Invalid snapshot");
        if (changedText !== undefined) assert(snapshot > lastSnapshot, "Edit did not advance snapshot");
        const typeAt = performance.now();
        const type = await backend.request("typeServer/getComputedType", {
          snapshot,
          arg: {
            uri: appUri,
            range: {
              start: { line: generated.line, character: 0 },
              end: { line: generated.line, character: 6 },
            },
          },
        });
        sample.typeMs = performance.now() - typeAt;
        sample.elapsedMs = performance.now() - requestStart;
        assertAnswer(type, expected);
        sample.literalValue = type.literalValue;
        sample.snapshot = snapshot;
        record.builtinSourceUri ??= type.declaration.node.uri;
        lastSnapshot = snapshot;
        sample.status = "passed";
        sample.sinceLaunchMs = performance.now() - started;
      } finally {
        sample.elapsedOnFailureMs = sample.status === "failed" ? performance.now() - requestStart : undefined;
        sample.eventLoop = await probe.stop();
      }
    };
    await query("first", 0);
    record.launchToFirstCorrectMs = record.samples[0].sinceLaunchMs;
    record.launchMetricIncludesHeartbeatDrain = false;
    record.startupEventLoop = await startupProbe.stop();
    startupStopped = true;
    for (let i = 0; i < 2; i++) await query("warmup", 0);
    for (let i = 0; i < options.samples; i++) await query("warm", 0);
    for (let revision = 1; revision <= options.edits; revision++) {
      await query("edit", revision, workload(options.size, revision).text);
    }
    await query("restore", 0, generated.text);
    if (native) {
      const cached = path.dirname(fileURLToPath(record.builtinSourceUri));
      assert(path.basename(cached).startsWith("pyrefly_bundled_typeshed_"));
      record.stdlib = await treeHash(cached, new Set(["pyrefly.toml"]));
      assert.deepEqual(record.stdlib, stdlib, "Native and portable stdlib archive differs");
    }
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.error = error.stack ?? String(error);
  } finally {
    if (!startupStopped) record.startupEventLoop = await startupProbe.stop();
    if (backend) {
      const closeAt = performance.now();
      const shutdownProbe = loopProbe();
      try {
        await backend.close();
        record.shutdownMs = performance.now() - closeAt;
        record.retired = true;
      } catch (error) {
        record.status = "failed";
        record.cleanupError = error.stack ?? String(error);
      } finally {
        record.shutdownEventLoop = await shutdownProbe.stop();
      }
    }
    for (const [name, text] of generated.files) {
      assert.equal(await readFile(path.join(workspace, name), "utf8"), text, "Saved fixture bytes changed");
    }
    assert.equal(await readFile(path.join(workspace, "pyrefly.toml"), "utf8"), config);
    await writeFile(path.join(directory, "result.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  }
  return record;
}

export function summarize(sessions, planned) {
  return ARMS.map((arm) => {
    const all = sessions.filter((row) => row.arm === arm);
    const passed = all.filter((row) => row.status === "passed");
    const values = (phase, field) =>
      passed.flatMap((row) => row.samples.filter((sample) => sample.phase === phase).map((sample) => field(sample)));
    return {
      arm,
      planned,
      passed: passed.length,
      failed: all.length - passed.length,
      first: passed.length ? stats(values("first", (sample) => sample.elapsedMs)) : null,
      warm: passed.length ? stats(values("warm", (sample) => sample.elapsedMs)) : null,
      edit: passed.length ? stats(values("edit", (sample) => sample.elapsedMs)) : null,
      warmLoopDelay: passed.length ? stats(values("warm", (sample) => sample.eventLoop.maxDelayMs)) : null,
      editLoopDelay: passed.length ? stats(values("edit", (sample) => sample.eventLoop.maxDelayMs)) : null,
      launchToFirstCorrect: passed.length ? stats(passed.map((row) => row.launchToFirstCorrectMs)) : null,
    };
  });
}

async function main(args) {
  assert.equal(typeof WebAssembly.Suspending, "function", "Run Node with --experimental-wasm-jspi");
  const options = optionsFrom(args);
  const output = path.resolve(ROOT, options.output ?? path.join("target", `direct-call-${Date.now()}`));
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const codeHashes = await suiteHashes();
  const rustSource = await readFile(new URL("../../../pyrefly/examples/wasi_direct.rs", import.meta.url));
  const sourcePatch = command("git", ["diff", "--binary", "--no-ext-diff", "HEAD"]);
  const report = {
    schema: "pyrefly-direct-call-experiment/v1",
    status: "running",
    createdAt: new Date().toISOString(),
    options,
    sourceRevision: command("git", ["rev-parse", "HEAD"]),
    codeHashes,
    directRustSha256: sha256(rustSource),
    trackedPatchSha256: sha256(sourcePatch),
    cargoLockSha256: sha256(await readFile(path.join(ROOT, "Cargo.lock"))),
    boundary:
      "Direct exported reactor functions with JSON buffers vs main-thread command JSON-RPC/stdio/JSPI vs normal native process TSP. JSON is not removed by the direct ABI.",
    limits:
      "Same Rust engine/session source but separate reactor/command artifacts; native has a different dispatcher/thread model/disk filesystem. Not isolated Wasm, transport-only, zero-copy, preemptive execution or production qualification.",
    startup:
      "Builds excluded; Wasm compile separately recorded and shared across sessions; host/initialize/open/first-correct result/shutdown recorded. Heartbeat drains are outside request and launch-to-first-correct clocks. No cold OS cache guarantee.",
    updateBoundary:
      "Own-document unsaved edit + snapshot + exact computed type; native sends notification, portable command acknowledges it, direct invokes a function. Cross-module native freshness is not qualified.",
    eventLoop:
      "10ms driving-thread heartbeat through first post-sequence drain tick; OS granularity/host load contribute. Request deadlines cannot preempt synchronous Wasm.",
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
    },
    fixture: {
      sharedModules: options.size,
      pythonFiles: options.size + 2,
      sha256: fixtureHash(workload(options.size).files),
    },
    sessions: [],
    summary: [],
  };
  try {
    const artifacts = await buildArtifacts(true, true);
    assert.deepEqual(await suiteHashes(), codeHashes, "Suite changed during build");
    assert.equal(
      sha256(await readFile(new URL("../../../pyrefly/examples/wasi_direct.rs", import.meta.url))),
      report.directRustSha256
    );
    const directBytes = await readFile(artifacts.direct);
    report.artifactHashes = {
      command: sha256(artifacts.bytes),
      direct: sha256(directBytes),
      native: sha256(await readFile(artifacts.native)),
      exporter: sha256(await readFile(artifacts.exporter)),
    };
    report.environment = { ...report.environment, ...artifacts.tools };
    const compileAt = performance.now();
    const direct = await WebAssembly.compile(directBytes);
    report.directCompileMs = performance.now() - compileAt;
    const commandAt = performance.now();
    const commandModule = await WebAssembly.compile(artifacts.bytes);
    report.commandCompileMs = performance.now() - commandAt;
    report.directExports = WebAssembly.Module.exports(direct);
    report.directImports = WebAssembly.Module.imports(direct);
    assert(report.directExports.some((entry) => entry.name === "direct_query"));
    report.moduleInitialization = report.directExports.some((entry) => entry.name === "_initialize")
      ? "WASI shim binds the instance and calls its _initialize export"
      : "Rust cdylib has no _initialize export; WASI shim binds the instance, and direct_initialize creates its session";
    assert(
      !report.directExports.some((entry) => entry.name === "_start"),
      "Direct artifact must not start a command loop"
    );
    const typeshed = path.join(output, "typeshed");
    execFileSync(artifacts.exporter, ["--export-typeshed", typeshed], { env: childEnvironment(), encoding: "utf8" });
    report.stdlib = await treeHash(typeshed);
    const modules = { direct, command: commandModule };
    for (let block = 0; block < options.blocks; block++) {
      for (let index = 0; index < ARMS.length; index++) {
        const arm = ARMS[(index + block) % ARMS.length];
        const result = await session(arm, block, options, artifacts, modules, output, report.stdlib);
        report.sessions.push(result);
        await writeFile(path.join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
        console.log(
          `${result.status}: ${arm}${result.error ? `\n${result.error}` : ""}${
            result.cleanupError ? `\n${result.cleanupError}` : ""
          }`
        );
      }
    }
    assert.deepEqual(await suiteHashes(), codeHashes, "Suite changed during measurement");
    assert.equal(
      sha256(await readFile(new URL("../../../pyrefly/examples/wasi_direct.rs", import.meta.url))),
      report.directRustSha256,
      "Reactor source changed during measurement"
    );
    assert.equal(sha256(command("git", ["diff", "--binary", "--no-ext-diff", "HEAD"])), report.trackedPatchSha256);
    assert.equal(sha256(await readFile(path.join(ROOT, "Cargo.lock"))), report.cargoLockSha256);
    assert.deepEqual(
      {
        command: sha256(await readFile(artifacts.wasm)),
        direct: sha256(await readFile(artifacts.direct)),
        native: sha256(await readFile(artifacts.native)),
        exporter: sha256(await readFile(artifacts.exporter)),
      },
      report.artifactHashes,
      "Built artifacts changed during measurement"
    );
    assert.deepEqual(await treeHash(typeshed), report.stdlib);
    assert(
      report.sessions.every((row) => row.protocol === report.sessions[0].protocol),
      "Protocol versions differ"
    );
    report.summary = summarize(report.sessions, options.blocks);
    report.status = report.sessions.every((row) => row.status === "passed" && row.retired) ? "passed" : "failed";
    console.table(
      report.summary.map((row) => ({
        arm: row.arm,
        "passed / planned": `${row.passed}/${row.planned}`,
        "warm median ms": row.warm?.medianMs ?? "NOT_MEASURED",
        "edit median ms": row.edit?.medianMs ?? "NOT_MEASURED",
        "edit loop p95 ms": row.editLoopDelay?.p95Ms ?? "NOT_MEASURED",
      }))
    );
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    await writeFile(path.join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Direct-call results: ${path.join(output, "results.json")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
