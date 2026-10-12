/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::collections::HashMap;
use std::fmt::Debug;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::state::load::FileContents;

#[derive(Debug, Clone, Default)]
pub struct MemoryFiles(HashMap<PathBuf, Arc<FileContents>>);

#[derive(Debug, Default, Clone)]
pub struct MemoryFilesOverlay(HashMap<PathBuf, Option<Arc<FileContents>>>);

impl MemoryFiles {
    pub fn apply_overlay(&mut self, overlay: MemoryFilesOverlay) {
        for (path, contents) in overlay.0.into_iter() {
            match contents {
                None => self.0.remove(&path),
                Some(contents) => self.0.insert(path, contents),
            };
        }
    }
}

impl MemoryFilesOverlay {
    pub fn set(&mut self, path: PathBuf, contents: Option<Arc<FileContents>>) {
        self.0.insert(path, contents);
    }
}

pub struct MemoryFilesLookup<'a> {
    base: &'a MemoryFiles,
    overlay: &'a MemoryFilesOverlay,
    filesystem_overlays: bool,
}

impl<'a> MemoryFilesLookup<'a> {
    pub fn new(base: &'a MemoryFiles, overlay: &'a MemoryFilesOverlay) -> Self {
        Self {
            base,
            overlay,
            filesystem_overlays: false,
        }
    }

    pub fn with_filesystem_overlays(mut self, enabled: bool) -> Self {
        self.filesystem_overlays = enabled;
        self
    }

    pub fn filesystem_overlays(&self) -> bool {
        self.filesystem_overlays
    }

    pub fn get(&self, path: &Path) -> Option<&'a Arc<FileContents>> {
        match self.overlay.0.get(path) {
            Some(contents) => contents.as_ref(), // Might be a None if deleted
            None => self.base.0.get(path),
        }
    }
}

#[cfg(test)]
mod filesystem_overlay_tests {
    use super::*;

    #[test]
    fn filesystem_overlay_policy_is_opt_in_and_preserves_removal() {
        let path = PathBuf::from("helper.py");
        let mut base = MemoryFiles::default();
        let mut initial = MemoryFilesOverlay::default();
        initial.set(
            path.clone(),
            Some(Arc::new(FileContents::from_source(
                "value: int = 1\n".to_owned(),
            ))),
        );
        base.apply_overlay(initial);
        let mut dirty = MemoryFilesOverlay::default();
        dirty.set(
            path.clone(),
            Some(Arc::new(FileContents::from_source(
                "value: str = 'x'\n".to_owned(),
            ))),
        );
        let lookup = MemoryFilesLookup::new(&base, &dirty);
        assert!(!lookup.filesystem_overlays());
        let lookup = lookup.with_filesystem_overlays(true);
        assert!(lookup.filesystem_overlays());
        assert_eq!(
            lookup.get(&path).unwrap().as_ref(),
            &FileContents::from_source("value: str = 'x'\n".to_owned())
        );
        dirty.set(path.clone(), None);
        assert!(
            MemoryFilesLookup::new(&base, &dirty)
                .with_filesystem_overlays(true)
                .get(&path)
                .is_none()
        );
    }
}
