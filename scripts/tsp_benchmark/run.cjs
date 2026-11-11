"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { fileURLToPath, pathToFileURL } = require("node:url");

const {
  RpcClient,
  assertSnapshot,
  assertType,
  stats,
} = require("./protocol.cjs");

const ENGINE_REVISION = "2a8196baa523a21620b66c243e7778a64c211b11";
const ARMS = ["native-default", "native-one-worker", "wasi-worker"];
const LABELS = {
  "native-default": "Native Pyrefly, automatic Rayon pool",
  "native-one-worker": "Native Pyrefly, one Rayon worker (not inline)",
  "wasi-worker":
    "WASI Pyrefly portable dispatcher, Node Worker, inline analysis",
};

function backendEnvironment(environment = process.env) {
  const allowed = [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "UV_THREADPOOL_SIZE",
  ];
  return {
    ...Object.fromEntries(
      allowed
        .filter((name) => environment[name] !== undefined)
        .map((name) => [name, environment[name]])
    ),
    RUST_BACKTRACE: "0",
  };
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function treeHash(root, excluded = new Set()) {
  const entries = [];
  function visit(relative) {
    const directory = path.join(root, relative);
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = path.join(relative, entry.name);
      if (excluded.has(name.replaceAll("\\", "/"))) continue;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        entries.push([
          name.replaceAll("\\", "/"),
          hash(fs.readFileSync(path.join(root, name))),
        ]);
      else
        throw new Error(
          "Typeshed must contain only regular files and directories"
        );
    }
  }
  visit("");
  return { files: entries.length, sha256: hash(JSON.stringify(entries)) };
}

function checkedCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr?.slice(-5000)}`
    );
  return result.stdout.trim();
}

function argumentsFrom(argv) {
  const values = {
    smoke: false,
    build: false,
    sample: true,
    checkEdits: false,
    repeats: 3,
    warmups: 3,
    queries: 10,
    modules: 3,
    python: "python",
  };
  const paths = new Set(["source", "native", "wasm", "exporter", "out"]);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--smoke") values.smoke = true;
    else if (key === "--build") values.build = true;
    else if (key === "--no-sample") values.sample = false;
    else if (key === "--check-edits") values.checkEdits = true;
    else {
      const name = key.replace(/^--/, "");
      if (
        !key.startsWith("--") ||
        ![
          ...paths,
          "repeats",
          "warmups",
          "queries",
          "modules",
          "python",
        ].includes(name)
      ) {
        throw new Error(`Unknown option ${key}`);
      }
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${key}`);
      values[name] = paths.has(name)
        ? path.resolve(value)
        : name === "python"
        ? value
        : Number(value);
    }
  }
  for (const [name, min, max] of [
    ["repeats", 1, 10],
    ["warmups", 0, 20],
    ["queries", 1, 100],
    ["modules", 3, 500],
  ]) {
    if (
      !Number.isInteger(values[name]) ||
      values[name] < min ||
      values[name] > max
    )
      throw new Error(`Invalid ${name}`);
  }
  if (!values.source || !values.out)
    throw new Error(
      "Required: --source <public-engine-checkout> --out <new-directory>"
    );
  if (
    values.build &&
    ["native", "wasm", "exporter"].some((name) => values[name] !== undefined)
  )
    throw new Error(
      "--build cannot be combined with artifact overrides; use the outputs built by this run"
    );
  if (values.smoke)
    Object.assign(values, { repeats: 1, warmups: 1, queries: 3, modules: 3 });
  return values;
}

