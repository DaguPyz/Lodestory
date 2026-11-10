mod protocol;

use serde_json::Value;
use std::{ffi::c_void, ptr};

#[repr(C)]
pub struct LibraryBuffer {
    data: *mut u8,
    len: usize,
}

struct PluginState {
    // Own any plugin resources here and release them on successful shutdown.
    _reserved: u8,
}

#[no_mangle]
pub extern "C" fn lodestory_library_abi_version() -> u32 {
    1
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_init(instance: *mut *mut c_void) -> i32 {
    if instance.is_null() {
        return 1;
    }
    let state = Box::new(PluginState { _reserved: 0 });
    // SAFETY: the host provides a valid writable output pointer.
    unsafe { *instance = Box::into_raw(state).cast() };
    0
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
    // Keep a panic in the example operation from unwinding across the C boundary.
    std::panic::catch_unwind(|| {
        // SAFETY: the host keeps the input valid throughout this call.
        let bytes = unsafe { std::slice::from_raw_parts(request, request_len) };
        let request: Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(_) => return 2,
        };
        let result = match protocol::call(&request) {
            Some(value) => value,
            None => return 3,
        };
        let bytes = match serde_json::to_vec(&result) {
            Ok(value) => value.into_boxed_slice(),
            Err(_) => return 4,
        };
        let len = bytes.len();
        // SAFETY: the host provides a valid output pointer and frees this allocation once.
        unsafe {
            *response = LibraryBuffer {
                data: Box::into_raw(bytes).cast(),
                len,
            }
        };
        0
    })
    .unwrap_or(5)
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_shutdown(instance: *mut c_void) -> i32 {
    if instance.is_null() {
        return 1;
    }
    // Release background work before dropping the state. If cleanup fails, return
    // a nonzero code without dropping the instance so shutdown can be retried.
    // SAFETY: the host calls shutdown once per successful initialization.
    drop(unsafe { Box::from_raw(instance.cast::<PluginState>()) });
    0
}

#[no_mangle]
pub unsafe extern "C" fn lodestory_library_free_buffer(data: *mut u8, len: usize) {
    if !data.is_null() {
        // SAFETY: data and len identify an allocation returned by this library.
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(data, len)) });
    }
}
