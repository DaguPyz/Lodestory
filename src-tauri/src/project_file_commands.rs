use crate::{
    project_files::{ProjectDirectoryListing, ProjectFileRecord, ProjectFiles},
    project_index::ProjectError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

const BINARY_SAVE_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BinarySaveMetadata {
    version: u32,
    project_path: String,
    path: String,
    byte_length: usize,
    expected_byte_length: usize,
}

fn invalid_binary_save(message: impl Into<String>) -> ProjectError {
    ProjectError::new("invalid_file_bytes", message)
}

fn parse_binary_save_body(body: &[u8]) -> Result<(BinarySaveMetadata, &[u8], &[u8]), ProjectError> {
    if body.len() < 4 {
        return Err(invalid_binary_save(
            "二进制保存请求头不完整，未修改项目文件。",
        ));
    }
    let metadata_length =
        u32::from_le_bytes(body[..4].try_into().expect("four-byte header")) as usize;
    let metadata_end = 4usize
        .checked_add(metadata_length)
        .ok_or_else(|| invalid_binary_save("二进制保存请求长度溢出，未修改项目文件。"))?;
    let metadata_bytes = body
        .get(4..metadata_end)
        .ok_or_else(|| invalid_binary_save("二进制保存请求元数据被截断，未修改项目文件。"))?;
    let metadata: BinarySaveMetadata = serde_json::from_slice(metadata_bytes)
        .map_err(|_| invalid_binary_save("二进制保存请求元数据无效，未修改项目文件。"))?;
    if metadata.version != BINARY_SAVE_VERSION {
        return Err(invalid_binary_save(
            "二进制保存请求版本不受支持，未修改项目文件。",
        ));
    }
    let data_end = metadata_end
        .checked_add(metadata.byte_length)
        .ok_or_else(|| invalid_binary_save("二进制保存文件长度溢出，未修改项目文件。"))?;
    let body_end = data_end
        .checked_add(metadata.expected_byte_length)
        .ok_or_else(|| invalid_binary_save("二进制保存基准长度溢出，未修改项目文件。"))?;
    if body_end != body.len() {
        return Err(invalid_binary_save(
            "二进制保存请求长度与元数据不一致，未修改项目文件。",
        ));
    }
    let data = body
        .get(metadata_end..data_end)
        .ok_or_else(|| invalid_binary_save("二进制保存文件内容被截断，未修改项目文件。"))?;
    let expected = body
        .get(data_end..body_end)
        .ok_or_else(|| invalid_binary_save("二进制保存冲突基准被截断，未修改项目文件。"))?;
    Ok((metadata, data, expected))
}

/** Lossless transport for large buffers without a JSON number for every byte. */
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileBase64Record {
    path: String,
    file_name: String,
    bytes_base64: String,
    byte_length: usize,
}

fn encode_record(record: ProjectFileRecord) -> ProjectFileBase64Record {
    ProjectFileBase64Record {
        path: record.path,
        file_name: record.file_name,
        byte_length: record.bytes.len(),
        bytes_base64: STANDARD.encode(&record.bytes),
    }
}

fn decode_bytes(encoded: &str) -> Result<Vec<u8>, ProjectError> {
    STANDARD
        .decode(encoded)
        .map_err(|_| ProjectError::new("invalid_file_bytes", "文件字节编码无效，未修改项目文件。"))
}

async fn with_project_files<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&ProjectFiles) -> Result<T, ProjectError> + Send + 'static,
) -> Result<T, ProjectError> {
    tauri::async_runtime::spawn_blocking(move || action(app.state::<ProjectFiles>().inner()))
        .await
        .map_err(|error| {
            ProjectError::new(
                "project_file_operation_failed",
                format!("项目文件操作失败：{error}"),
            )
        })?
}

#[tauri::command]
pub async fn read_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ProjectFileRecord, ProjectError> {
    with_project_files(app, move |store| {
        store.read(Path::new(&project_path), &path)
    })
    .await
}

#[tauri::command]
pub async fn read_project_file_base64(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ProjectFileBase64Record, ProjectError> {
    with_project_files(app, move |store| {
        store
            .read(Path::new(&project_path), &path)
            .map(encode_record)
    })
    .await
}

#[tauri::command]
pub async fn create_project_file_base64(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes_base64: String,
    create_parents: Option<bool>,
    accept_identical: Option<bool>,
) -> Result<ProjectFileBase64Record, ProjectError> {
    with_project_files(app, move |store| {
        let bytes = decode_bytes(&bytes_base64)?;
        store
            .create(
                Path::new(&project_path),
                &path,
                &bytes,
                create_parents.unwrap_or(false),
                accept_identical.unwrap_or(false),
            )
            .map(encode_record)
    })
    .await
}

#[tauri::command]
pub async fn save_project_file_base64(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes_base64: String,
    expected_bytes_base64: String,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        let bytes = decode_bytes(&bytes_base64)?;
        let expected_bytes = decode_bytes(&expected_bytes_base64)?;
        store.save(Path::new(&project_path), &path, &bytes, &expected_bytes)
    })
    .await
}

