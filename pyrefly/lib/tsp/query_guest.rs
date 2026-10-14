/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Explicit filesystem/configuration boundary for the portable document session.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use dupe::Dupe;
use lsp_server::ResponseError;
use lsp_types::Url;
use pyrefly_python::sys_info::PythonPlatform;
use pyrefly_python::sys_info::PythonVersion;
use pyrefly_util::arc_id::ArcId;
use pyrefly_util::thread_pool::ThreadCount;
use serde::Deserialize;
use serde_json::Value;

use crate::config::config::ConfigFile;
use crate::config::config::DirectoryRelativeFallbackSearchPathCache;
use crate::config::config::FallbackSearchPath;
use crate::config::finder::ConfigFinder;
use crate::state::state::State;

const MAX_SEARCH_ROOTS: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializationOptions {
    python_version: [u32; 3],
    python_platform: String,
    search_paths: Vec<String>,
}

pub struct QueryGuest {
    pub(super) config: ArcId<ConfigFile>,
    pub(super) state: State,
    pub(super) snapshot: i32,
}

impl QueryGuest {
    pub fn new(
        root_uri: Option<Url>,
        initialization_options: Option<Value>,
    ) -> Result<Self, ResponseError> {
        let root_uri = root_uri.ok_or_else(|| error(-32602, "initialize.rootUri is required"))?;
        let root = local_path(&root_uri)?;
        if root != Path::new("/workspace") || !root.is_dir() {
            return Err(error(
                -32602,
                "Workspace root must be the mounted /workspace directory",
            ));
        }
        let options: InitializationOptions = serde_json::from_value(
            initialization_options
                .ok_or_else(|| error(-32602, "initialize.initializationOptions is required"))?,
        )
        .map_err(|e| error(-32602, &e.to_string()))?;
        let [major, minor, micro] = options.python_version;
        if major != 3 || !(8..=14).contains(&minor) || micro != 0 {
            return Err(error(
                -32602,
                "pythonVersion must be [3, minor, 0], with minor in 8..=14",
            ));
        }
        if !matches!(
            options.python_platform.as_str(),
            "win32" | "linux" | "darwin"
        ) {
            return Err(error(
                -32602,
                "pythonPlatform must be win32, linux, or darwin",
            ));
        }
        if options.search_paths.is_empty() || options.search_paths.len() > MAX_SEARCH_ROOTS {
            return Err(error(
                -32602,
                "searchPaths must contain between 1 and 32 roots",
            ));
        }
        let mut roots = Vec::new();
        for (index, value) in options.search_paths.into_iter().enumerate() {
            let expected = if index == 0 {
                "/workspace".to_owned()
            } else {
                format!("/search/{}", index - 1)
            };
            if value != expected || !Path::new(&value).is_dir() {
                return Err(error(
                    -32602,
                    "searchPaths must list existing /workspace, /search/0, ... mounts in order",
                ));
            }
            roots.push(PathBuf::from(value));
        }
        let mut config = ConfigFile::default();
        config.python_environment.set_empty_to_default();
        config.interpreters.skip_interpreter_query = true;
        config.python_environment.python_version = Some(PythonVersion::new(major, minor, micro));
        config.python_environment.python_platform =
            Some(PythonPlatform::new(&options.python_platform));
        config.search_path_from_args = roots;
        config.disable_search_path_heuristics = true;
        if !config.configure().is_empty() {
            return Err(error(
                -32602,
                "Invalid explicit Python environment configuration",
            ));
        }
        let config = ArcId::new(config);
        Ok(Self {
            state: State::new(saved_config_finder(&config), ThreadCount::Inline),
            config,
            snapshot: 0,
        })
    }

    pub fn snapshot(&self) -> i32 {
        self.snapshot
    }
}

fn saved_config_finder(config: &ArcId<ConfigFile>) -> ConfigFinder {
    let roots: Vec<_> = config
        .search_path_from_args
        .iter()
        .map(|root| {
            let mut scoped = ConfigFile::clone(config);
            scoped.disable_search_path_heuristics = false;
            scoped.fallback_search_path = FallbackSearchPath::DirectoryRelative(
                DirectoryRelativeFallbackSearchPathCache::new(Some(root.clone())),
            );
            (root.clone(), ArcId::new(scoped))
        })
        .collect();
    let before = config.dupe();
    let load = config.dupe();
    let fallback = config.dupe();
    ConfigFinder::new_custom(
        Box::new(move |_, path| {
            // The cache's bound only applies to paths beneath it. Select the
            // matching mount for every importer; bundled paths keep no fallback.
            Ok(Some(
                roots
                    .iter()
                    .find(|(root, _)| path.as_path().starts_with(root))
                    .map_or_else(|| before.dupe(), |(_, scoped)| scoped.dupe()),
            ))
        }),
        // `before` always returns a config, so discovery is never entered.
        Box::new(move |_| (load.dupe(), Vec::new())),
        Box::new(move |_, _| fallback.dupe()),
        Box::new(|| {}),
    )
}

pub(super) fn local_path(uri: &Url) -> Result<PathBuf, ResponseError> {
    if uri.scheme() != "file"
        || uri.host_str().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        return Err(error(
            -32602,
            "Expected a local file URI without authority, query, or fragment",
        ));
    }
    let path = uri
        .to_file_path()
        .map_err(|_| error(-32602, "Expected an absolute file path"))?;
    if !path.is_absolute()
        || path.to_string_lossy().contains(['\\', '\0'])
        || path
            .components()
            .any(|x| matches!(x, Component::ParentDir | Component::CurDir))
        || Url::from_file_path(&path).ok().as_ref() != Some(uri)
    {
        return Err(error(-32602, "Expected a canonical absolute file URI"));
    }
    Ok(path)
}

pub(super) fn valid_position(source: &str, line: u32, character: u32) -> bool {
    let Some(text) = source.split('\n').nth(line as usize) else {
        return false;
    };
    let mut offset = 0;
    for ch in text.strip_suffix('\r').unwrap_or(text).chars() {
        if offset == character {
            return true;
        }
        offset += ch.len_utf16() as u32;
        if offset > character {
            return false;
        }
    }
    offset == character
}

pub fn error(code: i32, message: &str) -> ResponseError {
    ResponseError {
        code,
        message: message.to_owned(),
        data: None,
    }
}
