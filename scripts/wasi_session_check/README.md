# Filesystem session WASI validation

This is the runnable validation fixture for the experimental
[filesystem session proposal](https://github.com/meta/pyrefly/pull/5599).
It is a handoff experiment, not a production ABI, complete TSP backend or
recommendation to add a separate session abstraction.

The fixture reuses the exact JavaScript filesystem from the public
[host-filesystem discussion prototype](https://github.com/meta/pyrefly/pull/5565).
That discussion PR is closed without merging. The checker downloads its pinned
public source and verifies its SHA-256 before importing it. It does not copy the
maintainer's filesystem implementation into this change.

## Run

Use the draft's branch, not upstream main. Install Rust's `wasm32-wasip1` target
and public WASI SDK 34. Set `WASI_SDK_PATH`, `CC_wasm32_wasip1`,
`AR_wasm32_wasip1` and `WASI_SYSROOT` for that SDK as required by the host.
Node 24.15.0 and public Rust 1.99.1 were used for validation.

From the repository root:

```sh
cargo build --manifest-path scripts/wasi_session_check/guest/Cargo.toml --target wasm32-wasip1 --locked
node scripts/wasi_session_check/check.mjs --wasm scripts/wasi_session_check/guest/target/wasm32-wasip1/debug/filesystem_tsp_session_check.wasm
```

If `CARGO_TARGET_DIR` is set, pass the artifact in that target directory instead.
Append `--output <new-file.json>` to keep the observations; existing files are
never overwritten. `--bridge <local-file.js>` uses an already downloaded public
bridge, with the same checksum verification, so execution can be offline.

The 29 checks exercise actual computed-type results, an unsaved imported edit,
restoration, newly created and removed imports, function declaration ranges,
stale-snapshot errors, stable repeated queries, invalid input and disposed
handles. No dummy generation-only query is accepted as evidence.

The Rust adapter uses a trusted host's paired allocation/call/free operations,
serialized requests and an 8 MiB guest stack. It is not hardened for untrusted
callers, cancellation, concurrent access or production packaging. No Pylance
integration or performance comparison is claimed.
