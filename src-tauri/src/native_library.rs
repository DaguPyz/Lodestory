//! Generic native library ABI bridge. Business requests belong to loader plugins.
use libloading::Library;
use std::{
    collections::HashMap,
    ffi::c_void,
    mem::ManuallyDrop,
    path::Path,
    ptr,
    sync::{mpsc, Arc, Mutex},
    thread,
};
use tauri::State;
use uuid::Uuid;

const ABI_VERSION: u32 = 1;
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

#[repr(C)]
struct LibraryBuffer {
    data: *mut u8,
    len: usize,
}
type VersionFn = unsafe extern "C" fn() -> u32;
type InitFn = unsafe extern "C" fn(*mut *mut c_void) -> i32;
type CallFn = unsafe extern "C" fn(*mut c_void, *const u8, usize, *mut LibraryBuffer) -> i32;
type ShutdownFn = unsafe extern "C" fn(*mut c_void) -> i32;
type FreeFn = unsafe extern "C" fn(*mut u8, usize);

type Reply<T> = mpsc::Sender<Result<T, String>>;
enum Command {
    Ready(Reply<()>),
    Call(String, Reply<String>),
    Close(Reply<()>),
}

#[derive(Default)]
pub struct NativeLibraries {
    sessions: Mutex<HashMap<String, mpsc::Sender<Command>>>,
}
impl NativeLibraries {
    fn get(&self, id: &str) -> Result<mpsc::Sender<Command>, String> {
        self.sessions
            .lock()
            .map_err(|_| "动态库状态不可用。")?
            .get(id)
            .cloned()
            .ok_or_else(|| "动态库实例不存在。".into())
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "动态库状态不可用。")?
            .remove(id);
        Ok(())
    }
}

struct Api {
    init: InitFn,
    call: CallFn,
    shutdown: ShutdownFn,
    free: FreeFn,
}
struct Loaded {
    // Never unload implicitly on worker exit or panic while plugin resources may exist.
    library: Option<ManuallyDrop<Library>>,
    api: Api,
    instance: *mut c_void,
    init_error: Option<String>,
    terminal_error: Option<String>,
    stopping: bool,
}
enum WorkerState {
    Loaded(Loaded),
    Failed {
        error: String,
        cleanup_error: Option<String>,
    },
}

unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
    // SAFETY: the trusted library must implement the published ABI with exactly these signatures.
    unsafe { library.get::<T>(name) }
        .map(|symbol| *symbol)
        .map_err(|error| format!("动态库缺少必需入口：{error}"))
}

fn start_library(entry: &str) -> WorkerState {
    // SAFETY: only trusted libraries implementing the documented ABI may be loaded.
    let library = match unsafe { Library::new(entry) } {
        Ok(library) => library,
        Err(error) => {
            return WorkerState::Failed {
                error: format!("无法加载动态库：{error}"),
                cleanup_error: None,
            }
        }
    };
    let api = (|| -> Result<Api, String> {
        // SAFETY: each signature is defined by packages/sdk/native/lodestory_native_library.h.
        let version: VersionFn = unsafe { symbol(&library, b"lodestory_library_abi_version\0")? };
        let api = Api {
            init: unsafe { symbol(&library, b"lodestory_library_init\0")? },
            call: unsafe { symbol(&library, b"lodestory_library_call\0")? },
            shutdown: unsafe { symbol(&library, b"lodestory_library_shutdown\0")? },
            free: unsafe { symbol(&library, b"lodestory_library_free_buffer\0")? },
        };
        // SAFETY: the version function has no arguments and must obey ABI v1.
        let actual = unsafe { version() };
        if actual != ABI_VERSION {
            return Err(format!("动态库 ABI 版本不兼容：{actual}"));
        }
        Ok(api)
    })();
    let api = match api {
        Ok(api) => api,
        Err(error) => {
            let cleanup_error = library
                .close()
                .err()
                .map(|cause| format!("动态库释放失败：{cause}"));
            return WorkerState::Failed {
                error,
                cleanup_error,
            };
        }
    };
    let mut instance = ptr::null_mut();
    // SAFETY: instance is writable and initially null, as required by the ABI.
    let status = unsafe { (api.init)(&mut instance) };
    let (init_error, terminal_error) = if status != 0 {
        (Some(format!("动态库初始化失败（错误码 {status}）。")), None)
    } else if instance.is_null() {
        let error = "动态库初始化返回空实例，无法确认资源状态。".to_string();
        (Some(error.clone()), Some(error))
    } else {
        (None, None)
    };
    WorkerState::Loaded(Loaded {
        library: Some(ManuallyDrop::new(library)),
        api,
        instance,
        init_error,
        terminal_error,
        stopping: false,
    })
}

