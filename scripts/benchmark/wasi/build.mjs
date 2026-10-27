// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function command(name, args) {
  return execFileSync(name, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function suiteHashes() {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /\.(mjs|py|json)$/.test(name)).sort();
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, sha256(await readFile(path.join(directory, name)))]))
  );
}

/** Both comparisons build the same locked release guest using the public SDK. */
export async function buildArtifacts(includeNative = false) {
  const sdk = process.env.WASI_SDK_PATH;
  assert(sdk && path.isAbsolute(sdk), "Set WASI_SDK_PATH to an absolute public WASI SDK installation path");
  const extension = process.platform === "win32" ? ".exe" : "";
  const clang = path.join(sdk, "bin", `clang${extension}`);
  const env = {
    ...process.env,
    WASI_SYSROOT: path.join(sdk, "share", "wasi-sysroot"),
    CC_wasm32_wasip1: clang,
    AR_wasm32_wasip1: path.join(sdk, "bin", `llvm-ar${extension}`),
  };
  if (includeNative) {
    execFileSync("cargo", ["build", "--locked", "--release", "--bin", "pyrefly", "--bin", "pyrefly-wasi-query"], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
  }
  execFileSync(
    "cargo",
    ["build", "--locked", "--release", "--target", "wasm32-wasip1", "--bin", "pyrefly-wasi-query"],
    { cwd: ROOT, env, stdio: "inherit" }
  );
  const metadata = JSON.parse(command("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
  const wasm = path.join(metadata.target_directory, "wasm32-wasip1", "release", "pyrefly-wasi-query.wasm");
  return {
    wasm,
    bytes: await readFile(wasm),
    native: path.join(metadata.target_directory, "release", `pyrefly${extension}`),
    exporter: path.join(metadata.target_directory, "release", `pyrefly-wasi-query${extension}`),
    tools: {
      rustc: command(process.env.RUSTC || "rustc", ["--version"]),
      cargo: command("cargo", ["--version"]),
      clang: command(clang, ["--version"]).split(/\r?\n/)[0],
    },
  };
}