/** Save a raw IPC body: [u32LE metadata size][UTF-8 JSON metadata][bytes][expected bytes]. */
#[tauri::command]
pub async fn save_project_file_binary(
    app: AppHandle,
    request: Request<'_>,
) -> Result<(), ProjectError> {
    let body = match request.body() {
        InvokeBody::Raw(body) => body.clone(),
        InvokeBody::Json(_) => {
            return Err(invalid_binary_save(
                "保存请求必须使用二进制 IPC，未修改项目文件。",
            ));
        }
    };
    with_project_files(app, move |store| {
        let (metadata, bytes, expected_bytes) = parse_binary_save_body(&body)?;
        store.save(
            Path::new(&metadata.project_path),
            &metadata.path,
            bytes,
            expected_bytes,
        )
    })
    .await
}

#[tauri::command]
pub async fn delete_project_file_base64(
    app: AppHandle,
    project_path: String,
    path: String,
    expected_bytes_base64: String,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        let expected_bytes = decode_bytes(&expected_bytes_base64)?;
        store.delete(Path::new(&project_path), &path, &expected_bytes)
    })
    .await
}

#[tauri::command]
pub async fn create_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes: Vec<u8>,
    create_parents: Option<bool>,
    accept_identical: Option<bool>,
) -> Result<ProjectFileRecord, ProjectError> {
    with_project_files(app, move |store| {
        store.create(
            Path::new(&project_path),
            &path,
            &bytes,
            create_parents.unwrap_or(false),
            accept_identical.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn save_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    bytes: Vec<u8>,
    expected_bytes: Vec<u8>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.save(Path::new(&project_path), &path, &bytes, &expected_bytes)
    })
    .await
}

#[tauri::command]
pub async fn delete_project_file(
    app: AppHandle,
    project_path: String,
    path: String,
    expected_bytes: Vec<u8>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.delete(Path::new(&project_path), &path, &expected_bytes)
    })
    .await
}

