# Native and WASI Pyrefly TSP comparison

Compare the normal native Pyrefly type-server binary with a serial WASI Pyrefly
guest using generated Python sources and direct TSP requests. No Pylance,
editor, private workspace, private runtime, or third-party Node package is
required.

This is a backend and transport comparison, **not an isolated measurement of
WebAssembly overhead**. Native uses the normal TSP server; WASI uses the public
portable document dispatcher. Both engines come from the same public source.
The portable guest is a proposed fork capability, not a released upstream WASI
type server.

## Public prerequisites

- Node.js 24 or later, Python 3.10 or later, Git, and stable Rust with Cargo.
- Rust's `wasm32-wasip1` target: `rustup target add wasm32-wasip1`.
- A native linker and an official [WASI SDK](https://github.com/WebAssembly/wasi-sdk)
  C compiler for dependencies such as zstd. Set `WASI_SDK_PATH` to the unpacked
  SDK; on Windows, also set `CC_wasm32_wasip1` and `AR_wasm32_wasip1` to its
  `bin\clang.exe` and `bin\llvm-ar.exe`.

Obtain the public engine sources separately:

```sh
git clone --single-branch --branch yeonwooson/pyrefly-wasi-11-callable-source-fidelity https://github.com/yeonwooson/pyrefly.git ../pyrefly-portable-engine
```

The runner verifies the exact documented engine revision embedded in
`run.cjs`. If that public branch advances, use its historical commit matching
`ENGINE_REVISION` rather than silently mixing engine versions. Keep that
checkout clean; the runner never changes engine code or its lockfile.

## One-command smoke test

From the checkout containing these scripts:

```sh
node scripts/tsp_benchmark/run.cjs --source ../pyrefly-portable-engine --build --out target/tsp-smoke --smoke
```

On systems where Python is named `python3`, append `--python python3`.
Use an unused output directory for every run. Failed attempts are retained,
not overwritten or automatically retried.

`CARGO_TARGET_DIR` is honored for Cargo's build cache and artifact lookup;
otherwise artifacts live under the engine's `target/public-tsp-benchmark`.
Use the same value when reusing builds. Do not combine `--build` with explicit
artifact paths: build mode must measure its own outputs, not attest unrelated
prebuilt binaries.

The build is outside the measurement clock. It builds native `pyrefly` and
the public WASI guest from the same clean source in release mode, exports
their bundled typeshed, generates a three-file import chain, and runs:

1. Native Pyrefly with automatic thread selection.
2. Native Pyrefly with `--threads 1`, a single **Rayon worker**, not inline.
3. WASI Pyrefly with inline guest analysis in a Node Worker.

The pinned native CLI does not expose a verified inline mode; that arm is
explicitly unsupported rather than being approximated by a one-thread pool.
The WASI Worker runs inside a dedicated Node child so its complete host
process can be sampled independently of the benchmark driver.

All arms use Python 3.13/Linux analysis settings, the same source contents and
the same build's bundled stubs. Physical host and guest paths necessarily
differ. Native uses its bundled-stub cache; WASI mounts the exported archive.
After native shutdown, the runner verifies every relative stub filename and
its content against that export. Only the native-generated `pyrefly.toml`
stub-analysis configuration is excluded from this archive comparison.
The only WASI preopens are the generated workspace and exported typeshed.
Node WASI is not a security sandbox; use only the trusted public artifact.

Each baseline session checks a saved `int` type, warm queries, orderly shutdown,
and process/Worker retirement. It measures **unchanged saved files only**.
Null, incorrect or failed answers do not become successful timing samples.

On Windows, Node's WASI directory enumeration returns `NOSYS`. The included
public benchmark adapter supplies directory records for successfully opened
directories within the two preopens. Its filesystem work and allocations are
inside the WASI clock; this is not an unmodified-Node-runtime comparison.
Other hosts use Node's implementation without the adapter.

Use `--check-edits` in a separate smoke output to require an unsaved dependency
edit `int -> str -> int` and snapshot advancement. This is not part of the
saved-file performance baseline. The pinned native server has an observed
failure: its dependency query can retain `int` after the edit, including after
a diagnostic wait, despite advancing its snapshot. The runner reports that
failure rather than retrying until the expected type appears. Passing the
saved-file baseline does not resolve or hide the edit failure.

## Bounded descriptive run

After the smoke and collection controls pass, and without another build or
benchmark competing for the host:

```sh
node scripts/tsp_benchmark/run.cjs --source ../pyrefly-portable-engine --out target/tsp-comparison --modules 20 --repeats 3 --warmups 3 --queries 10
```

Without `--build`, paths default to the artifacts produced by that source's
first build. Alternatively supply `--native`, `--exporter` and `--wasm`
explicitly. Supplied paths are hashed, but callers must verify their build
correspondence; the manifest does not pretend a path proves a source build.

The order rotates across repeats. Each repeat has new backend state and a
fresh generated directory. There is no OS cache flush or cold-cache claim.
The whole import chain is referenced by the query; increasing file count
does not merely add unrelated files. There is no automatic scaling campaign.

Run a separate `--no-sample` output to assess observer effects. This does not
retroactively correct sampled times. The included fixed-workload ABBA
resource control is a diagnostic check, not a qualified overhead estimate.

## Timing and resource definitions

- RPC latency starts immediately before writing the framed request and ends
  after decoding the matching response. Snapshot acquisition is recorded
  separately. The report's snapshot-plus-type clock covers both requests in
  order, including any queued document analysis. This avoids treating work
  performed before the type request as free. Individual type-only timings
  remain in the raw output. Correctness assertions and result-file writes are
  outside both clocks.
- Record spawn, initialize response, first query, warm queries, edit-to-correct
  response and shutdown separately. Launch-to-correct includes the sampler
  readiness barrier when sampling is enabled. It is not pure backend startup.
- Fixture generation and typeshed export happen before the backend clock and
  are reported as setup. There is no private capture/cache adapter; WASI
  reads the generated disk directory through standard WASI filesystem APIs.
- Windows and Linux samplers observe the creation-bound backend PID,
  descendants visible during sampling, OS threads, CPU counters and RSS
  every 100 ms. Node's V8, I/O and Worker threads are included. Thread counts
  are not analysis-worker counts and do not imply utilization.
- Per-thread intervals use PID and thread creation identity. Short-lived
  processes/threads can be missed; inaccessible observations are reported.
  OS CPU counters can be coarse: a zero observed delta does not prove a thread
  never ran. Node's logical Worker ID is not an OS thread ID.
  macOS collection is `NOT_MEASURED`, not a fabricated zero.
- One-core-equivalent utilization is observed process CPU delta divided by
  observation wall time, multiplied by 100. Machine-normalized utilization
  divides that percentage by the logical CPU count. Parallel work can exceed
  100% in the one-core convention.
- CPU is the observed backend host footprint, not exclusive query or guest
  CPU. Peak RSS is the largest sampled sum, not a continuously observed peak.
  Power is `NOT_MEASURED`; no CPU isolation is established.

Smoke values and small repeat quantiles are descriptive. A pass establishes
only the specific query/edit/session contract, not feature parity, throughput
over an entire project, cancellation parity, or a rollout decision.

## Outputs

- `manifest.json`: frozen options, source identity, artifact hashes,
  environment and limits.
- `results.json`, `summary.json`, `report.md`: all planned session outcomes,
  correctness-qualified timing and resource summaries.
- Per-session `wire.json`, `result.json`, `fixture.json`, `resources.json`:
  decoded messages, failures, immutable disk-source hashes and raw
  process/thread resource observations.

Never pool this output with older editor/Pylance hover results. Those measure
a different boundary, and private historical fixtures are deliberately absent.

## Validation

```sh
node --test scripts/tsp_benchmark/benchmark.test.cjs scripts/tsp_benchmark/wasi-directories.test.cjs
python scripts/tsp_benchmark/sample_test.py
node scripts/tsp_benchmark/resource-control.cjs target/resource-control.json
```

The resource control uses only its own synthetic process and child and checks
CPU work, thread/lifetime separation and retirement. It must not enumerate or
terminate unrelated workloads.

This directory is preparation for human review, not an autonomous upstream
submission. Follow the repository's contribution and AI policies, provide
human-authored motivation, and do not check the human-understanding assertion
without actually reviewing the code.
