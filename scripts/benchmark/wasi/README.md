# Pyrefly WASI benchmarks

This suite provides separate comparisons using a shared public Rust document
engine, fixture generator, and in-memory WASI runtime:

| Command                | Question                                                                                | Workload                              |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| `npm run bench`        | Worker versus main-thread JSPI: does placement affect latency or driving-thread stalls? | Exact fresh types after unsaved edits |
| `npm run bench:native` | How does normal native Pyrefly compare with the WASI Worker, including OS resources?    | Unchanged saved-file type queries     |
| `npm run bench:direct` | Does calling exported Wasm functions help versus command JSPI and native process TSP?   | Saved queries and own-document edits  |

Run npm commands with `--prefix scripts/benchmark/wasi` from the repository root.
Results from the comparisons have different workloads and timing boundaries;
do not combine their distributions.

## Direct Wasm functions versus command JSPI versus native RPC

This experimental comparison has three arms:

- **direct-wasm:** a WASIp1 Rust `cdylib` on the driving JavaScript thread. JavaScript
  allocates an instance-owned input buffer, copies JSON parameters, calls an
  exported function such as `direct_query()`, and reads its JSON result.
  There is no guest Worker, JSON-RPC envelope, Content-Length framing,
  stdin/stdout request loop, or JSPI wrapper on this path.
- **command-jspi:** the existing WASI command on that same driving thread. It
  retains framed TSP JSON-RPC over in-memory stdin/stdout, and uses JSPI to
  suspend at empty stdin reads.
- **native-rpc:** normal native Pyrefly in a separate process, with its normal
  thread count and TSP stdio interface.

The exported library reuses `DocumentGuest`; it does not introduce another type checker
or change the TSP protocol. It exposes initialize, open, change, snapshot,
computed-type query, protocol-version query, and dispose operations. Input and
output buffers are bounded at 1 MiB. Invalid input, stale snapshots, diagnostics,
guest traps, and failed updates are explicit failures; updates poison the
session on rejection, matching the command guest.

Rust's built library exports `direct_initialize`, which creates the document
session, but no command `_start` or separate C-runtime `_initialize` function.
The standard WASI shim binds the instance and would run `_initialize` if one
were present; no command loop or synthetic startup function is added.

The direct ABI **still encodes JSON, allocates memory, and copies bytes**. It is
not a zero-copy or typed component interface. The command and reactor share
engine/session code but are different compiled artifacts. Native Pyrefly uses a
different dispatcher, thread model and disk filesystem. These results compare
the three architectures; they do not isolate process overhead, establish a
pure Wasm slowdown, or imply production readiness.

Use the prerequisites below and run:

```sh
npm run bench:direct --prefix scripts/benchmark/wasi
npm run bench:direct --prefix scripts/benchmark/wasi -- --blocks 1 --samples 2 --edits 1 --size 3
```

The runner builds all three release artifacts from the locked source. It does
not accept prebuilt-artifact overrides. Defaults are three rotating blocks,
24 warm queries, four edits and 20 imported modules (22 Python files) per
session. Two verified warmups precede warm measurements. Each block contains
all arms, rotating the starting arm to reduce order bias. Hosts are fresh;
the Node process and compiled Wasm modules are shared, so JIT/cache effects and
host contention remain limitations.

Every query requires the exact `Literal[revision]` builtin integer type and an
instance flag, not just a successful response. Edits change only the entry
document's unsaved declaration, require a newer snapshot, and require the exact
new literal. Imported files are byte-identical across arms. This does **not**
qualify native cross-module unsaved-edit freshness. Native edits are
notifications, command edits have request acknowledgments, and direct edits
are function calls; edit-to-type includes those actual submission differences.

Raw results retain all samples, warmups, failures, notifications, session
order, fixture/stdlib/artifact hashes and tool versions in a fresh
`target/direct-call-*/results.json` directory. `--output <fresh-directory>`
selects another location. Failed sessions are retained in denominators, never
retried until correct or assigned successful timings.

- **Warm/first query:** snapshot plus computed-type request and result decoding.
  Exact semantic assertions follow the request clock.