impl WorkerState {
    fn ready(&self) -> Result<(), String> {
        match self {
            Self::Loaded(value) => value.init_error.clone().map_or(Ok(()), Err),
            Self::Failed { error, .. } => Err(error.clone()),
        }
    }
    fn call(&mut self, request: &str) -> Result<String, String> {
        if request.len() > MAX_MESSAGE {
            return Err("动态库输入超过单条消息长度限制。".into());
        }
        let loaded = match self {
            Self::Loaded(value)
                if value.init_error.is_none()
                    && value.terminal_error.is_none()
                    && !value.stopping =>
            {
                value
            }
            _ => return Err("动态库尚未准备好或已停止。".into()),
        };
        let mut output = LibraryBuffer {
            data: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: all ABI functions run serially on the owning worker; the input and output
        // live for the duration of this call. The trusted library owns the returned allocation.
        let status = unsafe {
            (loaded.api.call)(
                loaded.instance,
                request.as_ptr(),
                request.len(),
                &mut output,
            )
        };
        if output.data.is_null() && output.len != 0 {
            loaded.terminal_error = Some("动态库返回了无效的缓冲区，无法确认资源状态。".into());
            return Err(loaded.terminal_error.clone().unwrap());
        }
        let bytes = if output.len > MAX_MESSAGE {
            Err("动态库输出超过单条消息长度限制。".to_string())
        } else if output.data.is_null() {
            Ok(Vec::new())
        } else {
            // SAFETY: the ABI requires a valid buffer of exactly len bytes until free_buffer.
            Ok(unsafe { std::slice::from_raw_parts(output.data, output.len) }.to_vec())
        };
        if !output.data.is_null() {
            // SAFETY: the allocation belongs to this library and is released exactly once.
            unsafe { (loaded.api.free)(output.data, output.len) };
        }
        let message = String::from_utf8(bytes?).map_err(|_| "动态库输出不是有效的 UTF-8。")?;
        if status != 0 {
            return Err(format!("动态库调用失败（错误码 {status}）：{message}"));
        }
        Ok(message)
    }
    fn close(&mut self) -> Result<(), String> {
        let loaded = match self {
            Self::Failed {
                cleanup_error: Some(error),
                ..
            } => return Err(error.clone()),
            Self::Failed {
                cleanup_error: None,
                ..
            } => return Ok(()),
            Self::Loaded(value) => value,
        };
        if let Some(error) = &loaded.terminal_error {
            return Err(error.clone());
        }
        loaded.stopping = true;
        if !loaded.instance.is_null() {
            // SAFETY: no call is executing on this serial worker. On failure the ABI requires
            // the instance to remain valid for retry; success ends its threads and frees it.
            let status = unsafe { (loaded.api.shutdown)(loaded.instance) };
            if status != 0 {
                return Err(format!("动态库清理失败（错误码 {status}）。"));
            }
            loaded.instance = ptr::null_mut();
        }
        if let Some(library) = loaded.library.take() {
            let library = ManuallyDrop::into_inner(library);
            if let Err(error) = library.close() {
                let error = format!("动态库释放失败，无法确认资源状态：{error}");
                loaded.terminal_error = Some(error.clone());
                return Err(error);
            }
        }
        Ok(())
    }
}

fn run_worker(entry: String, receiver: mpsc::Receiver<Command>) {
    let mut state = start_library(&entry);
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Ready(reply) => {
                let _ = reply.send(state.ready());
            }
            Command::Call(request, reply) => {
                let _ = reply.send(state.call(&request));
            }
            Command::Close(reply) => {
                let result = state.close();
                let closed = result.is_ok();
                let _ = reply.send(result);
                if closed {
                    break;
                }
            }
        }
    }
}

fn open(registry: &NativeLibraries, entry: String) -> Result<String, String> {
    if !Path::new(&entry).is_absolute() {
        return Err("动态库路径必须是绝对路径。".into());
    }
    let entry =
        std::fs::canonicalize(&entry).map_err(|error| format!("无法访问动态库路径：{error}"))?;
    if !entry.is_file() {
        return Err("动态库路径不是文件。".into());
    }
    let entry = entry
        .to_str()
        .ok_or("动态库路径不是有效的 UTF-8。")?
        .to_string();
    let (sender, receiver) = mpsc::channel();
    let id = Uuid::new_v4().to_string();
    registry
        .sessions
        .lock()
        .map_err(|_| "动态库状态不可用。")?
        .insert(id.clone(), sender);
    if let Err(error) = thread::Builder::new()
        .name("lodestory-native-library".into())
        .spawn(move || run_worker(entry, receiver))
    {
        registry.remove(&id)?;
        return Err(format!("无法启动动态库后台线程：{error}"));
    }
    Ok(id)
}