function fixture(directory, modules) {
  fs.mkdirSync(directory);
  const leaf = "def get_value() -> int:\n    return 7\n";
  const dirty = 'def get_value() -> str:\n    return "edited"\n';
  const sources = new Map([["m0000.py", leaf]]);
  for (let index = 1; index < modules - 1; index++) {
    sources.set(
      `m${String(index).padStart(4, "0")}.py`,
      `from m${String(index - 1).padStart(4, "0")} import get_value\n`
    );
  }
  const main = `from m${String(modules - 2).padStart(
    4,
    "0"
  )} import get_value\nvalue = get_value()\nvalue\n`;
  sources.set("main.py", main);
  sources.set(
    "pyrefly.toml",
    'python-version = "3.13"\npython-platform = "linux"\nsearch-path = ["."]\nsite-package-path = []\nskip-interpreter-query = true\ndisable-search-path-heuristics = true\n'
  );
  for (const [name, content] of sources)
    fs.writeFileSync(path.join(directory, name), content);
  return {
    leaf,
    dirty,
    main,
    sources: [...sources].map(([name, text]) => ({ name, sha256: hash(text) })),
  };
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function startSampler(pid, python, file) {
  const child = spawn(
    python,
    [path.join(__dirname, "sample.py"), "--pid", String(pid)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: backendEnvironment(),
    }
  );
  const exit = exited(child);
  let text = "";
  let stderr = "";
  let summary;
  let protocolFailure;
  let readiness;
  const raw = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (data) => {
    text += data.toString("utf8");
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) break;
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        raw.push(message);
        if (message.kind === "ready") {
          readiness = message;
          resolveReady(message);
        }
        if (message.kind === "summary") summary = message;
      } catch (error) {
        protocolFailure ??= error;
        rejectReady(error);
      }
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString("utf8");
  });
  exit
    .then((result) => {
      if (result.code !== 0 || !readiness) {
        protocolFailure ??= new Error(
          `Resource sampler failed or exited before ready: ${stderr}`
        );
        rejectReady(protocolFailure);
      }
    })
    .catch(rejectReady);
  try {
    await bounded(ready, 15000, "Resource sampler initialization");
  } catch (error) {
    child.kill();
    await bounded(exit, 5000, "Sampler failure retirement");
    throw error;
  }
  return {
    child,
    stop: async () => {
      let exitResult;
      try {
        if (child.exitCode === null) child.stdin.end('{"command":"stop"}\n');
        exitResult = await bounded(exit, 10000, "Resource sampler exit");
      } catch (error) {
        child.kill();
        await bounded(exit, 5000, "Sampler timeout retirement");
        throw error;
      } finally {
        if (file)
          fs.writeFileSync(
            file,
            JSON.stringify({ raw, stderr, exit: exitResult }, null, 2) + "\n",
            { flag: "wx" }
          );
      }
      if (protocolFailure) throw protocolFailure;
      if (text.trim()) throw new Error("Truncated resource sampler record");
      if (exitResult.code !== 0)
        throw new Error(`Resource sampler failed: ${stderr}`);
      if (!summary && readiness.status !== "NOT_MEASURED")
        throw new Error("Resource sampler omitted its summary");
      const result = summary ?? {
        status: "NOT_MEASURED",
        reason: raw.find((row) => row.kind === "ready")?.reason,
      };
      if (result.status === "MEASURED")
        assert.equal(
          result.finalObservedProcesses,
          0,
          "Observed backend process survived cleanup"
        );
      return result;
    },
  };
}