- **Edit:** change plus snapshot plus computed-type sequence.
- **Event-loop delay:** the same 10 ms driving-thread heartbeat used by the
  placement comparison, including the first subsequent drain tick, outside
  the request timer. OS scheduling and host load also affect this measurement.
- **Startup:** Wasm compilation is recorded separately and shared between
  sessions; host creation, initialization, open submission/acknowledgment,
  launch-to-first-correct result and orderly shutdown are recorded. Startup
  and shutdown also have driving-thread heartbeat probes. Their final drain
  ticks are outside the launch/shutdown clocks.

Neither direct synchronous Wasm nor JSPI can preempt Rust CPU work. Request
timeouts are event-loop deadlines, not hard interruption. Do not select a
main-thread production path from request medians alone.

Run the ABI integration tests against the reactor built by the runner:

```powershell
$env:PYREFLY_DIRECT_WASM = '<Cargo target directory>\wasm32-wasip1\release\examples\pyrefly_wasi_direct.wasm'
npm test --prefix scripts\benchmark\wasi
```

The two real-reactor tests are explicitly skipped without this path. They must
run, not skip, when qualifying direct-call results. They exercise actual Wasm
exports, invalid UTF-8/buffer limits, initialization, fresh edits, stale
snapshots, poisoned updates, disposal, and rejection after host closure.

## Worker versus main-thread JSPI

Run the same real Pyrefly command and generated Python projects in a Node
Worker and on the driving thread using JavaScript Promise Integration (JSPI).
No Pylance, editor, private source, Python environment, or native Pyrefly
installation is used.

### Run

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

### Workloads and measurements

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

## Native versus WASI saved-file baseline

Use the same checkout and prerequisites above. Python 3.10 or later is also
required for resource collection; no Python packages or interpreter-based
analysis environment are installed. This command builds both native binaries
and the WASI guest from this checkout with the same locked Cargo dependencies:

```sh
npm run bench:native --prefix scripts/benchmark/wasi -- --output target/native-wasi-sampled
npm run bench:native --prefix scripts/benchmark/wasi -- --output target/native-wasi-unsampled --no-sample
```

`CARGO_TARGET_DIR` is honored by all comparisons. Repeated commands reuse the
normal Cargo cache but still validate/build their own outputs; there are no
external binary overrides. Use a fresh output directory for each attempt.
Suite source hashes are frozen before building and checked again before and
after measurement. Do not edit the suite while a run is in progress.
For a smaller correctness check:

```sh
npm run bench:native --prefix scripts/benchmark/wasi -- --blocks 1 --samples 2 --size 3 --no-sample --output target/native-wasi-smoke
npm run test:resources --prefix scripts/benchmark/wasi
```

The default schedule rotates three configurations through each ordering position:

1. Normal native TSP with automatic Rayon thread selection.
2. Normal native TSP with `--threads 1`, one Rayon worker, **not inline**.
3. The same in-memory WASI Worker used by the placement comparison, inside a
   dedicated Node child process so its full host footprint can be observed.

The public native CLI does not expose a verified inline mode. No engine, Rust
guest, or TSP protocol changes are needed for this comparison.

`--size` defaults to 20 shared-import modules, plus `shared.py` and `app.py`
(22 Python files total). All modules are imported. The fixture is generated
by the placement benchmark's existing generator, but the saved-file baseline
does not edit it: every query must return the exact `Literal[0]` class instance,
with a real builtin source declaration. Both arms use Python 3.14/Linux
analysis settings. Native reads saved disk files; the Worker reads the same
source bytes in the suite's in-memory filesystem. That filesystem and the
different native/portable dispatchers are part of the comparison, not isolated
WebAssembly or process-transport overhead.

The fixture imports module values without otherwise using them. Native's
`unused-import` hints (LSP severity 4) are expected and retained in the wire
log. Errors, warnings, and every other diagnostic fail the run. The placement
comparison's existing diagnostic checks are unchanged.

