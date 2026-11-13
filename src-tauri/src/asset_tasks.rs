use serde_json::Value;
use std::collections::HashSet;

pub const VALIDATE_AND_ENCODE: &str = "asset-management/validate-and-encode-group";

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| match i {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

pub fn validate_and_encode(input: Value) -> Result<Vec<u8>, String> {
    let id = input
        .get("id")
        .ok_or("资产对象分组 ID 必须是 UUID 或空类型。")?;
    if !id.is_null() && !id.as_str().is_some_and(is_uuid) {
        return Err("资产对象分组 ID 必须是 UUID 或空类型。".into());
    }
    let data = input
        .get("data")
        .and_then(Value::as_object)
        .filter(|data| data.len() == 2)
        .ok_or("资产对象分组文件字段无效，原文件已保留。")?;
    let assets = data
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("资产对象分组文件字段无效，原文件已保留。")?;
    let fields = data
        .get("fields")
        .and_then(Value::as_array)
        .ok_or("资产对象分组文件字段无效，原文件已保留。")?;
    let mut ids = HashSet::new();
    for asset in assets {
        let asset_id = asset.get("id").and_then(Value::as_str);
        if asset.get("typeId") != Some(id)
            || !asset_id.is_some_and(is_uuid)
            || !ids.insert(asset_id.unwrap_or_default())
        {
            return Err("资产对象不属于当前模板分组或 ID 重复，原文件已保留。".into());
        }
    }
    for field in fields {
        let owner = field
            .get("owner")
            .and_then(Value::as_object)
            .ok_or("资产字段所属信息无效，原文件已保留。")?;
        match owner.get("kind").and_then(Value::as_str) {
            Some("type") => return Err("对象文件中不能包含模板字段，原文件已保留。".into()),
            Some("asset")
                if owner
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.contains(id)) =>
            {
                ()
            }
            Some("asset") => {
                return Err("对象专属字段的所属对象不在当前分组，原文件已保留。".into())
            }
            _ => return Err("资产字段所属类型无效，原文件已保留。".into()),
        }
    }
    let mut bytes =
        serde_json::to_vec_pretty(data).map_err(|error| format!("资产对象编码失败：{error}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_group_ownership_and_encodes_utf8() {
        let id = "29ee729f-3240-5332-b20a-3792571679c2";
        let asset_id = "80332fee-ddf9-50c6-90e8-28bdd854ddf1";
        let input = json!({"id": id, "data": {"assets": [{"id": asset_id, "typeId": id, "name": "人物"}],
            "fields": [{"owner": {"kind": "asset", "id": asset_id}}]}});
        let bytes = validate_and_encode(input.clone()).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            input["data"]
        );
        let mut invalid = input.clone();
        invalid["data"]["fields"][0]["owner"]["id"] = json!(id);
        assert!(validate_and_encode(invalid).is_err());
        let mut template_field = input.clone();
        template_field["data"]["fields"][0]["owner"] = json!({"kind": "type", "id": id});
        assert!(validate_and_encode(template_field).is_err());
        let mut duplicate = input.clone();
        duplicate["data"]["assets"]
            .as_array_mut()
            .unwrap()
            .push(input["data"]["assets"][0].clone());
        assert!(validate_and_encode(duplicate).is_err());
    }
}
