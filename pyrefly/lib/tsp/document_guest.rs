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

use dupe::Dupe;
use lsp_server::ResponseError;
use lsp_types::DidChangeTextDocumentParams;
use lsp_types::DidChangeWatchedFilesParams;
use lsp_types::DidCloseTextDocumentParams;
use lsp_types::DidOpenTextDocumentParams;
use lsp_types::DidSaveTextDocumentParams;
use lsp_types::FileChangeType;
use lsp_types::Position;
use lsp_types::PublishDiagnosticsParams;
use lsp_types::Url;
use pyrefly_build::handle::Handle;
use pyrefly_python::ast::Ast;
use pyrefly_python::module_path::ModulePath;
use pyrefly_util::events::CategorizedEvents;
use pyrefly_util::lock::Mutex;
use pyrefly_util::lock::RwLock;
use ruff_python_ast::AnyNodeRef;
use ruff_text_size::Ranged;
use ruff_text_size::TextRange;
use serde_json::Value;
use tsp_types::GetPythonSearchPathsParams;
use tsp_types::GetTypeArg;
use tsp_types::GetTypeParams;
use tsp_types::ResolveImportParams;

use crate::lsp::module_helpers::to_real_path;
use crate::state::document::DocumentVersions;
use crate::state::document::OpenFiles;
use crate::state::document::apply_change_events;
use crate::state::document::change_document;
use crate::state::document::open_document;
use crate::state::load::LspFile;
use crate::state::lsp::IdentifierContext;
use crate::state::require::Require;
use crate::state::transaction_manager::TransactionManager;
use crate::tsp::import_name::resolve_module_name;
use crate::tsp::query_guest::QueryGuest;
use crate::tsp::query_guest::error;
use crate::tsp::query_guest::local_path;
use crate::tsp::query_guest::valid_position;
use crate::tsp::transaction_conversion::convert_type_in_transaction;

const MAX_SOURCE: usize = 1024 * 1024;
const MAX_OPEN_FILES: usize = 4096;
const MAX_OPEN_BYTES: usize = 64 * 1024 * 1024;

pub enum QueryKind {
    Computed,
    Declared,
    Expected,
}

enum SourceUpdate {
    Document(Option<Arc<LspFile>>),
    Disk(CategorizedEvents),
}

pub struct DocumentGuest {
    inner: QueryGuest,
    files: OpenFiles,
    versions: DocumentVersions,
    pending_diagnostics: Vec<PublishDiagnosticsParams>,
    failed: bool,
}

impl DocumentGuest {
    pub fn new(root: Option<Url>, options: Option<Value>) -> Result<Self, ResponseError> {
        let mut inner = QueryGuest::new(root, options)?;
        inner.state.use_filesystem_overlays();
        Ok(Self {
            inner,
            files: RwLock::new(HashMap::new()),
            versions: Mutex::new(HashMap::new()),
            pending_diagnostics: Vec::new(),
            failed: false,
        })
    }

    pub fn snapshot(&self) -> i32 {
        self.inner.snapshot
    }

    pub fn check_live(&self) -> Result<(), ResponseError> {
        if self.failed {
            return Err(error(
                -32603,
                "Document session failed; retire and restart required",
            ));
        }
        Ok(())
    }

    pub fn reject_update(&mut self) {
        self.failed = true;
    }

    fn source_path(&self, uri: &Url) -> Result<PathBuf, ResponseError> {
        self.checked_source_path(uri, false)
    }

    fn checked_source_path(&self, uri: &Url, stdlib_query: bool) -> Result<PathBuf, ResponseError> {
        let path = self.admitted_path(uri, stdlib_query)?;
        if self.files.read().contains_key(&path) {
            return Ok(path);
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|reason| error(-32602, &format!("Saved document is unavailable: {reason}")))?;
        if !metadata.is_file() || metadata.len() > MAX_SOURCE as u64 {
            return Err(error(
                -32602,
                "Document must be a regular saved file within the source budget",
            ));
        }
        Ok(path)
    }

    fn admitted_path(&self, uri: &Url, stdlib_query: bool) -> Result<PathBuf, ResponseError> {
        let path = local_path(uri)?;
        let captured = self
            .inner
            .config
            .search_path_from_args
            .iter()
            .any(|root| path.starts_with(root));
        if !(captured || (stdlib_query && path.starts_with("/typeshed")))
            || !matches!(
                path.extension().and_then(|part| part.to_str()),
                Some("py" | "pyi")
            )
        {
            return Err(error(
                -32602,
                "Document must be a saved Python file under a captured root",
            ));
        }
        Ok(path)
    }

