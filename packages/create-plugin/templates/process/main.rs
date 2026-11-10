mod protocol;

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn send(output: &mut impl Write, message: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, message)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    send(
        &mut output,
        &json!({"type": "ready", "protocolVersion": "1.0.0"}),
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
        if request.get("type").and_then(Value::as_str) == Some("shutdown") {
            if let Some(id) = request
                .get("requestId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                // Release resources started by this backend before reporting success.
                send(
                    &mut output,
                    &json!({"type": "response", "requestId": id, "status": "success", "result": null}),
                )?;
                return Ok(());
            }
            eprintln!("退出请求缺少 ID");
        } else if let Some(response) = protocol::call(&request) {
            send(&mut output, &response)?;
        } else {
            eprintln!("请求缺少 ID");
        }
    }
    Ok(())
}
