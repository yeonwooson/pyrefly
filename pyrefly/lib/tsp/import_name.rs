/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Transport-independent resolution of TSP import descriptors to Python module names.

use lsp_server::ResponseError;
use pyrefly_python::module_name::ModuleName;
use ruff_python_ast::name::Name;

use crate::tsp::validation::invalid_params_error;

/// Resolve a TSP module descriptor into a pyrefly [`ModuleName`].
///
/// For absolute imports (`leading_dots == 0`), the name parts are joined
/// with dots (e.g., `["os", "path"]` -> `ModuleName("os.path")`).
///
/// For relative imports (`leading_dots > 0`), the source module's name
/// and `is_init` status are used with [`ModuleName::new_maybe_relative`]
/// to resolve to an absolute module name. For example, if the source
/// module is `a.b.c` and the import is `from ..foo import bar`
/// (leading_dots=2, name_parts=["foo"]), the result is `a.foo`.
pub fn resolve_module_name(
    name_parts: &[String],
    leading_dots: i32,
    source_module: ModuleName,
    is_init: bool,
) -> Result<ModuleName, ResponseError> {
    if leading_dots < 0 {
        return Err(invalid_params_error("leadingDots must be non-negative"));
    }

    if leading_dots == 0 {
        // Absolute import: name parts must be non-empty.
        if name_parts.is_empty() {
            return Err(invalid_params_error(
                "nameParts must be non-empty for absolute imports",
            ));
        }
        Ok(ModuleName::from_parts(name_parts))
    } else {
        // Relative import: resolve against the source module.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_absolute_import_single_part() {
        let name =
            resolve_module_name(&["os".to_owned()], 0, ModuleName::from_str("any"), false).unwrap();
        assert_eq!(name.as_str(), "os");
    }

    #[test]
    fn test_absolute_import_multi_part() {
        let name = resolve_module_name(
            &["os".to_owned(), "path".to_owned()],
            0,
            ModuleName::from_str("any"),
            false,
        )
        .unwrap();
        assert_eq!(name.as_str(), "os.path");
    }

    #[test]
    fn test_absolute_import_empty_parts_is_error() {
        let result = resolve_module_name(&[], 0, ModuleName::from_str("any"), false);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("nameParts must be non-empty"));
    }

    #[test]
    fn test_negative_leading_dots_is_error() {
        let result =
            resolve_module_name(&["foo".to_owned()], -1, ModuleName::from_str("any"), false);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("leadingDots must be non-negative"));
    }

    #[test]
    fn test_relative_import_single_dot_with_name() {
        let name = resolve_module_name(
            &["utils".to_owned()],
            1,
            ModuleName::from_str("a.b.c"),
            false,
        )
        .unwrap();
        assert_eq!(name.as_str(), "a.b.utils");
    }

    #[test]
    fn test_relative_import_two_dots_with_name() {
        let name =
            resolve_module_name(&["foo".to_owned()], 2, ModuleName::from_str("a.b.c"), false)
                .unwrap();
        assert_eq!(name.as_str(), "a.foo");
    }

    #[test]
    fn test_relative_import_from_init() {
        let name = resolve_module_name(&["utils".to_owned()], 1, ModuleName::from_str("a.b"), true)
            .unwrap();
        assert_eq!(name.as_str(), "a.b.utils");
    }

    #[test]
    fn test_relative_import_bare_dot_no_parts() {
        let name = resolve_module_name(&[], 1, ModuleName::from_str("a.b.c"), false).unwrap();
        assert_eq!(name.as_str(), "a.b");
    }

    #[test]
    fn test_relative_import_too_many_dots_is_error() {
        let result =
            resolve_module_name(&["foo".to_owned()], 4, ModuleName::from_str("a.b.c"), false);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("relative import level exceeds"));
    }

    #[test]
    fn test_deeply_nested_absolute_import() {
        let parts: Vec<String> = vec![
            "a".to_owned(),
            "b".to_owned(),
            "c".to_owned(),
            "d".to_owned(),
        ];
        let name = resolve_module_name(&parts, 0, ModuleName::from_str("any"), false).unwrap();
        assert_eq!(name.as_str(), "a.b.c.d");
    }

    #[test]
    fn test_relative_import_multi_part_suffix() {
        let name = resolve_module_name(
            &["parent".to_owned(), "module".to_owned()],
            2,
            ModuleName::from_str("a.b.c"),
            false,
        )
        .unwrap();
        assert_eq!(name.as_str(), "a.parent.module");
    }

    #[test]
    fn test_relative_import_from_init_bare_dot() {
        let name = resolve_module_name(&[], 1, ModuleName::from_str("a.b"), true).unwrap();
        assert_eq!(name.as_str(), "a.b");
    }

    #[test]
    fn test_import_errors_preserve_protocol_shape() {
        for (parts, dots, message) in [
            (
                vec![],
                0,
                "nameParts must be non-empty for absolute imports",
            ),
            (
                vec!["helper".to_owned()],
                -1,
                "leadingDots must be non-negative",
            ),
            (vec![], i32::MIN, "leadingDots must be non-negative"),
            (
                vec![],
                i32::MAX,
                "relative import level exceeds source module depth",
            ),
        ] {
            let error = resolve_module_name(&parts, dots, ModuleName::from_str("a.b.c"), false)
                .unwrap_err();
            assert_eq!(error.code, -32602);
            assert_eq!(error.message, format!("Invalid params: {message}"));
            assert!(error.data.is_none());
        }
    }
}
