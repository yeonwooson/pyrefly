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
}

impl<'a> MemoryFilesLookup<'a> {
    pub fn new(base: &'a MemoryFiles, overlay: &'a MemoryFilesOverlay) -> Self {
        Self { base, overlay }
    }

    pub fn get(&self, path: &Path) -> Option<&'a Arc<FileContents>> {
        match self.overlay.0.get(path) {
            Some(contents) => contents.as_ref(), // Might be a None if deleted
            None => self.base.0.get(path),
        }
    }

    pub fn paths(&self) -> impl Iterator<Item = &PathBuf> {
        let overlay = &self.overlay.0;
        self.base
            .0
            .keys()
            .filter(move |path| !overlay.contains_key(*path))
            .chain(
                overlay
                    .iter()
                    .filter_map(|(path, contents)| contents.as_ref().map(|_| path)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths_hide_removed_unsaved_dependency() {
        let open = PathBuf::from("open.py");
        let closed = PathBuf::from("closed.py");
        let added = PathBuf::from("added.py");
        let contents = Arc::new(FileContents::from_source("value = 1\n".to_owned()));
        let mut initial = MemoryFilesOverlay::default();
        initial.set(open.clone(), Some(contents.clone()));
        initial.set(closed.clone(), Some(contents.clone()));
        let mut base = MemoryFiles::default();
        base.apply_overlay(initial);
        let mut overlay = MemoryFilesOverlay::default();
        overlay.set(open.clone(), Some(contents.clone()));
        overlay.set(closed.clone(), None);
        overlay.set(added.clone(), Some(contents));
        let lookup = MemoryFilesLookup::new(&base, &overlay);
        let mut paths = lookup.paths().cloned().collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths, vec![added, open]);
        assert!(lookup.get(&closed).is_none());
    }
}