async function runSession(options, arm, directory, typeshed) {
  fs.mkdirSync(directory);
  const workspace = path.join(directory, "workspace");
  const files = fixture(workspace, options.modules);
  fs.writeFileSync(
    path.join(directory, "fixture.json"),
    JSON.stringify(files.sources, null, 2) + "\n"
  );
  const isWasi = arm === "wasi-worker";
  const args = isWasi
    ? [path.join(__dirname, "wasi-host.cjs"), options.wasm, workspace, typeshed]
    : [
        "--threads",
        arm === "native-one-worker" ? "1" : "0",
        "tsp",
        "--indexing-mode",
        "none",
      ];
  const record = {
    arm,
    label: LABELS[arm],
    status: "STARTED",
    command: [isWasi ? process.execPath : options.native, ...args],
    metrics: [],
    configuredThreadMode: isWasi
      ? "inline in portable guest"
      : arm === "native-one-worker"
      ? "NumThreads(1), not Inline"
      : "AllThreads, automatic",
    fixture: files.sources,
    edits: options.checkEdits
      ? "REQUIRED"
      : "NOT_MEASURED: saved-files-only baseline; use --check-edits separately",
    failure: null,
  };
  const launchStart = performance.now();
  const child = spawn(isWasi ? process.execPath : options.native, args, {
    cwd: workspace,
    env: backendEnvironment(),
    stdio: isWasi ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exit = exited(child);
  let stderr = "";
  let sampler;
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString("utf8");
    if (stderr.length > 4 * 1024 * 1024) {
      rpc.fail(new Error("Backend stderr budget exceeded"));
      child.kill();
    }
  });
  const rpc = new RpcClient(child.stdin, child.stdout);
  child.once("error", (error) => rpc.fail(error));
  child.once("close", () => {
    if (rpc.pending.size)
      rpc.fail(new Error("Backend exited with pending RPCs"));
  });
  const workerEvents = [];
  if (isWasi) child.on("message", (message) => workerEvents.push(message));
  try {
    await bounded(
      new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      15000,
      "Backend spawn"
    );
    record.pid = child.pid;
    record.spawnMs = performance.now() - launchStart;
    if (options.sample)
      sampler = await startSampler(
        child.pid,
        options.python,
        path.join(directory, "resources.json")
      );
    const rootUri = isWasi
      ? "file:///workspace"
      : pathToFileURL(workspace).href;
    const mainUri = isWasi
      ? "file:///workspace/main.py"
      : pathToFileURL(path.join(workspace, "main.py")).href;
    const leafUri = isWasi
      ? "file:///workspace/m0000.py"
      : pathToFileURL(path.join(workspace, "m0000.py")).href;
    const start = performance.now();
    const initialized = await rpc.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "generated" }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: isWasi
        ? {
            pythonVersion: [3, 13, 0],
            pythonPlatform: "linux",
            searchPaths: ["/workspace"],
          }
        : undefined,
    });
    record.initializeMs = initialized.elapsedMs;
    rpc.notify("initialized", {});
    const protocol = await rpc.request(
      "typeServer/getSupportedProtocolVersion"
    );
    record.protocolVersion = protocol.value;
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: mainUri,
        languageId: "python",
        version: 1,
        text: files.main,
      },
    });
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: leafUri,
        languageId: "python",
        version: 1,
        text: files.leaf,
      },
    });
    const query = async (phase, expected) => {
      const queryStart = performance.now();
      const snapshot = await rpc.request("typeServer/getSnapshot");
      assertSnapshot(snapshot.value);
      const range = {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 5 },
      };
      const response = await rpc.request("typeServer/getComputedType", {
        arg: { uri: mainUri, range },
        snapshot: snapshot.value,
      });
      const roundTripMs = performance.now() - queryStart;
      const semantic = assertType(response.value, expected);
      record.builtinSourceUri ??= response.value.declaration.node.uri;
      assert.equal(
        response.value.declaration.node.uri,
        record.builtinSourceUri,
        "Builtin source identity changed within the session"
      );
      record.metrics.push({
        phase,
        elapsedMs: response.elapsedMs,
        roundTripMs,
        snapshotMs: snapshot.elapsedMs,
        snapshot: snapshot.value,
        semantic,
      });
      return { snapshot: snapshot.value, semantic };
    };
    const first = await query("first-query", "int");
    record.initializeToFirstCorrectMs = performance.now() - start;
    record.launchToFirstCorrectMs = performance.now() - launchStart;
    for (let index = 0; index < options.warmups; index++)
      await query("warmup", "int");
    for (let index = 0; index < options.queries; index++)
      await query("warm", "int");
    for (const [version, text, expected, phase] of options.checkEdits
      ? [
          [2, files.dirty, "str", "edit"],
          [3, files.leaf, "int", "restore"],
        ]
      : []) {
      const changedAt = performance.now();
      rpc.notify("textDocument/didChange", {
        textDocument: { uri: leafUri, version },
        contentChanges: [{ text }],
      });
      const observed = await query(phase, expected);
      assert(
        observed.snapshot > first.snapshot,
        "Edit did not advance snapshot"
      );
      record.metrics.at(-1).editToCorrectMs = performance.now() - changedAt;
    }
    const shutdownAt = performance.now();
    await rpc.request("shutdown");
    rpc.notify("exit", null);
    child.stdin.end();
    record.exit = await bounded(exit, 15000, "Backend orderly exit");
    record.shutdownMs = performance.now() - shutdownAt;
    assert.equal(record.exit.code, 0, "Backend exit was not clean");
    if (isWasi)
      assert(
        workerEvents.some(
          (event) =>
            event.kind === "retired" &&
            event.code === 0 &&
            event.expectedExit &&
            event.workerThreadId ===
              workerEvents.find((entry) => entry.kind === "ready")
                ?.workerThreadId
        ),
        "Worker retirement not acknowledged"
      );
    record.status = "PASS";
  } catch (error) {
    record.status = "FAIL";
    record.failure = error.stack ?? String(error);
    rpc.fail(error);
    if (child.exitCode === null) {
      record.forcedCleanup = true;
      child.kill();
    }
    try {
      record.exit = await bounded(exit, 10000, "Failed backend retirement");
    } catch (cleanupError) {
      record.cleanupFailure = cleanupError.stack ?? String(cleanupError);
    }
  } finally {
    try {
      if (sampler) record.resources = await sampler.stop();
      else
        record.resources = {
          status: "NOT_MEASURED",
          reason: "Sampler disabled",
        };
    } catch (error) {
      record.status = "FAIL";
      record.resourceFailure = error.stack ?? String(error);
      record.failure ??= record.resourceFailure;
    }
    if (record.status === "PASS" && !isWasi) {
      try {
        const nativeRoot = path.dirname(fileURLToPath(record.builtinSourceUri));
        assert(
          path.basename(nativeRoot).startsWith("pyrefly_bundled_typeshed_"),
          "Expected the native server's bundled typeshed"
        );
        const expected = treeHash(typeshed);
        const actual = treeHash(nativeRoot, new Set(["pyrefly.toml"]));
        assert.deepEqual(
          actual,
          expected,
          "Native and WASI stdlib bytes differ"
        );
        record.stdlibIntegrity = {
          expected,
          actual,
          excludedNativeFile:
            "pyrefly.toml: native-generated stub-analysis configuration, not part of the bundled archive",
        };
      } catch (error) {
        record.status = "FAIL";
        record.failure = error.stack ?? String(error);
      }
    }
    record.workerEvents = workerEvents;
    for (const source of files.sources) {
      if (
        hash(fs.readFileSync(path.join(workspace, source.name))) !==
        source.sha256
      ) {
        record.status = "FAIL";
        record.failure ??= `Fixture disk bytes changed: ${source.name}`;
      }
    }
    record.stderr = stderr;
    fs.writeFileSync(
      path.join(directory, "wire.json"),
      JSON.stringify(rpc.messages, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(directory, "result.json"),
      JSON.stringify(record, null, 2) + "\n"
    );
  }
  return record;
}

