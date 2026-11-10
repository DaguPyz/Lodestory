use serde_json::{json, Value};
use std::{ffi::c_void, ptr, thread, time::Duration};

#[repr(C)]
pub struct LibraryBuffer {
    data: *mut u8,
    len: usize,
}
struct State {
    owner: thread::ThreadId,
    marker: Option<String>,
    reject_once: bool,
}

#[no_mangle]
pub extern "C" fn lodestory_library_abi_version() -> u32 {
    if cfg!(feature = "incompatible-abi") {
        2
    } else {
        1
    }
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_init(instance: *mut *mut c_void) -> i32 {
    if instance.is_null() {
        return 1;
    }
    let state = Box::new(State {
        owner: thread::current().id(),
        marker: None,
        reject_once: cfg!(feature = "fail-init-retry"),
    });
    // SAFETY: the host supplies a writable output pointer.
    unsafe {
        *instance = Box::into_raw(state).cast();
    }
    if cfg!(feature = "fail-init") {
        10
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_call(
    instance: *mut c_void,
    request: *const u8,
    request_len: usize,
    response: *mut LibraryBuffer,
) -> i32 {
    if instance.is_null() || request.is_null() || response.is_null() {
        return 1;
    }
    // SAFETY: the host supplies the instance and input buffer under ABI v1.
    let state = unsafe { &mut *instance.cast::<State>() };
    if state.owner != thread::current().id() {
        return 2;
    }
    let input = unsafe { std::slice::from_raw_parts(request, request_len) };
    let value: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(_) => return 3,
    };
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let result = match value.get("operation").and_then(Value::as_str) {
        Some("ping") if value.get("schemaVersion").and_then(Value::as_str) == Some("1.0.0") => {
            json!({"type":"response", "requestId":request_id, "status":"success", "result": {
                "message":"D 已收到请求", "params":params
            }})
        }
        Some("configureShutdown") => {
            state.marker = params
                .get("markerPath")
                .and_then(Value::as_str)
                .map(str::to_owned);
            state.reject_once = params
                .get("rejectOnce")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({"type":"response", "requestId":request_id, "status":"success", "result":null})
        }
        Some("delay") => {
            let millis = params
                .get("milliseconds")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(1000);
            thread::sleep(Duration::from_millis(millis));
            json!({"type":"response", "requestId":request_id, "status":"success", "result":null})
        }
        _ => json!({"type":"response", "requestId":request_id, "status":"error", "error": {
            "code":"PLUGIN_OPERATION_FAILED", "message":"不支持的操作或参数版本"
        }}),
    };
    let bytes = match serde_json::to_vec(&result) {
        Ok(bytes) => bytes.into_boxed_slice(),
        Err(_) => return 4,
    };
    let len = bytes.len();
    // SAFETY: the host supplies a writable output pointer and will call free_buffer once.
    unsafe {
        *response = LibraryBuffer {
            data: Box::into_raw(bytes).cast::<u8>(),
            len,
        };
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_shutdown(instance: *mut c_void) -> i32 {
    if instance.is_null() {
        return 1;
    }
    // SAFETY: the instance is alive until shutdown succeeds.
    let state = unsafe { &mut *instance.cast::<State>() };
    if state.owner != thread::current().id() {
        return 2;
    }
    if state.reject_once {
        state.reject_once = false;
        return 7;
    }
    if let Some(marker) = &state.marker {
        if std::fs::write(marker, "D 已清理").is_err() {
            return 8;
        }
    }
    // SAFETY: success transfers and releases the instance exactly once.
    drop(unsafe { Box::from_raw(instance.cast::<State>()) });
    0
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_free_buffer(data: *mut u8, len: usize) {
    if !data.is_null() {
        // SAFETY: data and len are the original allocation returned by this library.
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(data, len)) });
    }
}
