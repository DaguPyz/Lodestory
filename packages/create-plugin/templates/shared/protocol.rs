use serde_json::{json, Value};

/// Add your backend operations here. Both backend forms use the same JSON messages.
pub fn call(request: &Value) -> Option<Value> {
    let id = request
        .get("requestId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    if request.get("type").and_then(Value::as_str) == Some("call")
        && request.get("operation").and_then(Value::as_str) == Some("ping")
        && request.get("schemaVersion").and_then(Value::as_str) == Some("1.0.0")
    {
        Some(json!({
            "type": "response",
            "requestId": id,
            "status": "success",
            "result": {
                "message": "后端已收到请求",
                "params": request.get("params").cloned().unwrap_or(Value::Null)
            }
        }))
    } else {
        Some(json!({
            "type": "response",
            "requestId": id,
            "status": "error",
            "error": {"code": "PLUGIN_OPERATION_FAILED", "message": "不支持的操作或参数版本"}
        }))
    }
}