function resolveArtifacts(options) {
  const revision = checkedCommand("git", ["rev-parse", "HEAD"], {
    cwd: options.source,
  });
  if (revision !== ENGINE_REVISION)
    throw new Error(
      `Use the documented public engine revision ${ENGINE_REVISION}; do not mix engine versions`
    );
  if (
    checkedCommand("git", ["status", "--porcelain"], {
      cwd: options.source,
    })
  )
    throw new Error("Engine source must be clean");
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(options.source, process.env.CARGO_TARGET_DIR)
    : path.join(options.source, "target", "public-tsp-benchmark");
  if (options.build) {
    console.log("BUILD: native Pyrefly and bundled-stdlib exporter");
    checkedCommand(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "-p",
        "pyrefly",
        "--bin",
        "pyrefly",
        "--bin",
        "pyrefly-wasi-query",
        "--target-dir",
        target,
      ],
      { cwd: options.source }
    );
    console.log("BUILD: WASI Pyrefly guest");
    checkedCommand(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--target",
        "wasm32-wasip1",
        "-p",
        "pyrefly",
        "--bin",
        "pyrefly-wasi-query",
        "--target-dir",
        target,
      ],
      { cwd: options.source }
    );
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  options.native ??= path.join(target, "release", "pyrefly" + suffix);
  options.exporter ??= path.join(
    target,
    "release",
    "pyrefly-wasi-query" + suffix
  );
  options.wasm ??= path.join(
    target,
    "wasm32-wasip1",
    "release",
    "pyrefly-wasi-query.wasm"
  );
  for (const name of ["native", "exporter", "wasm"]) {
    if (!fs.statSync(options[name]).isFile())
      throw new Error(`Missing ${name} artifact`);
  }
  return {
    revision,
    tree: checkedCommand("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: options.source,
    }),
    cargoLockSha256: hash(
      fs.readFileSync(path.join(options.source, "Cargo.lock"))
    ),
    suppliedArtifactsBuildBinding: options.build
      ? "Built from clean pinned source by this run"
      : "Paths supplied by caller; source/build correspondence must be verified separately",
    buildTools: options.build
      ? {
          rustc: checkedCommand(process.env.RUSTC || "rustc", ["--version"]),
          cargo: checkedCommand("cargo", ["--version"]),
        }
      : "NOT_ASSERTED_FOR_SUPPLIED_ARTIFACTS",
  };
}

