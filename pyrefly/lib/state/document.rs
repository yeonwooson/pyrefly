/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::anyhow;
use lsp_types::TextDocumentContentChangeEvent;
use pyrefly_util::lock::Mutex;
use pyrefly_util::lock::RwLock;
use ruff_source_file::LineIndex;
use ruff_source_file::OneIndexed;
use ruff_source_file::SourceLocation;

use crate::state::load::LspFile;

pub type OpenFiles = RwLock<HashMap<PathBuf, Arc<LspFile>>>;
pub type DocumentVersions = Mutex<HashMap<PathBuf, i32>>;

pub fn open_document(
    files: &OpenFiles,
    versions: &DocumentVersions,
    path: PathBuf,
    version: i32,
    contents: Arc<LspFile>,
) {
    versions.lock().insert(path.clone(), version);
    files.write().insert(path, contents);
}

pub fn change_document(
    files: &OpenFiles,
    versions: &DocumentVersions,
    path: &Path,
    version: i32,
    changes: Vec<TextDocumentContentChangeEvent>,
) -> anyhow::Result<()> {
    let mut lock = files.write();
    let original = lock
        .get_mut(path)
        .ok_or_else(|| anyhow!("File not found in open_files: {}", path.display()))?;
    *original = Arc::new(LspFile::from_source(apply_change_events(
        original.get_string(),
        changes,
    )));
    drop(lock);
    versions.lock().insert(path.to_owned(), version);
    Ok(())
}

pub fn apply_change_events(original: &str, changes: Vec<TextDocumentContentChangeEvent>) -> String {
    fn position_to_usize(
        position: lsp_types::Position,
        index: &LineIndex,
        source_text: &str,
    ) -> usize {
        let source_location = SourceLocation {
            line: OneIndexed::from_zero_indexed(position.line as usize),
            character_offset: OneIndexed::from_zero_indexed(position.character as usize),
        };
        index
            .offset(
                source_location,
                source_text,
                ruff_source_file::PositionEncoding::Utf16,
            )
            .to_usize()
    }

    let mut result = original.to_owned();
    for change in changes {
        let TextDocumentContentChangeEvent { range, text, .. } = change;
        match range {
            None => result = text,
            Some(range) => {
                let index = LineIndex::from_source_text(&result);
                let start = position_to_usize(range.start, &index, &result);
                let end = position_to_usize(range.end, &index, &result);
                result.replace_range(start..end, &text);
            }
        }
    }
    result
}

#[cfg(test)]
mod shared_document_tests {
    use super::*;

    #[test]
    fn utf16_edit_and_versions_use_the_shared_document_path() {
        let path = PathBuf::from("main.py");
        let files = OpenFiles::default();
        let versions = DocumentVersions::default();
        open_document(
            &files,
            &versions,
            path.clone(),
            1,
            Arc::new(LspFile::from_source("x = '\u{1f600}'\r\n".to_owned())),
        );
        change_document(
            &files,
            &versions,
            &path,
            2,
            vec![TextDocumentContentChangeEvent {
                range: Some(lsp_types::Range::new(
                    lsp_types::Position::new(0, 5),
                    lsp_types::Position::new(0, 7),
                )),
                range_length: None,
                text: "ok".to_owned(),
            }],
        )
        .unwrap();
        assert_eq!(files.read()[&path].get_string(), "x = 'ok'\r\n");
        assert_eq!(versions.lock()[&path], 2);
    }

    #[test]
    fn rejected_change_does_not_publish_a_version() {
        let files = OpenFiles::default();
        let versions = DocumentVersions::default();
        let path = PathBuf::from("missing.py");
        assert!(change_document(&files, &versions, &path, 5, Vec::new()).is_err());
        assert!(versions.lock().is_empty());
        assert!(files.read().is_empty());
    }
}
