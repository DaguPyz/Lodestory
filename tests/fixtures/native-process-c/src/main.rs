use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn send(output: &mut impl Write, message: Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &message)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut shutdown_marker: Option<String> = None;
    let mut reject_shutdown_once = false;

    // 告诉 A：C 的后端已经准备好，可以接收请求。
    send(
        &mut output,
        json!({"type": "ready", "protocolVersion": "1.0.0"}),
    )?;

    for line in stdin.lock().lines() {
        let line = line?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("无法读取请求：{error}");
                continue;
            }
        };
        let Some(request_id) = request.get("requestId").and_then(Value::as_str) else {
            eprintln!("请求缺少 ID");
            continue;
        };
        let response = match request.get("type").and_then(Value::as_str) {
            Some("call") => {
                if request.get("operation").and_then(Value::as_str) == Some("configureShutdown") {
                    let params = request.get("params").unwrap_or(&Value::Null);
                    shutdown_marker = params
                        .get("markerPath")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    reject_shutdown_once = params
                        .get("rejectOnce")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    json!({"type":"response", "requestId":request_id, "status":"success", "result": {
                        "pid": std::process::id()
                    }})
                } else if request.get("operation").and_then(Value::as_str) == Some("ping")
                    && request.get("schemaVersion").and_then(Value::as_str) == Some("1.0.0")
                {
                    json!({"type":"response", "requestId":request_id, "status":"success", "result": {
                        "message":"C 已收到请求", "params":request.get("params").cloned().unwrap_or(Value::Null)
                    }})
                } else {
                    json!({"type":"response", "requestId":request_id, "status":"error", "error": {
                        "code":"PLUGIN_OPERATION_FAILED", "message":"不支持的操作或参数版本"
                    }})
                }
            }
            Some("shutdown") => {
                if reject_shutdown_once {
                    reject_shutdown_once = false;
                    send(
                        &mut output,
                        json!({"type":"response", "requestId":request_id, "status":"error", "error": {
                            "code":"TEST_SHUTDOWN_FAILED", "message":"模拟后端清理失败"
                        }}),
                    )?;
                    continue;
                }
                if let Some(path) = &shutdown_marker {
                    if let Err(error) = std::fs::write(path, std::process::id().to_string()) {
                        send(
                            &mut output,
                            json!({"type":"response", "requestId":request_id, "status":"error", "error": {
                                "code":"TEST_MARKER_FAILED", "message":error.to_string()
                            }}),
                        )?;
                        continue;
                    }
                }
                send(
                    &mut output,
                    json!({"type":"response", "requestId":request_id, "status":"success", "result":null}),
                )?;
                return Ok(());
            }
            _ => json!({"type":"response", "requestId":request_id, "status":"error", "error": {
                "code":"PLUGIN_OPERATION_FAILED", "message":"不支持的请求类型"
            }}),
        };
        send(&mut output, response)?;
    }
    Ok(())
}
