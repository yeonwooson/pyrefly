/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Internal TSP support shared by the native server and WASI hosts.
//!
//! The Rust interface is unstable. Transport-independent type conversion,
//! validation, and import-name resolution are available on WASI. The browser
//! (`wasm32-unknown-unknown`) build does not expose this module.

pub mod import_name;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod requests;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod server;
pub(crate) mod type_conversion;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod type_facts;
pub mod validation;

pub use type_conversion::convert_type_in_transaction;
