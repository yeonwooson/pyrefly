/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Persistent WASIp1 command: bounded stdio JSON-RPC around real Pyrefly queries.

use std::io;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;

use lsp_server::ResponseError;
use lsp_types::InitializeParams;
use lsp_types::InitializeResult;
use lsp_types::ServerCapabilities;
use lsp_types::ServerInfo;
use lsp_types::TextDocumentSyncCapability;
use lsp_types::TextDocumentSyncKind;
use lsp_types::TextDocumentSyncOptions;
use lsp_types::TextDocumentSyncSaveOptions;
use pyrefly::tsp::document_guest::DocumentGuest;
use pyrefly::tsp::document_guest::QueryKind;
use pyrefly::tsp::query_guest::error;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tsp_types::TSP_PROTOCOL_VERSION;

const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADER: usize = 8192;

enum Backend {
    Documents(DocumentGuest),
}

impl Backend {
    fn snapshot(&self) -> i32 {
        match self {
            Self::Documents(guest) => guest.snapshot(),
        }
    }
}

#[derive(Serialize)]
struct Reply {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

/// Fatal framing errors cannot be resynchronized safely; clean EOF is distinct.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut header = Vec::new();
    loop {
        let mut byte = [0];
        if reader.read(&mut byte)? == 0 {
            return if header.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Truncated frame header",
                ))
            };
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() >= MAX_HEADER {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Frame header exceeds 8192 bytes",
            ));
        }
    }
    let header =
        std::str::from_utf8(&header).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut length = None;
    for line in header[..header.len() - 4].split("\r\n") {
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Malformed frame header"))?;
        if key.eq_ignore_ascii_case("Content-Length") {
            let value = value.trim();
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid Content-Length",
                ));
            }
            length = Some(
                value
                    .parse::<usize>()
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            );
        }
    }
    let length = length.filter(|length| *length <= MAX_BODY).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Missing or oversized Content-Length",
        )
    })?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

fn reply(
    writer: &mut impl Write,
    id: Value,
    result: Result<Value, ResponseError>,
) -> io::Result<()> {
    let (result, error) = match result {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    let body = serde_json::to_vec(&Reply {
        jsonrpc: "2.0",
        id,
        result,
        error,
    })?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn params<T: DeserializeOwned>(value: Value) -> Result<T, ResponseError> {
    serde_json::from_value(value).map_err(|e| error(-32602, &e.to_string()))
}

fn serialize(value: impl Serialize) -> Result<Value, ResponseError> {
    serde_json::to_value(value).map_err(|e| error(-32603, &e.to_string()))
}

fn notification(writer: &mut impl Write, method: &str, params: impl Serialize) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0", "method": method, "params": params,
    }))?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

/// Native-only artifact export reads the very same compiled bundled archive.
fn export_typeshed(directory: &Path) -> anyhow::Result<()> {
    for (path, contents) in pyrefly_bundled::bundled_typeshed()? {
        let target = directory.join(path);
        std::fs::create_dir_all(target.parent().expect("Exported stub has a parent"))?;
        std::fs::write(target, contents)?;
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--export-typeshed" {
        return export_typeshed(Path::new(&args[2]));
    }
    let shared = args.len() == 2 && args[1] == "--shared-documents";
    if args.len() > 1 && !shared {
        anyhow::bail!(
            "Expected no arguments (document session), --shared-documents, or --export-typeshed <directory>"
        );
    }
    let mut input = io::BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    let mut guest = None;
    let mut shutdown = false;
    loop {
        let bytes = match read_frame(&mut input) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(e) => {
                reply(&mut output, Value::Null, Err(error(-32700, &e.to_string())))?;
                break;
            }
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(e) => {
                reply(&mut output, Value::Null, Err(error(-32700, &e.to_string())))?;
                continue;
            }
        };
        let id = value.get("id").cloned();
        let valid_id = id
            .as_ref()
            .is_none_or(|id| id.is_string() || id.is_i64() || id.is_u64());
        let Some(method) = value
            .get("method")
            .and_then(Value::as_str)
            .filter(|_| value.get("jsonrpc").and_then(Value::as_str) == Some("2.0") && valid_id)
        else {
            reply(
                &mut output,
                Value::Null,
                Err(error(-32600, "Invalid JSON-RPC request")),
            )?;
            continue;
        };
        if method == "exit" && id.is_none() {
            break;
        }
        let arguments = value.get("params").cloned().unwrap_or(Value::Null);
        let old = guest.as_ref().map(Backend::snapshot);
        let result = dispatch(method, arguments, &mut guest, &mut shutdown);
        if result.is_err()
            && matches!(
                method,
                "textDocument/didOpen"
                    | "textDocument/didChange"
                    | "textDocument/didClose"
                    | "textDocument/didSave"
                    | "workspace/didChangeWatchedFiles"
            )
            && let Some(Backend::Documents(guest)) = guest.as_mut()
        {
            guest.reject_update();
        }
        if result.is_ok()
            && let Some(Backend::Documents(guest)) = guest.as_mut()
        {
            if let Some(old) = old
                && old != guest.snapshot()
            {
                notification(
                    &mut output,
                    "typeServer/snapshotChanged",
                    serde_json::json!({ "old": old, "new": guest.snapshot() }),
                )?;
            }
            for diagnostics in guest.take_diagnostics() {
                notification(&mut output, "textDocument/publishDiagnostics", diagnostics)?;
            }
        }
        if let Some(id) = id {
            reply(&mut output, id, result)?;
        } else if let Err(error) = result {
            eprintln!("Notification rejected: {}: {}", error.code, error.message);
        }
    }
    Ok(())
}