    fn query_handle(&self, path: PathBuf) -> Handle {
        let module_path = match path.strip_prefix("/typeshed") {
            Ok(relative) => ModulePath::bundled_typeshed(relative.to_owned()),
            Err(_) => ModulePath::filesystem(path),
        };
        self.inner.config.handle_from_module_path(module_path)
    }

    fn is_configured_root(&self, path: &Path) -> bool {
        self.inner
            .config
            .search_path_from_args
            .iter()
            .any(|root| path == root)
    }

    fn check_budget(&self, path: &Path, source: &str) -> Result<(), ResponseError> {
        let files = self.files.read();
        let count = files.len() + usize::from(!files.contains_key(path));
        let bytes = files
            .iter()
            .filter(|(other, _)| other.as_path() != path)
            .map(|(_, file)| file.get_string().len())
            .sum::<usize>()
            + source.len();
        if source.len() > MAX_SOURCE || count > MAX_OPEN_FILES || bytes > MAX_OPEN_BYTES {
            return Err(error(-32602, "Open document source budget exceeded"));
        }
        Ok(())
    }

    fn commit_source(&mut self, path: PathBuf, update: SourceUpdate) -> Result<(), ResponseError> {
        self.commit_sources(vec![path], update)
    }

    fn commit_sources(
        &mut self,
        paths: Vec<PathBuf>,
        update: SourceUpdate,
    ) -> Result<(), ResponseError> {
        let next = self
            .inner
            .snapshot
            .checked_add(1)
            .ok_or_else(|| error(-32603, "Snapshot limit reached; restart required"))?;
        self.failed = true;
        let mut manager = TransactionManager::default();
        let mut transaction = manager
            .get_possibly_committable_transaction(&self.inner.state)
            .unwrap_or_else(|_| {
                panic!("Serial document guest must own its committing transaction")
            });
        match update {
            SourceUpdate::Document(contents) => transaction.as_mut().set_memory(vec![(
                paths[0].clone(),
                contents.map(|file| Arc::new(file.to_file_contents())),
            )]),
            SourceUpdate::Disk(events) => transaction.as_mut().invalidate_events(&events),
        }
        let mut handles = self
            .files
            .read()
            .keys()
            .map(|path| {
                self.inner
                    .config
                    .handle_from_module_path(ModulePath::filesystem(path.clone()))
            })
            .collect::<Vec<_>>();
        for path in paths {
            let changed = self
                .inner
                .config
                .handle_from_module_path(ModulePath::filesystem(path));
            if !handles.contains(&changed) {
                handles.push(changed);
            }
        }
        transaction
            .as_mut()
            .run(&handles, Require::Everything, None);
        self.inner.state.commit_transaction(transaction, None);
        self.inner.snapshot = next;
        let transaction = self.inner.state.transaction();
        let errors = transaction
            .get_errors(handles.iter())
            .collect_lsp_errors_with_baselines()
            .0;
        self.pending_diagnostics = self
            .files
            .read()
            .keys()
            .map(|path| {
                let uri =
                    Url::from_file_path(path).expect("Validated guest path must have a file URI");
                let diagnostics = errors
                    .iter()
                    .filter(|error| error.path().as_path() == path)
                    .map(|error| error.to_diagnostic())
                    .collect();
                let version = self.versions.lock().get(path).copied();
                PublishDiagnosticsParams::new(uri, diagnostics, version)
            })
            .collect();
        drop(transaction);
        self.failed = false;
        Ok(())
    }

    pub fn did_open(&mut self, params: DidOpenTextDocumentParams) -> Result<(), ResponseError> {
        self.check_live()?;
        let document = params.text_document;
        let path = self.source_path(&document.uri)?;
        if document.language_id != "python"
            || document.version < 0
            || self.files.read().contains_key(&path)
        {
            return Err(error(
                -32602,
                "Invalid language, version, or duplicate open",
            ));
        }
        self.check_budget(&path, &document.text)?;
        let contents = Arc::new(LspFile::from_source(document.text));
        open_document(
            &self.files,
            &self.versions,
            path.clone(),
            document.version,
            contents.dupe(),
        );
        self.commit_source(path, SourceUpdate::Document(Some(contents)))
    }

