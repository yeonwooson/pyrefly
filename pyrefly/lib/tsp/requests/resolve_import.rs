/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Implementation of the `typeServer/resolveImport` TSP request.
//!
//! Resolves a Python import (absolute or relative) to the file URI that
//! contains the target module.  The heavy lifting is delegated to
//! pyrefly's existing `find_import` infrastructure via
//! [`Transaction::import_handle`].

use lsp_server::RequestId;
use lsp_types::Uri;
use pyrefly_python::module_path::ModulePath;
use pyrefly_util::telemetry::TelemetryEvent;
use tsp_types::protocol::ResolveImportParams;

use crate::lsp::module_helpers::to_real_path;
use crate::lsp::non_wasm::server::TspInterface;
use crate::lsp::non_wasm::transaction_manager::TransactionManager;
use crate::tsp::import_name::resolve_module_name;
use crate::tsp::server::Reply;
use crate::tsp::server::TspServer;
use crate::tsp::validation::parse_uri;

impl<T: TspInterface> TspServer<T> {
    /// Handle a `typeServer/resolveImport` request.
    ///
    /// Converts the TSP [`ResolveImportParams`] into pyrefly's internal
    /// module name, resolves via [`Transaction::import_handle`], and returns
    /// the resolved module's file URI as a string (or JSON `null` if the
    /// module cannot be found).
    pub fn handle_resolve_import<'a>(
        &'a self,
        id: RequestId,
        params: ResolveImportParams,
        ide_transaction_manager: &mut TransactionManager<'a>,
        telemetry_event: &mut TelemetryEvent,
        reply: Reply,
    ) {
        self.answer_at_snapshot(id, reply, params.snapshot, || {
            // --- 1. Parse and resolve source URI ---
            let source_url = parse_uri(&params.source_uri)?;
            let Some(source_path) = self.inner().resolve_uri_to_path(&source_url) else {
                // URI cannot be resolved to a filesystem path — return null.
                return Ok(None);
            };

            // --- 2. Build source handle and resolve the module name ---
            let source_module_path = ModulePath::filesystem(source_path.clone());
            let source_handle = self.inner().handle_from_module_path(source_module_path);

            let module_name = resolve_module_name(
                &params.module_descriptor.name_parts,
                params.module_descriptor.leading_dots,
                source_handle.module(),
                source_path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .is_some_and(|f| f == "__init__.py" || f == "__init__.pyi"),
            )?;

            // --- 3. Resolve the import via existing infrastructure ---
            let transaction = self
                .inner()
                .non_committable_transaction(ide_transaction_manager);
            let result = transaction.import_handle(&source_handle, module_name, None);

            // --- 4. Convert result to URI string (or null) ---
            let uri_string: Option<String> = result.finding().and_then(|handle| {
                to_real_path(handle.path()).and_then(|path| {
                    Uri::from_file_path(path.canonicalize().unwrap_or(path))
                        .ok()
                        .map(|u| u.to_string())
                })
            });

            // Hand the transaction back. `non_committable_transaction` took it out
            // of the manager, and it may carry a solve that a type query saved
            // while a recheck held the committing lock; dropping it here would make
            // the next query redo that work.
            ide_transaction_manager.save(transaction, telemetry_event);

            Ok(uri_string)
        });
    }
}
