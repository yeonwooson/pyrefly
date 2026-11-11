/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! Experimental WASIp1 library over the existing serial document session.
//!
//! The instance owns the input and output buffers. Input is written only after
//! `direct_reserve`; output remains valid until the next operation. Calls must
//! be serial. Parameters/results are JSON, but there is no JSON-RPC envelope,
//! method dispatch, framing, stdin loop, or worker in this interface.

use std::cell::RefCell;

use lsp_server::ResponseError;
use lsp_types::DidChangeTextDocumentParams;
use lsp_types::DidOpenTextDocumentParams;
use lsp_types::InitializeParams;
use pyrefly::tsp::document_guest::DocumentGuest;
use pyrefly::tsp::query_guest::error;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tsp_types::GetTypeParams;
use tsp_types::TSP_PROTOCOL_VERSION;

const MAX_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct Session {
    input: Vec<u8>,
    output: Vec<u8>,
    guest: Option<DocumentGuest>,
}

impl Session {
    fn params<T: DeserializeOwned>(&self) -> Result<T, ResponseError> {
        serde_json::from_slice(&self.input).map_err(|e| error(-32602, &e.to_string()))
    }

    fn guest(&mut self) -> Result<&mut DocumentGuest, ResponseError> {
        self.guest
            .as_mut()
            .ok_or_else(|| error(-32002, "Session not initialized"))
    }

    fn finish(&mut self, result: Result<Value, ResponseError>, update: bool) -> i32 {
        if update
            && result.is_err()
            && let Some(guest) = self.guest.as_mut()
        {
            guest.reject_update();
        }
        let reply = match result {
            Ok(value) => {
                let diagnostics = self
                    .guest
                    .as_mut()
                    .map(DocumentGuest::take_diagnostics)
                    .unwrap_or_default();
                serde_json::json!({ "value": value, "diagnostics": diagnostics })
            }
            Err(error) => serde_json::json!({ "error": error }),
        };
        let mut bytes = serde_json::to_vec(&reply).expect("JSON values are serializable");
        let mut failed = reply.get("error").is_some();
        if bytes.len() > MAX_BYTES {
            bytes = serde_json::to_vec(&serde_json::json!({
                "error": error(-32603, "Direct result exceeds output budget")
            }))
            .expect("Error reply is serializable");
            failed = true;
        }
        self.output = bytes;
        i32::from(failed)
    }
}

thread_local! {
    static SESSION: RefCell<Session> = RefCell::new(Session::default());
}

fn serialize(value: impl Serialize) -> Result<Value, ResponseError> {
    serde_json::to_value(value).map_err(|e| error(-32603, &e.to_string()))
}

fn invoke(
    update: bool,
    operation: impl FnOnce(&mut Session) -> Result<Value, ResponseError>,
) -> i32 {
    SESSION.with(|session| {
        let mut session = session.borrow_mut();
        let result = operation(&mut session);
        session.finish(result, update)
    })
}

/// Return an owned writable input region, or null with an explicit error reply.
#[unsafe(no_mangle)]
pub extern "C" fn direct_reserve(length: u32) -> *mut u8 {
    SESSION.with(|session| {
        let mut session = session.borrow_mut();
        if length == 0 || length as usize > MAX_BYTES {
            session.input.clear();
            session.finish(
                Err(error(-32602, "Input length must be in 1..=1048576")),
                false,
            );
            return std::ptr::null_mut();
        }
        session.input.resize(length as usize, 0);
        session.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_output_ptr() -> *const u8 {
    SESSION.with(|session| session.borrow().output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_output_len() -> u32 {
    SESSION.with(|session| session.borrow().output.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_initialize() -> i32 {
    invoke(false, |session| {
        if session.guest.is_some() {
            return Err(error(-32600, "Already initialized"));
        }
        let params: InitializeParams = session.params()?;
        #[allow(deprecated)]
        let root = params.root_uri;
        session.guest = Some(DocumentGuest::new(root, params.initialization_options)?);
        Ok(Value::Null)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_protocol() -> i32 {
    invoke(false, |session| {
        session.guest()?.check_live()?;
        serialize(TSP_PROTOCOL_VERSION)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_open() -> i32 {
    invoke(true, |session| {
        let params: DidOpenTextDocumentParams = session.params()?;
        session.guest()?.did_open(params)?;
        Ok(Value::Null)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_change() -> i32 {
    invoke(true, |session| {
        let params: DidChangeTextDocumentParams = session.params()?;
        session.guest()?.did_change(params)?;
        Ok(Value::Null)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_snapshot() -> i32 {
    invoke(false, |session| {
        let guest = session.guest()?;
        guest.check_live()?;
        serialize(guest.snapshot())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_query() -> i32 {
    invoke(false, |session| {
        let params: GetTypeParams = session.params()?;
        serialize(session.guest()?.computed_type(params)?)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn direct_dispose() -> i32 {
    invoke(false, |session| {
        session.guest = None;
        session.input = Vec::new();
        Ok(Value::Null)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_parameters_are_explicit_errors() {
        for bytes in [b"{".as_slice(), b"\xff".as_slice(), b"null".as_slice()] {
            let mut session = Session {
                input: bytes.to_vec(),
                ..Session::default()
            };
            let result = session.params::<InitializeParams>().map(|_| Value::Null);
            assert_eq!(session.finish(result, false), 1);
            let output: Value = serde_json::from_slice(&session.output).unwrap();
            assert_eq!(output["error"]["code"], -32602);
        }
    }

    #[test]
    fn limits_and_uninitialized_operations_never_succeed() {
        assert!(direct_reserve(0).is_null());
        assert!(direct_reserve(MAX_BYTES as u32 + 1).is_null());
        assert_eq!(direct_snapshot(), 1);
        assert_eq!(direct_dispose(), 0);
        assert_eq!(direct_protocol(), 1);
        assert_eq!(direct_dispose(), 0);
    }
}