#[tauri::command]
pub async fn list_project_directory(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ProjectDirectoryListing, ProjectError> {
    with_project_files(app, move |store| {
        store.list_directory(Path::new(&project_path), &path)
    })
    .await
}

#[tauri::command]
pub async fn create_project_directory(
    app: AppHandle,
    project_path: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.create_directory(Path::new(&project_path), &path, recursive.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn rename_project_path(
    app: AppHandle,
    project_path: String,
    from_path: String,
    to_path: String,
) -> Result<(), ProjectError> {
    with_project_files(app, move |store| {
        store.rename_path(Path::new(&project_path), &from_path, &to_path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn binary_save_body(metadata: serde_json::Value, bytes: &[u8], expected: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(&metadata).unwrap();
        let mut body = Vec::with_capacity(4 + metadata.len() + bytes.len() + expected.len());
        body.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        body.extend_from_slice(&metadata);
        body.extend_from_slice(bytes);
        body.extend_from_slice(expected);
        body
    }

    fn metadata(
        project_path: &str,
        path: &str,
        bytes: &[u8],
        expected: &[u8],
    ) -> serde_json::Value {
        serde_json::json!({
            "version": BINARY_SAVE_VERSION,
            "projectPath": project_path,
            "path": path,
            "byteLength": bytes.len(),
            "expectedByteLength": expected.len(),
        })
    }

    #[test]
    fn base64_records_preserve_all_byte_values_and_empty_files() {
        for bytes in [
            vec![],
            (0..=255).collect::<Vec<u8>>(),
            b"\xef\xbb\xbfA\r\n\0Z\n".to_vec(),
        ] {
            let encoded = encode_record(ProjectFileRecord {
                path: "中文.txt".into(),
                file_name: "中文.txt".into(),
                bytes: bytes.clone(),
            });
            assert_eq!(encoded.byte_length, bytes.len());
            assert_eq!(encoded.path, "中文.txt");
            assert_eq!(decode_bytes(&encoded.bytes_base64).unwrap(), bytes);
        }
        assert!(decode_bytes("A===").is_err());
        assert!(decode_bytes("invalid!").is_err());
    }

    #[test]
    fn encoded_transport_keeps_native_conflict_and_atomic_write_guards() {
        let project = tempfile::tempdir().unwrap();
        let store = ProjectFiles::default();
        let original = b"\xef\xbb\xbfA\r\nB\n".to_vec();
        let first = encode_record(
            store
                .create(project.path(), "story.txt", &original, false, false)
                .unwrap(),
        );
        let baseline = decode_bytes(&first.bytes_base64).unwrap();
        let edited = decode_bytes(&STANDARD.encode(b"\xef\xbb\xbfA\r\n\xe4\xb8\xad\n")).unwrap();
        store
            .save(project.path(), "story.txt", &edited, &baseline)
            .unwrap();
        assert_eq!(fs::read(project.path().join("story.txt")).unwrap(), edited);
        fs::write(project.path().join("story.txt"), b"external").unwrap();
        assert!(store
            .save(project.path(), "story.txt", b"next", &edited)
            .is_err());
        assert!(store.delete(project.path(), "story.txt", &edited).is_err());
        assert_eq!(
            fs::read(project.path().join("story.txt")).unwrap(),
            b"external"
        );
        assert!(store.read(project.path(), "../outside.txt").is_err());
    }

    #[test]
    fn binary_save_frames_keep_payloads_as_opaque_bytes() {
        let project = "/tmp/project";
        let mixed_utf8_bom = "\u{feff}中文\r\n\0Z".as_bytes();
        let all_byte_values = (0..=255).collect::<Vec<u8>>();
        for (bytes, expected) in [
            (&[][..], &[][..]),
            (all_byte_values.as_slice(), &[][..]),
            (mixed_utf8_bom, &b"old\xff"[..]),
        ] {
            let body = binary_save_body(
                metadata(project, "story.bin", bytes, expected),
                bytes,
                expected,
            );
            let (decoded_metadata, decoded_bytes, decoded_expected) =
                parse_binary_save_body(&body).unwrap();
            assert_eq!(decoded_metadata.version, BINARY_SAVE_VERSION);
            assert_eq!(decoded_metadata.project_path, project);
            assert_eq!(decoded_metadata.path, "story.bin");
            assert_eq!(decoded_bytes, bytes);
            assert_eq!(decoded_expected, expected);
        }
    }

    #[test]
    fn binary_save_frames_reject_bad_headers_truncation_trailing_and_oversize() {
        assert!(parse_binary_save_body(&[1, 2, 3]).is_err());

        let mut truncated_metadata = 64u32.to_le_bytes().to_vec();
        truncated_metadata.extend_from_slice(b"{}");
        assert!(parse_binary_save_body(&truncated_metadata).is_err());

        let valid_meta = metadata("/tmp/project", "story.bin", b"new", b"old");
        let mut truncated_payload = binary_save_body(valid_meta.clone(), b"new", b"old");
        truncated_payload.pop();
        assert!(parse_binary_save_body(&truncated_payload).is_err());

        let mut trailing = binary_save_body(valid_meta, b"new", b"old");
        trailing.push(0);
        assert!(parse_binary_save_body(&trailing).is_err());

        let mut unknown_version = metadata("/tmp/project", "story.bin", b"", b"");
        unknown_version["version"] = serde_json::json!(2);
        assert!(parse_binary_save_body(&binary_save_body(unknown_version, b"", b"")).is_err());

        let oversized = serde_json::json!({
            "version": BINARY_SAVE_VERSION,
            "projectPath": "/tmp/project",
            "path": "story.bin",
            "byteLength": usize::MAX,
            "expectedByteLength": 1,
        });
        assert!(parse_binary_save_body(&binary_save_body(oversized, b"", b"")).is_err());
    }

    #[test]
    fn binary_save_frames_preserve_native_conflict_and_path_guards() {
        let project = tempfile::tempdir().unwrap();
        let store = ProjectFiles::default();
        let original = b"\xef\xbb\xbfA\r\n\0old";
        let edited = b"\xef\xbb\xbfA\r\n\xe4\xb8\xad";
        store
            .create(project.path(), "story.txt", original, false, false)
            .unwrap();

        let body = binary_save_body(
            metadata(
                project.path().to_str().unwrap(),
                "story.txt",
                edited,
                original,
            ),
            edited,
            original,
        );
        let (parsed, bytes, expected) = parse_binary_save_body(&body).unwrap();
        store
            .save(
                Path::new(&parsed.project_path),
                &parsed.path,
                bytes,
                expected,
            )
            .unwrap();
        assert_eq!(fs::read(project.path().join("story.txt")).unwrap(), edited);

        let conflict = binary_save_body(
            metadata(
                project.path().to_str().unwrap(),
                "story.txt",
                b"next",
                b"stale",
            ),
            b"next",
            b"stale",
        );
        let (parsed, bytes, expected) = parse_binary_save_body(&conflict).unwrap();
        assert!(store
            .save(
                Path::new(&parsed.project_path),
                &parsed.path,
                bytes,
                expected
            )
            .is_err());
        assert_eq!(fs::read(project.path().join("story.txt")).unwrap(), edited);

        let escape = binary_save_body(
            metadata(
                project.path().to_str().unwrap(),
                "../outside.txt",
                b"next",
                edited,
            ),
            b"next",
            edited,
        );
        let (parsed, bytes, expected) = parse_binary_save_body(&escape).unwrap();
        assert!(store
            .save(
                Path::new(&parsed.project_path),
                &parsed.path,
                bytes,
                expected
            )
            .is_err());
        assert_eq!(fs::read(project.path().join("story.txt")).unwrap(), edited);
    }
}