fn dispatch(
    method: &str,
    arguments: Value,
    guest: &mut Option<Backend>,
    shutdown: &mut bool,
) -> Result<Value, ResponseError> {
    if *shutdown {
        return Err(error(-32600, "Server has shut down"));
    }
    if method == "initialize" {
        if guest.is_some() {
            return Err(error(-32600, "Already initialized"));
        }
        let initialize: InitializeParams = params(arguments)?;
        #[allow(deprecated)]
        let root_uri = initialize.root_uri;
        *guest = Some(Backend::Documents(DocumentGuest::new(
            root_uri,
            initialize.initialization_options,
        )?));
        return serialize(InitializeResult {
            capabilities: {
                ServerCapabilities {
                    text_document_sync: Some(TextDocumentSyncCapability::Options(
                        TextDocumentSyncOptions {
                            open_close: Some(true),
                            change: Some(TextDocumentSyncKind::INCREMENTAL),
                            save: Some(TextDocumentSyncSaveOptions::Supported(true)),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }
            },
            server_info: Some(ServerInfo {
                name: "pyrefly-wasi-shared-documents".to_owned(),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            }),
        });
    }
    let guest = guest
        .as_mut()
        .ok_or_else(|| error(-32002, "Server not initialized"))?;
    match (method, guest) {
        ("initialized", _) => Ok(Value::Null),
        ("typeServer/getSupportedProtocolVersion", _) => serialize(TSP_PROTOCOL_VERSION),
        ("typeServer/getSnapshot", Backend::Documents(guest)) => {
            guest.check_live()?;
            serialize(guest.snapshot())
        }
        ("typeServer/getComputedType", Backend::Documents(guest)) => {
            serialize(guest.computed_type(params(arguments)?)?)
        }
        ("typeServer/getDeclaredType", Backend::Documents(guest)) => {
            serialize(guest.query_type(params(arguments)?, QueryKind::Declared)?)
        }
        ("typeServer/getExpectedType", Backend::Documents(guest)) => {
            serialize(guest.query_type(params(arguments)?, QueryKind::Expected)?)
        }
        ("typeServer/resolveImport", Backend::Documents(guest)) => {
            serialize(guest.resolve_import(params(arguments)?)?)
        }
        ("typeServer/getPythonSearchPaths", Backend::Documents(guest)) => {
            serialize(guest.search_paths(params(arguments)?)?)
        }
        ("textDocument/didOpen", Backend::Documents(guest)) => {
            guest.did_open(params(arguments)?)?;
            Ok(Value::Null)
        }
        ("textDocument/didChange", Backend::Documents(guest)) => {
            guest.did_change(params(arguments)?)?;
            Ok(Value::Null)
        }
        ("textDocument/didClose", Backend::Documents(guest)) => {
            guest.did_close(params(arguments)?)?;
            Ok(Value::Null)
        }
        ("textDocument/didSave", Backend::Documents(guest)) => {
            guest.did_save(params(arguments)?)?;
            Ok(Value::Null)
        }
        ("workspace/didChangeWatchedFiles", Backend::Documents(guest)) => {
            guest.did_change_watched_files(params(arguments)?)?;
            Ok(Value::Null)
        }
        ("shutdown", _) => {
            *shutdown = true;
            Ok(Value::Null)
        }
        _ => Err(error(
            -32601,
            "Method not supported by this portable query adapter",
        )),
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn frame_roundtrip_and_clean_eof() {
        let mut bytes = Vec::new();
        reply(
            &mut bytes,
            serde_json::json!(1),
            Ok(serde_json::json!("ok")),
        )
        .unwrap();
        let mut reader = io::Cursor::new(bytes);
        let frame = read_frame(&mut reader).unwrap().unwrap();
        let value: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"], "ok");
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn reject_truncated_duplicate_and_oversized_frames() {
        for value in [
            b"Content-Length: 2\r\n\r\nx".as_slice(),
            b"Content-Length: 1\r\nContent-Length: 1\r\n\r\nx".as_slice(),
            b"Content-Length: 1048577\r\n\r\n".as_slice(),
            b"Content-Length: x\r\n\r\n".as_slice(),
        ] {
            assert!(read_frame(&mut io::Cursor::new(value)).is_err());
        }
    }
}
