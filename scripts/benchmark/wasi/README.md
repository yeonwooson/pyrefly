# Pyrefly WASI: Worker versus main-thread JSPI

Run the same real Pyrefly command and generated Python projects in a Node
Worker and on the driving thread using JavaScript Promise Integration (JSPI).
No Pylance, editor, private source, Python environment, or native Pyrefly
installation is used.

## Run

Use this public branch, which contains the persistent `pyrefly-wasi-query`
command. Upstream Pyrefly `main` does not provide that command.

Prerequisites:

- Node with `WebAssembly.Suspending`, `WebAssembly.promising`, and
  `Atomics.waitAsync` (tested with Node 24.15.0).
- Rust and Cargo, with `rustup target add wasm32-wasip1`.
- A public [WASI SDK](https://github.com/WebAssembly/wasi-sdk/releases)
  installation, with `WASI_SDK_PATH` set to its absolute directory. This is
  required to build the guest's C dependencies; the script selects that SDK's
  `clang`, `llvm-ar`, and sysroot. Tested with WASI SDK 34 and Rust 1.99.1.
- Network access for the initial public Cargo and npm dependencies.

From the repository root:

```sh
npm ci --prefix scripts/benchmark/wasi --registry=https://registry.npmjs.org
npm run bench --prefix scripts/benchmark/wasi
```

The script builds the guest in release mode using the checked-in Cargo
lockfile, then runs both placements. It uses two alternating paired blocks
(`Worker, JSPI, JSPI, Worker`) per workload, two verified warmups per session,
and 12 measured edits per session. Both placements use the same compiled
Wasm bytes, in-memory filesystem, framed protocol, and shared-memory stdin
mailbox. Only the guest placement and blocking versus suspending stdin differ.

For a shorter check, or a longer run:

```sh
npm run bench --prefix scripts/benchmark/wasi -- --blocks 1 --samples 2
npm run bench --prefix scripts/benchmark/wasi -- --blocks 4 --samples 30
npm test --prefix scripts/benchmark/wasi
```

These commands also work in PowerShell; paths can use backslashes.
Set the SDK path with `$env:WASI_SDK_PATH = 'C:\path\to\wasi-sdk'` in
PowerShell, or `export WASI_SDK_PATH=/path/to/wasi-sdk` in a POSIX shell.

## Workloads and measurements

- **shared:** 1,024 small modules import a shared `seed`; the entry point
  imports all modules.
- **compute:** one entry point contains 600 typed list assignments.
- Every iteration changes the shared `seed` to a different integer, obtains
  the current snapshot, and queries the entry point's `answer`. The script
  requires the exact new literal value, not just a successful response.
  An explicit `Literal` annotation preserves that value across module imports.
- **Edit-to-type** measures the complete three-request sequence, including
  transport, analysis, response decoding, and validation.
- **Event-loop delay** is the maximum lateness of a 10 ms heartbeat on the
  driving thread during each sequence, including the first subsequent drain
  tick so that a final synchronous stall is not missed. Raw tick times and
  delays are retained. The final drain is outside the edit-to-type clock.
  This is not a configuration-request latency or exclusive Rust-compute cost.
  The unit tests require the probe to detect a deliberate synchronous stall.

JSPI suspends at an empty stdin read; it does not preempt or make synchronous
Rust computation cooperative. A Worker can keep the driving thread responsive
while the guest computes. Placement can also change transport overhead.

The console shows pooled medians and nearest-rank p95. Raw JSON, including
warmups, individual samples, session order, thread IDs, toolchain versions,
source revision, and Cargo-lock/Wasm SHA-256 hashes, is saved to a fresh
`target/wasi-placement-*/results.json` directory. Use `--output <directory>`
to select a fresh output directory relative to the repository root. Existing
output directories are never overwritten.

An incorrect type, guest stderr, runtime failure, or request timeout fails
the run and retains partial results; samples are not selectively retried or
trimmed. Request timers are event-loop deadlines, not hard preemption of a
blocked main thread.

Compilation, filesystem construction, guest startup, initial document opens,
and two verified warmups per session are outside the measured sequence.
Wasm compilation is shared across placements; startup latency is not compared.

These are descriptive microbenchmarks, not reproduced editor timings or a
production-adoption decision. The generated projects deliberately avoid
private code; they do not have the same source contents as an editor
integration benchmark. There is no ambient-load matching or causal speedup
threshold, and small-sample p95 may simply be the maximum. Re-run on the
same hardware before comparing distributions, and retain unfavorable runs.

## Reference observations: 2026-10-26

Two consecutive default-sized runs on Windows ARM64 used a Snapdragon
X1E80100 (12 logical CPUs), Node 24.15.0, Rust 1.99.1, and WASI SDK 34.
Both used the same guest bytes and script, with public guest-source base
[`2a8196b`](https://github.com/yeonwooson/pyrefly/commit/2a8196baa523a21620b66c243e7778a64c211b11).
All 224 fresh type checks passed across 16 sessions: 192 measured requests
and 32 warmups. Each row below contains 24 measured requests.

Reproduce the two runs with:

```sh
npm run bench --prefix scripts/benchmark/wasi -- --output target/wasi-repro-run-003
npm run bench --prefix scripts/benchmark/wasi -- --output target/wasi-repro-run-004
```

All durations are milliseconds; runs are shown separately, not pooled.

| Run | Workload | Placement | Edit-to-type median | Edit-to-type p95 | Loop-delay median | Loop-delay p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 003 | shared | Worker | 68.946 | 75.236 | 9.591 | 18.032 |
| 003 | shared | JSPI | 63.209 | 70.903 | 52.595 | 59.993 |
| 003 | compute | Worker | 10.857 | 12.500 | 10.953 | 14.949 |
| 003 | compute | JSPI | 10.958 | 13.506 | 7.041 | 14.374 |
| 004 | shared | Worker | 67.150 | 71.106 | 10.139 | 12.853 |
| 004 | shared | JSPI | 66.595 | 77.636 | 56.130 | 67.113 |
| 004 | compute | Worker | 10.127 | 12.691 | 8.529 | 15.016 |
| 004 | compute | JSPI | 9.835 | 11.903 | 7.406 | 13.708 |

The shared-import fixture shows larger main-thread timer stalls in both
repetitions. The smaller fixture does not establish a consistent latency
advantage. The requested 10 ms timer period is not a scheduling guarantee:
OS timer granularity and other host activity contribute to these delays.
These observations are examples to remeasure, not pass/fail thresholds.
