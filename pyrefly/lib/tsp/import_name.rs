/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use lsp_server::ResponseError;
use pyrefly_python::module_name::ModuleName;
use ruff_python_ast::name::Name;

use crate::tsp::validation::invalid_params_error;

pub(crate) fn resolve_module_name(
    name_parts: &[String],
    leading_dots: i32,
    source_module: ModuleName,
    is_init: bool,
) -> Result<ModuleName, ResponseError> {
    if leading_dots < 0 {
        return Err(invalid_params_error("leadingDots must be non-negative"));
    }
    if leading_dots == 0 {
        if name_parts.is_empty() {
            return Err(invalid_params_error(
                "nameParts must be non-empty for absolute imports",
            ));
        }
        Ok(ModuleName::from_parts(name_parts))
    } else {
        let suffix = if name_parts.is_empty() {
            None
        } else {
            Some(Name::new(name_parts.join(".")))
        };
        source_module
            .new_maybe_relative(is_init, leading_dots as u32, suffix.as_ref())
            .ok_or_else(|| {
                invalid_params_error("relative import level exceeds source module depth")
            })
    }
}
