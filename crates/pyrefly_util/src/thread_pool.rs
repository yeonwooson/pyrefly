/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Utilities for creating the initial thread pool.

use std::env;
use std::num::NonZeroUsize;
use std::str::FromStr;

#[cfg(not(target_os = "wasi"))]
use human_bytes::human_bytes;
#[cfg(not(target_os = "wasi"))]
use tracing::debug;
use tracing::info;

use crate::display::number_thousands;

/// The stack size for all created threads.
///
/// Can be overridden by setting the `PYREFLY_STACK_SIZE` environment variable (in bytes).
const DEFAULT_STACK_SIZE: usize = 10 * 1024 * 1024;

#[derive(Default, Debug, Copy, Clone, PartialEq, Eq)]
pub enum ThreadCount {
    #[default]
    AllThreads,
    NumThreads(NonZeroUsize),
    /// Run all work inline on the calling thread with no rayon pool. A rayon pool
    /// — even single-threaded — dispatches work to a worker and blocks the caller
    /// on a `futex` for the whole run; running inline keeps the work on the calling
    /// thread and avoids that syscall.
    Inline,
}

/// Thread count used by tests. Enough threads to see parallelism bugs, but not too many to debug through.
pub const TEST_THREAD_COUNT: ThreadCount = ThreadCount::NumThreads(NonZeroUsize::new(3).unwrap());

impl FromStr for ThreadCount {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.parse::<usize>() {
            Ok(n) => match NonZeroUsize::new(n) {
                None => Ok(ThreadCount::AllThreads),
                Some(n) => Ok(ThreadCount::NumThreads(n)),
            },
            Err(e) => Err(format!(
                "Failed to parse thread count, expected number, failed due to {e}"
            )),
        }
    }
}

/// A WASM compatible thread-pool.
pub struct ThreadPool(
    // A Rayon field's drop glue retains pthread imports even when always None.
    #[cfg(not(target_os = "wasi"))] Option<rayon::ThreadPool>,
);

impl ThreadPool {
    pub fn stack_size() -> usize {
        match env::var("PYREFLY_STACK_SIZE") {
            Ok(s) => {
                let res = s
                    .parse::<usize>()
                    .unwrap_or_else(|_| panic!("$PYREFLY_STACK_SIZE must be a number, got {s}"));
                info!(
                    "Using stack size of {} bytes (due to `$PYREFLY_STACK_SIZE`)",
                    number_thousands(res)
                );
                res
            }
            Err(_) => DEFAULT_STACK_SIZE,
        }
    }

    #[cfg(target_os = "wasi")]
    pub fn new(_count: ThreadCount) -> Self {
        Self()
    }

    #[cfg(not(target_os = "wasi"))]
    pub fn new(count: ThreadCount) -> Self {
        if cfg!(target_arch = "wasm32") || count == ThreadCount::Inline {
            // No pool: WASM can't spawn threads, and `Inline` deliberately runs
            // work on the calling thread. `spawn_many`/`install` then invoke their
            // closures directly, with no worker handoff.
            return Self(None);
        }

        let stack_size = Self::stack_size();
        let mut builder = rayon::ThreadPoolBuilder::new().stack_size(stack_size);
        match count {
            ThreadCount::NumThreads(threads) => {
                builder = builder.num_threads(threads.get());
            }
            ThreadCount::AllThreads => {
                let max_threads = std::thread::available_parallelism()
                    .map(|n| n.get().min(64))
                    .unwrap_or(1);
                builder = builder.num_threads(max_threads);
            }
            ThreadCount::Inline => unreachable!("handled by the early return above"),
        }
        let pool = builder.build().expect("To be able to build a thread pool");
        // Only print the message once
        debug!(
            "Running with {} threads ({} stack size)",
            pool.current_num_threads(),
            human_bytes(stack_size as f64)
        );
        Self(Some(pool))
    }

    /// Spawns `f` on the thread pool, or runs it directly if running single-threaded.
    /// Note that this will block the entire thread pool until the work is complete.
    #[cfg(target_os = "wasi")]
    pub fn spawn_many(&self, f: impl Fn() + Sync) {
        f()
    }

    #[cfg(not(target_os = "wasi"))]
    pub fn spawn_many(&self, f: impl Fn() + Sync) {
        match &self.0 {
            None => f(),
            Some(pool) => {
                pool.scope(|s| {
                    for _ in 0..pool.current_num_threads() {
                        // Only run work on Rayon threads, as we increased their stack limit
                        s.spawn(|_| f());
                    }
                })
            }
        }
    }

    #[cfg(target_os = "wasi")]
    pub fn async_spawn(&self, f: impl FnOnce() + Send + 'static) {
        f()
    }

    #[cfg(not(target_os = "wasi"))]
    pub fn async_spawn(&self, f: impl FnOnce() + Send + 'static) {
        match &self.0 {
            None => f(),
            Some(pool) => {
                pool.spawn(f);
            }
        }
    }

    // See rayon::ThreadPool::install
    pub fn install<OP, R>(&self, op: OP) -> R
    where
        OP: FnOnce() -> R + Send,
        R: Send,
    {
        #[cfg(target_os = "wasi")]
        {
            op()
        }
        #[cfg(not(target_os = "wasi"))]
        match &self.0 {
            None => op(),
            Some(pool) => pool.install(op),
        }
    }
}

#[cfg(test)]
mod portable_pool_tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::{ThreadCount, ThreadPool};

    #[test]
    fn inline_pool_executes_on_the_calling_thread() {
        let pool = ThreadPool::new(ThreadCount::Inline);
        let current = std::thread::current().id();
        assert_eq!(pool.install(|| std::thread::current().id()), current);
        let calls = Arc::new(AtomicUsize::new(0));
        pool.spawn_many(|| {
            assert_eq!(std::thread::current().id(), current);
            calls.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let completed = Arc::clone(&calls);
        pool.async_spawn(move || {
            assert_eq!(std::thread::current().id(), current);
            completed.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_pool_still_dispatches_to_rayon() {
        let pool = ThreadPool::new(ThreadCount::NumThreads(
            std::num::NonZeroUsize::new(2).unwrap(),
        ));
        assert_ne!(
            pool.install(|| std::thread::current().id()),
            std::thread::current().id()
        );
        let calls = AtomicUsize::new(0);
        pool.spawn_many(|| {
            calls.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