    pub fn did_change(&mut self, params: DidChangeTextDocumentParams) -> Result<(), ResponseError> {
        self.check_live()?;
        let path = self.source_path(&params.text_document.uri)?;
        let version = params.text_document.version;
        let old = self
            .versions
            .lock()
            .get(&path)
            .copied()
            .ok_or_else(|| error(-32602, "Change requires an open document"))?;
        if version <= old || params.content_changes.is_empty() || params.content_changes.len() > 128
        {
            return Err(error(
                -32602,
                "Change requires a newer version and a bounded edit batch",
            ));
        }
        let mut preview = self
            .files
            .read()
            .get(&path)
            .expect("Open document version must have contents")
            .get_string()
            .to_owned();
        for change in &params.content_changes {
            if let Some(range) = change.range
                && (range.start > range.end
                    || !valid_position(&preview, range.start.line, range.start.character)
                    || !valid_position(&preview, range.end.line, range.end.character))
            {
                return Err(error(-32602, "Invalid UTF-16 edit range"));
            }
            preview = apply_change_events(&preview, vec![change.clone()]);
            self.check_budget(&path, &preview)?;
        }
        change_document(
            &self.files,
            &self.versions,
            &path,
            version,
            params.content_changes,
        )
        .map_err(|reason| error(-32602, &reason.to_string()))?;
        let contents = self
            .files
            .read()
            .get(&path)
            .expect("Changed document must remain open")
            .dupe();
        self.commit_source(path, SourceUpdate::Document(Some(contents)))
    }

    pub fn did_close(&mut self, params: DidCloseTextDocumentParams) -> Result<(), ResponseError> {
        self.check_live()?;
        let path = self.source_path(&params.text_document.uri)?;
        if self.files.write().remove(&path).is_none() {
            return Err(error(-32602, "Close requires an open document"));
        }
        self.versions.lock().remove(&path);
        self.commit_source(path, SourceUpdate::Document(None))?;
        self.pending_diagnostics.push(PublishDiagnosticsParams::new(
            params.text_document.uri,
            Vec::new(),
            None,
        ));
        Ok(())
    }

    pub fn did_save(&mut self, params: DidSaveTextDocumentParams) -> Result<(), ResponseError> {
        self.check_live()?;
        let path = self.source_path(&params.text_document.uri)?;
        let source = std::fs::read_to_string(&path)
            .map_err(|reason| error(-32602, &format!("Saved source is unavailable: {reason}")))?;
        self.check_budget(&path, &source)?;
        if params.text.as_ref().is_some_and(|text| text != &source) {
            return Err(error(
                -32602,
                "Save text does not match the admitted disk source",
            ));
        }
        self.commit_source(
            path.clone(),
            SourceUpdate::Disk(CategorizedEvents {
                modified: vec![path],
                ..Default::default()
            }),
        )
    }

    pub fn did_change_watched_files(
        &mut self,
        params: DidChangeWatchedFilesParams,
    ) -> Result<(), ResponseError> {
        self.check_live()?;
        if params.changes.is_empty() || params.changes.len() > MAX_OPEN_FILES {
            return Err(error(
                -32602,
                "Disk updates require a bounded nonempty changed-file batch",
            ));
        }
        let mut events = CategorizedEvents::default();
        let paths = params
            .changes
            .iter()
            .map(|change| {
                let path = self.admitted_path(&change.uri, false)?;
                match change.typ {
                    FileChangeType::CREATED | FileChangeType::CHANGED => {
                        let metadata = std::fs::symlink_metadata(&path).map_err(|reason| {
                            error(-32602, &format!("Disk source is unavailable: {reason}"))
                        })?;
                        if !metadata.is_file() {
                            return Err(error(-32602, "Disk source must be a regular Python file"));
                        }
                        let source = std::fs::read_to_string(&path).map_err(|reason| {
                            error(-32602, &format!("Disk source is unavailable: {reason}"))
                        })?;
                        self.check_budget(&path, &source)?;
                        if change.typ == FileChangeType::CREATED {
                            events.created.push(path.clone());
                        } else {
                            events.modified.push(path.clone());
                        }
                    }
                    FileChangeType::DELETED => {
                        match std::fs::symlink_metadata(&path) {
                            Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => {}
                            _ => {
                                return Err(error(
                                    -32602,
                                    "Deleted source must be absent from the disk mirror",
                                ));
                            }
                        }
                        events.removed.push(path.clone());
                    }
                    _ => return Err(error(-32602, "Invalid file event kind")),
                }
                Ok(path)
            })
            .collect::<Result<Vec<_>, ResponseError>>()?;
        self.commit_sources(paths, SourceUpdate::Disk(events))
    }

