/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Shared native/WASI conversion against the transaction that computed a type.

use dupe::Dupe;
use pyrefly_build::handle::Handle;
use pyrefly_python::module_name::ModuleName;
use pyrefly_python::module_path::ModulePath;
use ruff_python_ast::name::Name;
use ruff_text_size::Ranged;
use starlark_map::Hashed;

use crate::binding::binding::KeyUndecoratedFunctionRange;
use crate::lsp::module_helpers::to_real_path;
use crate::state::state::Transaction;
use crate::tsp::type_conversion::StdlibClasses;
use crate::tsp::type_conversion::convert_type_with_resolvers;

/// Reuse the query's SysInfo and warm Stdlib for every declaration resolver.
pub fn convert_type_in_transaction(
    transaction: &Transaction,
    source_handle: &Handle,
    ty: &pyrefly_types::types::Type,
) -> tsp_types::Type {
    let resolve_func_range = |func_id: &pyrefly_types::callable::FuncId| {
        let def_index = func_id.def_index?;
        let handle = Handle::new(
            func_id.module.name(),
            func_id.module.path().dupe(),
            source_handle.sys_info().dupe(),
        );
        let bindings = transaction.get_bindings(&handle)?;
        let key = KeyUndecoratedFunctionRange(def_index);
        let idx = bindings.key_to_idx_hashed_opt(Hashed::new(&key))?;
        Some(bindings.get(idx).0.range())
    };
    let resolve_module_path = |module: &pyrefly_types::module::ModuleType| {
        let module_name = ModuleName::from_str(&module.to_string());
        let finding = transaction
            .import_handle(source_handle, module_name, None)
            .finding()?;
        let path = to_real_path(finding.path())?;
        Some(path.canonicalize().unwrap_or(path))
    };
    let resolve_export = |module_name: ModuleName, name: &Name| {
        resolve_export_location(transaction, source_handle, module_name, name)
    };
    let stdlib = transaction.get_stdlib(source_handle);
    convert_type_with_resolvers(
        ty,
        Some(&resolve_func_range),
        Some(&resolve_module_path),
        Some(&resolve_export),
        StdlibClasses {
            none_type: stdlib.none_type(),
            bool_type: stdlib.bool(),
            int_type: stdlib.int(),
        },
    )
}

/// Follow re-exports in the source handle's already-computed import context.
pub(crate) fn resolve_export_location(
    transaction: &Transaction,
    source_handle: &Handle,
    module_name: ModuleName,
    name: &Name,
) -> Option<(ModulePath, lsp_types::Range)> {
    let target_handle = transaction
        .import_handle(source_handle, module_name, None)
        .finding()?;
    let (module, range) = transaction.lookup_export_location(&target_handle, name)?;
    Some((module.path().dupe(), module.to_lsp_range(range)))
}
