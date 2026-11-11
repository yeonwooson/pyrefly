// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { checkSession } from './session-check.mjs';

const BRIDGE_COMMIT = '0b9103aa74c5016146f4aac642f19dad71295d8e';
const BRIDGE_SHA256 = '81d78de0d3b5a812f1b41a11cac311b96eda6b2f3dbfc2b6f8946e335ad5fefd';
const { values } = parseArgs({
    options: {
        wasm: { type: 'string' },
        bridge: { type: 'string' },
        output: { type: 'string' },
    },
});
assert(values.wasm, '--wasm must name the actual built validation module');
const bridgeUrl = `https://raw.githubusercontent.com/meta/pyrefly/${BRIDGE_COMMIT}/pyrefly_wasm/pyrefly_wasm.js`;
let bridgeSource;
if (values.bridge) {
    bridgeSource = await readFile(values.bridge, 'utf8');
} else {
    const response = await fetch(bridgeUrl);
    assert(response.ok, `Public bridge download failed: ${response.status}`);
    bridgeSource = await response.text();
}
bridgeSource = bridgeSource.replace(/\r\n/g, '\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(bridgeSource), BRIDGE_SHA256, 'The bridge must match the pinned public prototype');
const bridge = await import(`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`);
const artifact = await readFile(values.wasm);
await bridge.default(await WebAssembly.compile(artifact));
const result = checkSession(bridge);
assert.equal(result.status, 'PASS');
assert.equal(result.checks, 29);
result.artifactSha256 = sha256(artifact);
result.bridgeSha256 = BRIDGE_SHA256;
result.bridgeCommit = BRIDGE_COMMIT;
result.bridgeSource = bridgeUrl;
result.host = process.version;
if (values.output) {
    await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}
console.log(`FILESYSTEM_TSP_SESSION_OK: ${result.checks} checks; real type queries and stale snapshots`);