Each arm gets three fresh sessions by default (`--blocks`), two warmups after
the first correct query, and ten warm requests (`--samples`). Nothing is
trimmed or retried into success. Both configurations' standard-library archive
files and bytes are checked against the paired build's exported stubs;
native's generated `pyrefly.toml` analysis configuration is excluded explicitly.
Orderly shutdown, correlated requests, immutable fixtures, process exit, and
the WASI Worker's matching logical ready/retired identity are required.

### Native timing and resource boundaries

- Each query clock covers `getSnapshot` through the decoded computed-type
  response. Individual snapshot and type-request times are also retained.
  Answer assertions and result-file writes are outside this query clock.
- Spawn, initialization, first-correct result, warm requests, and shutdown are
  separate. Builds and fixture creation are outside the backend clock.
  Launch-to-first-correct includes the sampler readiness barrier when enabled;
  compare a separate `--no-sample` output before interpreting that value.
- The WASI child compiles the guest and forwards requests to the existing
  Worker host. Its extra stdio/Worker forwarding and allocations are included.
  This is not a native-versus-WASI-in-the-same-process experiment.
- The standard-library-only Python collector samples the creation-bound
  backend process and observed descendants every 100 ms on Windows and Linux.
  macOS resources are explicitly `NOT_MEASURED`, not zero. Only Windows ARM64
  has been exercised end to end; other platform qualification remains open.
- Raw observations include process/thread creation identities, initial/peak/
  final thread counts, per-thread CPU intervals, process/tree CPU, and RSS.
  Node/V8/Worker and other support threads count too; OS thread count is not
  analysis-pool size or proof of CPU utilization.
- One-core-equivalent utilization is observed CPU seconds / observation wall
  seconds \* 100. Machine-normalized utilization divides that by logical CPUs.
  CPU is whole-session host footprint, not exclusive query or Rust CPU.
- Short-lived processes/threads can be missed; inaccessible observations are
  retained. Counters can be coarse, and a zero observed CPU delta does not
  prove a thread never ran. Logical Worker IDs are not OS thread IDs.
- RSS peaks are sampled, not continuously observed maxima. Power is
  `NOT_MEASURED`. Neither command reserves the machine or establishes cold
  caches; avoid concurrent benchmarks/builds. Sampling itself has overhead.

The output contains a fresh `results.json` with the schedule, source/code/
lockfile and artifact hashes, toolchains, exact answers, all session outcomes
and resource summaries. Each session retains decoded `wire.json`,
`result.json`, and, when enabled, raw `resources.json`. Incorrect answers and
resource/cleanup failures are explicit failures, not empty successful samples.

The native saved-file command deliberately does not claim unsaved-edit parity.
The pinned native TSP path has an observed stale cross-module dependency type
after an unsaved edit. The placement command still requires every exact new
literal after edits; that freshness test is unchanged. Do not compare its
edit-to-type timings with saved-file cached-query timings.

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
| --- | -------- | --------- | ------------------: | ---------------: | ----------------: | -------------: |
| 003 | shared   | Worker    |              68.946 |           75.236 |             9.591 |         18.032 |
| 003 | shared   | JSPI      |              63.209 |           70.903 |            52.595 |         59.993 |
| 003 | compute  | Worker    |              10.857 |           12.500 |            10.953 |         14.949 |
| 003 | compute  | JSPI      |              10.958 |           13.506 |             7.041 |         14.374 |
| 004 | shared   | Worker    |              67.150 |           71.106 |            10.139 |         12.853 |
| 004 | shared   | JSPI      |              66.595 |           77.636 |            56.130 |         67.113 |
| 004 | compute  | Worker    |              10.127 |           12.691 |             8.529 |         15.016 |
| 004 | compute  | JSPI      |               9.835 |           11.903 |             7.406 |         13.708 |

The shared-import fixture shows larger main-thread timer stalls in both
repetitions. The smaller fixture does not establish a consistent latency
advantage. The requested 10 ms timer period is not a scheduling guarantee:
OS timer granularity and other host activity contribute to these delays.
These observations are examples to remeasure, not pass/fail thresholds.