fn request<T>(
    registry: &NativeLibraries,
    id: &str,
    command: impl FnOnce(Reply<T>) -> Command,
) -> Result<T, String> {
    let sender = registry.get(id)?;
    let (reply, result) = mpsc::channel();
    sender
        .send(command(reply))
        .map_err(|_| "动态库后台线程不可用，无法确认资源状态。")?;
    result
        .recv()
        .map_err(|_| "动态库后台线程中断，无法确认资源状态。")?
}

#[tauri::command]
pub async fn native_library_open(
    state: State<'_, Arc<NativeLibraries>>,
    entry: String,
) -> Result<String, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open(&registry, entry))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn native_library_ready(
    state: State<'_, Arc<NativeLibraries>>,
    id: String,
) -> Result<(), String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request(&registry, &id, Command::Ready))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn native_library_call(
    state: State<'_, Arc<NativeLibraries>>,
    id: String,
    request_data: String,
) -> Result<String, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        request(&registry, &id, |reply| Command::Call(request_data, reply))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn native_library_close(
    state: State<'_, Arc<NativeLibraries>>,
    id: String,
) -> Result<(), String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        request(&registry, &id, Command::Close)?;
        registry.remove(&id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command as ProcessCommand};

    fn fixture(feature: Option<&str>) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let manifest = root.join("tests/fixtures/native-library-d/Cargo.toml");
        let target = root.join(".desktop-e2e").join(format!(
            "native-library-rust-{}",
            feature.unwrap_or("normal")
        ));
        let mut command = ProcessCommand::new("cargo");
        command
            .args(["build", "--offline", "--locked", "--manifest-path"])
            .arg(manifest)
            .arg("--target-dir")
            .arg(&target);
        if let Some(feature) = feature {
            command.args(["--features", feature]);
        }
        let output = command
            .output()
            .expect("failed to build dynamic library fixture");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        target.join("debug").join(format!(
            "{}lodestory_test_library_d{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        ))
    }

    #[test]
    fn trusted_library_calls_and_retries_shutdown_on_its_worker() {
        let path = fixture(None);
        let registry = NativeLibraries::default();
        let id = open(&registry, path.to_str().unwrap().to_string()).unwrap();
        request(&registry, &id, Command::Ready).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("cleaned");
        let configure = serde_json::json!({"type":"call", "requestId":"configure", "operation":"configureShutdown",
            "schemaVersion":"1.0.0", "params":{"markerPath":marker.to_str().unwrap(), "rejectOnce":true}}).to_string();
        request(&registry, &id, |reply| Command::Call(configure, reply)).unwrap();
        assert!(request(&registry, &id, Command::Close)
            .unwrap_err()
            .contains("错误码 7"));
        assert!(!marker.exists());
        let ping = serde_json::json!({"type":"call", "requestId":"ping", "operation":"ping", "schemaVersion":"1.0.0", "params":null}).to_string();
        assert!(request(&registry, &id, |reply| Command::Call(ping, reply))
            .unwrap_err()
            .contains("已停止"));
        request(&registry, &id, Command::Close).unwrap();
        registry.remove(&id).unwrap();
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "D 已清理");
        assert!(registry.get(&id).is_err());
    }

    #[test]
    fn incompatible_or_partly_initialized_library_is_cleaned() {
        for (feature, expected) in [
            ("incompatible-abi", "版本不兼容"),
            ("fail-init", "初始化失败"),
        ] {
            let registry = NativeLibraries::default();
            let id = open(
                &registry,
                fixture(Some(feature)).to_str().unwrap().to_string(),
            )
            .unwrap();
            assert!(request(&registry, &id, Command::Ready)
                .unwrap_err()
                .contains(expected));
            request(&registry, &id, Command::Close).unwrap();
            registry.remove(&id).unwrap();
            assert!(registry.get(&id).is_err());
        }
    }

    #[test]
    fn partly_initialized_instance_is_retained_when_cleanup_fails() {
        let registry = NativeLibraries::default();
        let path = fixture(Some("fail-init-retry"));
        let id = open(&registry, path.to_str().unwrap().to_string()).unwrap();
        assert!(request(&registry, &id, Command::Ready)
            .unwrap_err()
            .contains("初始化失败"));
        assert!(request(&registry, &id, Command::Close)
            .unwrap_err()
            .contains("错误码 7"));
        assert!(registry.get(&id).is_ok());
        request(&registry, &id, Command::Close).unwrap();
        registry.remove(&id).unwrap();
    }
}