    fn warm(&self, uri: &Url) -> Result<(), ResponseError> {
        self.check_live()?;
        let path = self.checked_source_path(uri, true)?;
        let handle = self.query_handle(path);
        let transaction = self
            .inner
            .state
            .new_committable_transaction(Require::Exports, None);
        self.inner.state.run_with_committing_transaction(
            transaction,
            &[handle],
            Require::Everything,
            None,
            None,
        );
        Ok(())
    }

    pub fn computed_type(
        &mut self,
        params: GetTypeParams,
    ) -> Result<Option<tsp_types::Type>, ResponseError> {
        self.query_type(params, QueryKind::Computed)
    }

    fn check_snapshot(&self, snapshot: i32) -> Result<(), ResponseError> {
        self.check_live()?;
        if snapshot != self.snapshot() {
            return Err(error(-32802, "Snapshot outdated"));
        }
        Ok(())
    }

    pub fn query_type(
        &self,
        params: GetTypeParams,
        kind: QueryKind,
    ) -> Result<Option<tsp_types::Type>, ResponseError> {
        self.check_snapshot(params.snapshot)?;
        let uri = Url::parse(params.uri()).map_err(|reason| error(-32602, &reason.to_string()))?;
        let path = self.checked_source_path(&uri, true)?;
        self.warm(&uri)?;
        let source = match self.files.read().get(&path) {
            Some(file) => file.get_string().to_owned(),
            None => std::fs::read_to_string(&path)
                .map_err(|reason| error(-32602, &format!("Cannot read saved source: {reason}")))?,
        };
        let start = params.position();
        let end = params.end_position();
        if (start.line, start.character) > (end.line, end.character)
            || !valid_position(&source, start.line, start.character)
            || !valid_position(&source, end.line, end.character)
        {
            return Err(error(-32602, "Expected an in-bounds UTF-16 query range"));
        }
        let typing_source = matches!(
            path.to_str(),
            Some("/typeshed/typing.pyi" | "/typeshed/typing_extensions.pyi")
        );
        let handle = self.query_handle(path);
        let transaction = self.inner.state.transaction();
        let module = transaction
            .get_module_info(&handle)
            .ok_or_else(|| error(-32603, "Analyzed query module is missing"))?;
        let mut range = TextRange::new(
            module.from_lsp_position(Position::new(start.line, start.character), None),
            module.from_lsp_position(Position::new(end.line, end.character), None),
        );
        if let GetTypeArg::Declaration { _extra, .. } = &params.arg {
            if _extra.get("kind").and_then(Value::as_i64) != Some(0) {
                return Err(error(
                    -32602,
                    "Only regular source declarations are supported",
                ));
            }
            let name = _extra
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| error(-32602, "Regular declaration requires its source name"))?;
            let category = _extra
                .get("category")
                .and_then(Value::as_u64)
                .filter(|category| *category <= 7)
                .ok_or_else(|| error(-32602, "Regular declaration requires a valid category"))?;
            let ast = transaction
                .get_ast(&handle)
                .ok_or_else(|| error(-32603, "Query AST is missing"))?;
            let mut declared_range = None;
            for node in Ast::locate_node(&ast, range.start()) {
                let identifier = match node {
                    AnyNodeRef::StmtFunctionDef(node) if node.range() == range && category == 5 => {
                        Some(&node.name)
                    }
                    AnyNodeRef::StmtClassDef(node) if node.range() == range && category == 6 => {
                        Some(&node.name)
                    }
                    _ => None,
                };
                if let Some(identifier) = identifier {
                    if identifier.id.as_str() != name {
                        return Err(error(-32602, "Declaration name does not match its source"));
                    }
                    declared_range = Some(identifier.range);
                    break;
                }
            }
            if let Some(identifier) = declared_range {
                range = identifier;
            } else if let Some(identifier) = transaction.identifier_at(&handle, range.start()) {
                let source_category = match &identifier.context {
                    IdentifierContext::FunctionDef { .. } | IdentifierContext::MethodDef { .. } => {
                        5
                    }
                    IdentifierContext::ClassDef { .. } => 6,
                    IdentifierContext::Parameter => 2,
                    IdentifierContext::TypeParameter => 3,
                    IdentifierContext::ImportedName { .. }
                    | IdentifierContext::ImportedModule { .. } => 7,
                    _ => 1,
                };
                let is_special_form_class = category == 6
                    && typing_source
                    && source_category == 1
                    && (range == identifier.identifier.range
                        || Ast::locate_node(&ast, range.start()).into_iter().any(|node| {
                            matches!(node, AnyNodeRef::StmtAnnAssign(stmt) if stmt.range() == range)
                        }))
                    && transaction
                        .get_computed_type_at_range(&handle, identifier.identifier.range)
                        .is_some_and(|ty| match ty {
                            pyrefly_types::types::Type::SpecialForm(_) => true,
                            pyrefly_types::types::Type::Type(inner) => {
                                matches!(inner.as_ref(), pyrefly_types::types::Type::SpecialForm(_))
                            }
                            _ => false,
                        });
                if identifier.identifier.id.as_str() != name
                    || (category != source_category && !is_special_form_class)
                    || !range.contains_range(identifier.identifier.range)
                {
                    return Err(error(
                        -32602,
                        "Declaration name or range does not match its source",
                    ));
                }
                range = identifier.identifier.range;
            } else {
                return Err(error(-32602, "Unsupported source declaration range"));
            }
        } else if let Some(identifier) = transaction.identifier_at(&handle, range.start()) {
            if identifier.identifier.range == range
                && let IdentifierContext::Attribute {
                    range: expression, ..
                } = identifier.context
            {
                range = expression;
            }
        }
        let ty = match kind {
            QueryKind::Computed => transaction.get_computed_type_at_range(&handle, range),
            QueryKind::Declared => transaction.get_declared_type_at(&handle, range.start()),
            QueryKind::Expected => transaction
                .get_expected_type_at(&handle, range.start())
                .or_else(|| transaction.get_computed_type_at_range(&handle, range)),
        };
        let Some(ty) = ty else { return Ok(None) };
        let converted = convert_type_in_transaction(&transaction, &handle, &ty);
        if let tsp_types::Type::Class(class) = &converted
            && let tsp_types::Declaration::Synthesized(declaration) = &class.declaration
            && declaration.uri.is_empty()
        {
            return Err(error(
                -32603,
                "Query class has no resolvable source declaration",
            ));
        }
        Ok(Some(converted))
    }

    pub fn resolve_import(
        &self,
        params: ResolveImportParams,
    ) -> Result<Option<String>, ResponseError> {
        self.check_snapshot(params.snapshot)?;
        let uri =
            Url::parse(&params.source_uri).map_err(|reason| error(-32602, &reason.to_string()))?;
        let path = local_path(&uri)?;
        let root_context = self.is_configured_root(&path);
        if !root_context {
            self.checked_source_path(&uri, true)?;
        }
        let descriptor = params.module_descriptor;
        if descriptor
            .name_parts
            .iter()
            .any(|part| part.is_empty() || part.contains(['.', '/', '\\', '\0']))
        {
            return Err(error(-32602, "Invalid module name parts"));
        }
        if !root_context {
            self.warm(&uri)?;
        }
        if root_context && descriptor.leading_dots != 0 {
            return Err(error(-32602, "Relative imports require a source file"));
        }
        let handle = self.query_handle(path.clone());
        let name = resolve_module_name(
            &descriptor.name_parts,
            descriptor.leading_dots,
            handle.module(),
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("__init__.py" | "__init__.pyi")
            ),
        )?;
        let transaction = self.inner.state.transaction();
        let result = transaction.import_handle(&handle, name, None);
        let Some(handle) = result.finding() else {
            return Ok(None);
        };
        let path = to_real_path(handle.path())
            .ok_or_else(|| error(-32603, "Resolved module has no source path"))?;
        if !path.starts_with("/typeshed")
            && !self
                .inner
                .config
                .search_path_from_args
                .iter()
                .any(|root| path.starts_with(root))
        {
            return Err(error(-32602, "Resolved import is outside captured roots"));
        }
        let uri = Url::from_file_path(&path)
            .map_err(|_| error(-32603, "Resolved module path is not absolute"))?;
        Ok(Some(uri.to_string()))
    }

    pub fn search_paths(
        &self,
        params: GetPythonSearchPathsParams,
    ) -> Result<Vec<String>, ResponseError> {
        self.check_snapshot(params.snapshot)?;
        let uri =
            Url::parse(&params.from_uri).map_err(|reason| error(-32602, &reason.to_string()))?;
        let path = local_path(&uri)?;
        if !self.is_configured_root(&path) {
            self.checked_source_path(&uri, true)?;
        }
        let mut paths = self
            .inner
            .config
            .search_path_from_args
            .iter()
            .map(|path| {
                Url::from_file_path(path)
                    .expect("Validated root has a file URI")
                    .to_string()
            })
            .collect::<Vec<_>>();
        paths.push("file:///typeshed".to_owned());
        Ok(paths)
    }

    pub fn take_diagnostics(&mut self) -> Vec<PublishDiagnosticsParams> {
        std::mem::take(&mut self.pending_diagnostics)
    }
}