async function main(argv) {
  const options = argumentsFrom(argv);
  if (fs.existsSync(options.out))
    throw new Error(
      "Output directory already exists; preserve earlier attempts"
    );
  const source = resolveArtifacts(options);
  fs.mkdirSync(options.out, { recursive: true });
  const typeshed = path.join(options.out, "typeshed");
  const preparedAt = performance.now();
  checkedCommand(options.exporter, ["--export-typeshed", typeshed]);
  const artifactHashes = Object.fromEntries(
    ["native", "wasm", "exporter"].map((name) => [
      name,
      hash(fs.readFileSync(options[name])),
    ])
  );
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode: options.smoke
      ? "CORRECTNESS_SMOKE_NOT_PERFORMANCE_CONCLUSION"
      : "BOUNDED_DESCRIPTIVE_COMPARISON",
    options,
    source,
    artifactHashes,
    typeshed: treeHash(typeshed),
    runnerHashes: Object.fromEntries(
      fs
        .readdirSync(__dirname)
        .filter((name) => /\.(cjs|py|md)$/.test(name))
        .sort()
        .map((name) => [
          name,
          hash(fs.readFileSync(path.join(__dirname, name))),
        ])
    ),
    sourceScope: options.checkEdits
      ? "SAVED_AND_UNSAVED_DEPENDENCY_EDITS"
      : "SAVED_UNCHANGED_FILES_ONLY",
    wasiFilesystem:
      process.platform === "win32"
        ? "Node WASI plus public benchmark directory adapter for fd_readdir NOSYS; adapter cost included"
        : "Node WASI filesystem",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    logicalCpus: os.cpus().length,
    setupMs: performance.now() - preparedAt,
    nativeInlineMode:
      "NOT_SUPPORTED_BY_PINNED_PUBLIC_CLI; one-worker control is not inline",
    concurrency:
      "No exclusivity or OS-cold-cache guarantee; inspect host workload before drawing performance conclusions",
    power: "NOT_MEASURED",
    semantics:
      "Same source revision, Python3.13/linux, generated source and bundled stdlib. Normal native TSP vs serial portable WASI dispatcher; not isolated Wasm overhead.",
    sampling: options.sample
      ? "100ms observer plus initialization barrier; instrumentation affects launch-to-correct time"
      : "Disabled",
    nodeUvPoolConfiguration:
      process.env.UV_THREADPOOL_SIZE ??
      "Node default; not inferred from observed OS threads",
  };
  fs.writeFileSync(
    path.join(options.out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  const results = [];
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const order = ARMS.map((_, index) => ARMS[(index + repeat) % ARMS.length]);
    for (const arm of order) {
      const directory = path.join(options.out, `${repeat + 1}-${arm}`);
      const result = await runSession(options, arm, directory, typeshed);
      results.push(result);
      fs.writeFileSync(
        path.join(options.out, "results.json"),
        JSON.stringify(results, null, 2) + "\n"
      );
      console.log(
        `${result.status}: ${arm}${result.failure ? "\n" + result.failure : ""}`
      );
    }
  }
  const summary = ARMS.map((arm) => {
    const sessions = results.filter((result) => result.arm === arm);
    const passed = sessions.filter((result) => result.status === "PASS");
    return {
      arm,
      label: LABELS[arm],
      planned: options.repeats,
      passed: passed.length,
      failed: sessions.length - passed.length,
      warm: stats(
        passed.flatMap((session) =>
          session.metrics
            .filter((metric) => metric.phase === "warm")
            .map((metric) => metric.elapsedMs)
        )
      ),
      first: stats(passed.map((session) => session.metrics[0].elapsedMs)),
      firstSnapshotAndType: stats(
        passed.map((session) => session.metrics[0].roundTripMs)
      ),
      warmSnapshotAndType: stats(
        passed.flatMap((session) =>
          session.metrics
            .filter((metric) => metric.phase === "warm")
            .map((metric) => metric.roundTripMs)
        )
      ),
      launchToFirstCorrect: stats(
        passed.map((session) => session.launchToFirstCorrectMs)
      ),
      shutdown: stats(passed.map((session) => session.shutdownMs)),
      threadsPeak: passed.map(
        (session) => session.resources.peakSampledThreads ?? "NOT_MEASURED"
      ),
      resourceScope: passed.map(
        (session) => session.resources.scope ?? "NOT_MEASURED"
      ),
      treeCpuSeconds: passed.map(
        (session) =>
          session.resources.observedTreeInterval?.cpuSeconds ?? "NOT_MEASURED"
      ),
      oneCorePercent: passed.map(
        (session) =>
          session.resources.observedTreeInterval?.oneCorePercent ??
          "NOT_MEASURED"
      ),
      machinePercent: passed.map(
        (session) =>
          session.resources.observedTreeInterval?.machinePercent ??
          "NOT_MEASURED"
      ),
      sampledProcessesPeak: passed.map(
        (session) => session.resources.peakSampledProcesses ?? "NOT_MEASURED"
      ),
      treeRssPeakMiB: passed.map((session) =>
        typeof session.resources.peakSampledTreeRssBytes === "number"
          ? session.resources.peakSampledTreeRssBytes / 1024 / 1024
          : "NOT_MEASURED"
      ),
    };
  });
  const typeshedAfter = treeHash(typeshed);
  fs.writeFileSync(
    path.join(options.out, "typeshed-integrity.json"),
    JSON.stringify(
      { before: manifest.typeshed, after: typeshedAfter },
      null,
      2
    ) + "\n"
  );
  assert.deepEqual(
    typeshedAfter,
    manifest.typeshed,
    "Shared typeshed bytes changed"
  );
  fs.writeFileSync(
    path.join(options.out, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  const report = [
    "# Native and WASI Pyrefly backend comparison",
    "",
    `Mode: **${manifest.mode}**. No Pylance dependency. No claim of pure WebAssembly overhead.`,
    `Source scope: **${manifest.sourceScope}**. ${manifest.wasiFilesystem}.`,
    "",
    "| Backend | Passed / planned | First snapshot + type median ms | Warm snapshot + type median ms | Peak sampled OS threads |",
    "| --- | --- | --- | --- | --- |",
    ...summary.map(
      (row) =>
        `| ${row.label} | ${row.passed}/${row.planned} | ${
          row.firstSnapshotAndType?.medianMs ?? "NOT_MEASURED"
        } | ${row.warmSnapshotAndType?.medianMs ?? "NOT_MEASURED"} | ${
          row.threadsPeak.join(", ") || "NOT_MEASURED"
        } |`
    ),
    "",
    "| Backend | Launch to first correct result median ms | Shutdown median ms |",
    "| --- | --- | --- |",
    ...summary.map(
      (row) =>
        `| ${row.arm} | ${
          row.launchToFirstCorrect?.medianMs ?? "NOT_MEASURED"
        } | ${row.shutdown?.medianMs ?? "NOT_MEASURED"} |`
    ),
    "",
    "Per-session sampled resource observations, in repeat order:",
    "",
    "| Backend | Peak processes | Observed tree CPU seconds | One-core-equivalent % | Machine-normalized % | Peak tree RSS MiB |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summary.map(
      (row) =>
        `| ${row.arm} | ${
          row.sampledProcessesPeak.join(", ") || "NOT_MEASURED"
        } | ${row.treeCpuSeconds.join(", ") || "NOT_MEASURED"} | ${
          row.oneCorePercent.join(", ") || "NOT_MEASURED"
        } | ${row.machinePercent.join(", ") || "NOT_MEASURED"} | ${
          row.treeRssPeakMiB.join(", ") || "NOT_MEASURED"
        } |`
    ),
    "",
    "See each session result/resources/wire record for initialization, optional edit/restore checks, shutdown, per-thread CPU and failure details. These are backend RPC responses, not hover rendering. CPU intervals and thread first/last observations are not exclusive query costs. One-core % = summed observed process CPU / sampling wall time * 100; machine % divides by logical CPUs. Sampler overhead is included; run a separate --no-sample comparison before interpreting performance. Single-session smoke quantiles are descriptive only. Power and short-lived descendants may be unmeasured.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(options.out, "report.md"), report);
  console.log(report);
  if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
  return { manifest, results, summary };
}

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });

module.exports = {
  ARMS,
  ENGINE_REVISION,
  argumentsFrom,
  backendEnvironment,
  bounded,
  exited,
  fixture,
  main,
  runSession,
  startSampler,
};
