//! Generic child process I/O. Protocol belongs to the loader plugin.
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::State;
use uuid::Uuid;

const MAX_LINE: u64 = 8 * 1024 * 1024;

struct Process {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    output: Mutex<BufReader<ChildStdout>>,
}

#[derive(Default)]
pub struct NativeProcesses {
    sessions: Mutex<HashMap<String, Arc<Process>>>,
}

impl NativeProcesses {
    fn get(&self, id: &str) -> Result<Arc<Process>, String> {
        self.sessions
            .lock()
            .map_err(|_| "进程状态不可用。".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "进程不存在。".to_string())
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "进程状态不可用。".to_string())?
            .remove(id);
        Ok(())
    }
}

fn start(registry: &NativeProcesses, entry: &str) -> Result<String, String> {
    if entry.trim().is_empty() {
        return Err("程序入口不能为空。".into());
    }
    let mut child = Command::new(entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("无法启动程序：{error}"))?;
    let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("无法打开程序输入输出。".into());
    };
    let id = Uuid::new_v4().to_string();
    let process = Arc::new(Process {
        child: Mutex::new(child),
        input: Mutex::new(input),
        output: Mutex::new(BufReader::new(output)),
    });
    match registry.sessions.lock() {
        Ok(mut sessions) => {
            sessions.insert(id.clone(), process);
            Ok(id)
        }
        Err(_) => {
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            Err("无法登记进程。".into())
        }
    }
}

fn read_frame(output: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let count = output
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("无法读取程序输出：{error}"))?;
    if count == 0 {
        return Ok(None);
    }
    if bytes.len() as u64 > MAX_LINE {
        return Err("程序输出超过单条消息长度限制。".into());
    }
    if !bytes.ends_with(b"\n") {
        return Err("程序输出不完整。".into());
    }
    bytes.pop();
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "程序输出不是有效的 UTF-8。".into())
}

fn read_line(process: &Process) -> Result<Option<String>, String> {
    let mut output = process.output.lock().map_err(|_| "程序输出不可用。")?;
    read_frame(&mut *output)
}

#[tauri::command]
pub async fn native_process_start(
    state: State<'_, Arc<NativeProcesses>>,
    entry: String,
) -> Result<String, String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start(&registry, &entry))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn native_process_read(
    state: State<'_, Arc<NativeProcesses>>,
    id: String,
) -> Result<Option<String>, String> {
    let process = state.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || read_line(&process))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn native_process_write(
    state: State<'_, Arc<NativeProcesses>>,
    id: String,
    line: String,
) -> Result<(), String> {
    if line.contains('\n') || line.len() as u64 > MAX_LINE {
        return Err("程序输入格式无效或消息过大。".into());
    }
    let process = state.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut input = process.input.lock().map_err(|_| "程序输入不可用。")?;
        input
            .write_all(line.as_bytes())
            .and_then(|_| input.write_all(b"\n"))
            .and_then(|_| input.flush())
            .map_err(|e| format!("无法写入程序输入：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn native_process_wait(
    state: State<'_, Arc<NativeProcesses>>,
    id: String,
) -> Result<i32, String> {
    let registry = state.inner().clone();
    let process = registry.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || loop {
        let status = process
            .child
            .lock()
            .map_err(|_| "进程状态不可用。")?
            .try_wait()
            .map_err(|e| format!("无法检查进程状态：{e}"))?;
        if let Some(status) = status {
            registry.remove(&id)?;
            return Ok(status.code().unwrap_or(-1));
        }
        thread::sleep(Duration::from_millis(50));
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clean up a process that failed before initialization completed.
#[tauri::command]
pub async fn native_process_abort_start(
    state: State<'_, Arc<NativeProcesses>>,
    id: String,
) -> Result<(), String> {
    let registry = state.inner().clone();
    let process = registry.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = process.child.lock().map_err(|_| "进程状态不可用。")?;
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child
                .kill()
                .map_err(|e| format!("无法清理未启动的进程：{e}"))?;
            child.wait().map_err(|e| format!("无法确认进程结束：{e}"))?;
        }
        registry.remove(&id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_complete_lines_and_rejects_truncated_or_invalid_output() {
        let mut input = BufReader::new(Cursor::new("一\n二\n".as_bytes()));
        assert_eq!(read_frame(&mut input).unwrap().as_deref(), Some("一"));
        assert_eq!(read_frame(&mut input).unwrap().as_deref(), Some("二"));
        assert_eq!(read_frame(&mut input).unwrap(), None);
        assert!(read_frame(&mut BufReader::new(Cursor::new(b"partial"))).is_err());
        assert!(read_frame(&mut BufReader::new(Cursor::new([0xff, b'\n']))).is_err());
    }
}
