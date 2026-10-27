// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Do not pass credentials or ambient Python/Pyrefly configuration to backends. */
export function childEnvironment(environment = process.env) {
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
      allowed.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]])
    ),
    PYTHONIOENCODING: "utf-8",
    RUST_BACKTRACE: "0",
  };
}

export async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/** Sampling starts at a ready barrier and ends with a final owned-tree observation. */
export async function startResources(pid, python, file) {
  const child = spawn(python, [fileURLToPath(new URL("resources.py", import.meta.url)), "--pid", String(pid)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: childEnvironment(),
  });
  const exit = exited(child);
  const ready = Promise.withResolvers();
  const records = [];
  let buffered = "";
  let stderr = "";
  let summary;
  let readiness;
  let failure;
  let outputBytes = 0;
  const fail = (error) => {
    failure ??= error;
    ready.reject(error);
  };
  child.stdin.on("error", fail);
  child.stdout.on("data", (bytes) => {
    try {
      outputBytes += bytes.length;
      assert(outputBytes <= 64 * 1024 * 1024, "Resource output budget exceeded");
      buffered += bytes.toString("utf8");
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end < 0) break;
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        records.push(message);
        if (message.kind === "ready") {
          readiness = message;
          ready.resolve(message);
        } else if (message.kind === "summary") summary = message;
      }
    } catch (error) {
      fail(error);
      child.kill();
    }
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString("utf8");
    if (stderr.length > 1024 * 1024) {
      fail(new Error("Resource stderr budget exceeded"));
      child.kill();
    }
  });
  exit.then((result) => {
    if (result.code !== 0 || !readiness) fail(new Error(`Resource sampler failed or exited before ready: ${stderr}`));
  }, fail);
  const persist = async (result) => {
    if (file) await writeFile(file, `${JSON.stringify({ records, stderr, exit: result }, null, 2)}\n`, { flag: "wx" });
  };
  try {
    await bounded(ready.promise, 15_000, "Resource readiness");
  } catch (error) {
    child.kill();
    let result;
    try {
      result = await bounded(exit, 5000, "Failed sampler retirement");
    } catch (cleanupError) {
      error.cause = cleanupError;
    }
    await persist(result);
    throw error;
  }
  return {
    async stop() {
      let result;
      try {
        if (child.exitCode === null) child.stdin.end('{"command":"stop"}\n');
        result = await bounded(exit, 10_000, "Resource sampler exit");
      } catch (error) {
        child.kill();
        await bounded(exit, 5000, "Sampler timeout retirement");
        throw error;
      } finally {
        await persist(result);
      }
      if (failure) throw failure;
      assert.equal(buffered.trim(), "", "Truncated resource output");
      assert.equal(result.code, 0, `Resource sampler failed: ${stderr}`);
      if (readiness.status === "NOT_MEASURED") return readiness;
      assert(summary, "Resource summary missing");
      assert.equal(summary.finalObservedProcesses, 0, "An observed backend process survived cleanup");
      return summary;
    },
  };
}
