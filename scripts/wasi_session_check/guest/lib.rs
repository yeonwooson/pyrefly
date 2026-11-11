use std::cell::RefCell;
use std::path::PathBuf;

use lsp_server::ResponseError;
use pyrefly::tsp::session::FilesystemSession;
use pyrefly::tsp::validation::internal_error;
use pyrefly::tsp::validation::invalid_params_error;
use pyrefly_config::config::ConfigFile;
use pyrefly_util::events::CategorizedEvents;
use pyrefly_util::thread_pool::ThreadCount;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use tsp_types::GetTypeParams;

thread_local! {
    static SESSIONS: RefCell<Vec<Option<FilesystemSession>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Deserialize)]
#[serde(tag = "method", content = "args")]
enum Request {
    #[serde(rename = "setFiles")]
    SetFiles(Vec<PathBuf>),
    #[serde(rename = "filesChanged")]
    FilesChanged {
        #[serde(default)]
        created: Vec<PathBuf>,
        #[serde(default)]
        modified: Vec<PathBuf>,
        #[serde(default)]
        removed: Vec<PathBuf>,
    },
    #[serde(rename = "typeServer/getSnapshot")]
    GetSnapshot,
    #[serde(rename = "typeServer/getComputedType")]
    GetComputedType(GetTypeParams),
    #[serde(rename = "dispose")]
    Dispose,
}

fn response(result: Result<Value, ResponseError>) -> u64 {
    let value = match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({
            "err": json!({
                "code": error.code,
                "message": error.message,
                "data": error.data,
            }).to_string(),
        }),
    };
    let bytes = value.to_string().into_bytes().into_boxed_slice();
    let len = bytes.len() as u64;
    (Box::into_raw(bytes) as *mut u8 as u64) << 32 | len
}

#[unsafe(no_mangle)]
pub extern "C" fn pyrefly_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0; len].into_boxed_slice()) as *mut u8
}

/// # Safety
/// The buffer must be a live allocation from pyrefly_alloc or response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pyrefly_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

/// # Safety
/// The buffer must be a live allocation from pyrefly_alloc.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pyrefly_workspace_new(ptr: *mut u8, len: usize) -> u64 {
    let bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
    let result = String::from_utf8(bytes.into_vec())
        .map_err(|error| invalid_params_error(&error.to_string()))
        .and_then(|root| {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                return Err(invalid_params_error(
                    "Expected an absolute virtual workspace root",
                ));
            }
            let mut config = ConfigFile {
                search_path_from_args: vec![root],
                disable_search_path_heuristics: true,
                ..Default::default()
            };
            config.python_environment.set_empty_to_default();
            config.interpreters.skip_interpreter_query = true;
            FilesystemSession::new(config, ThreadCount::Inline)
        })
        .map(|session| {
            SESSIONS.with_borrow_mut(|sessions| {
                let handle = sessions.len();
                sessions.push(Some(session));
                json!(handle)
            })
        });
    response(result)
}

/// # Safety
/// The buffer must be a live allocation from pyrefly_alloc.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pyrefly_workspace_call(handle: usize, ptr: *mut u8, len: usize) -> u64 {
    let bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
    let result = serde_json::from_slice::<Request>(&bytes)
        .map_err(|error| invalid_params_error(&error.to_string()))
        .and_then(|request| {
            SESSIONS.with_borrow_mut(|sessions| {
                let slot = sessions
                    .get_mut(handle)
                    .ok_or_else(|| invalid_params_error("Unknown session handle"))?;
                let session = slot
                    .as_mut()
                    .ok_or_else(|| invalid_params_error("Session is disposed"))?;
                match request {
                    Request::SetFiles(files) => session.set_files(files).map(|()| Value::Null),
                    Request::FilesChanged {
                        created,
                        modified,
                        removed,
                    } => {
                        let changed = session.files_changed(&CategorizedEvents {
                            created,
                            modified,
                            removed,
                            unknown: Vec::new(),
                        })?;
                        serde_json::to_value(changed)
                            .map_err(|error| internal_error(&error.to_string()))
                    }
                    Request::GetSnapshot => Ok(json!(session.get_snapshot())),
                    Request::GetComputedType(params) => {
                        let ty = session.get_computed_type(&params)?;
                        serde_json::to_value(ty).map_err(|error| internal_error(&error.to_string()))
                    }
                    Request::Dispose => {
                        *slot = None;
                        Ok(Value::Null)
                    }
                }
            })
        });
    response(result)
}
