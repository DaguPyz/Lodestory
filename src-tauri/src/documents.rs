use crate::project_index::{validate_directory_name, ProjectError};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

#[derive(Default)]
pub struct Documents {
    writes: Mutex<()>,
}

impl Documents {
    pub fn list(&self, project: &Path) -> Result<Vec<TreeEntry>, ProjectError> {
        let root = project_root(project)?;
        directory_entries(&root, &root)
    }

    pub fn create(
        &self,
        project: &Path,
        parent_path: &str,
        name: &str,
    ) -> Result<Document, ProjectError> {
        let _guard = self.writes.lock().map_err(|_| busy())?;
        let root = project_root(project)?;
        let parent = resolve_inside(&root, parent_path)?;
        fs::read_dir(&parent).map_err(|error| {
            failure("document_create_failed", "无法访问保存目录", &parent, error)
        })?;
        let file_name = document_name(name)?;
        let path = parent.join(file_name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == ErrorKind::AlreadyExists {
                    ProjectError::new("document_exists", "已存在同名文档，请换一个名称。")
                } else {
                    failure("document_create_failed", "创建文档失败", &path, error)
                }
            })?;
        file.sync_all()
            .map_err(|error| failure("document_create_failed", "保存新文档失败", &path, error))?;
        Ok(document(&root, &path, String::new()))
    }

    pub fn read(&self, project: &Path, relative: &str) -> Result<Document, ProjectError> {
        let root = project_root(project)?;
        let path = document_path(&root, relative)?;
        let content = fs::read_to_string(&path).map_err(|error| {
            failure(
                "document_read_failed",
                "读取文档失败（请确认文档使用 UTF-8 编码）",
                &path,
                error,
            )
        })?;
        Ok(document(&root, &path, content))
    }

    pub fn save(
        &self,
        project: &Path,
        relative: &str,
        content: &str,
        expected_content: &str,
    ) -> Result<(), ProjectError> {
        let _guard = self.writes.lock().map_err(|_| busy())?;
        let root = project_root(project)?;
        let path = document_path(&root, relative)?;
        let failed = |error| failure("document_save_failed", "保存文档失败", &path, error);
        let current = fs::read_to_string(&path).map_err(failed)?;
        if current != expected_content {
            return Err(ProjectError::new(
                "document_changed",
                "文档已被其他程序修改，未覆盖磁盘内容；请保留当前正文并处理外部修改。",
            ));
        }
        let permissions = fs::metadata(&path).map_err(failed)?.permissions();
        if permissions.readonly() {
            return Err(ProjectError::new(
                "document_readonly",
                "文档为只读状态，无法保存；请调整文件权限后重试。",
            ));
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(".lodestory-document-")
            .tempfile_in(path.parent().unwrap())
            .map_err(failed)?;
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(failed)?;
        temporary.write_all(content.as_bytes()).map_err(failed)?;
        temporary.as_file().sync_all().map_err(failed)?;
        temporary
            .persist(&path)
            .map_err(|error| failed(error.error))?;
        Ok(())
    }
}

fn busy() -> ProjectError {
    ProjectError::new("document_busy", "文档暂时无法访问，请重新启动应用。")
}

fn failure(code: &'static str, action: &str, path: &Path, error: std::io::Error) -> ProjectError {
    ProjectError::new(code, format!("{action}（{}）：{error}", path.display()))
}

fn project_root(path: &Path) -> Result<PathBuf, ProjectError> {
    if !path.is_absolute() {
        return Err(ProjectError::new(
            "invalid_path",
            "作品目录必须使用绝对路径。",
        ));
    }
    let root = dunce::canonicalize(path)
        .map_err(|error| failure("project_unavailable", "无法访问作品目录", path, error))?;
    fs::read_dir(&root)
        .map_err(|error| failure("project_unavailable", "无法读取作品目录", &root, error))?;
    Ok(root)
}

fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    let relative_path = Path::new(relative);
    if relative.contains('\\')
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(ProjectError::new(
            "invalid_document_path",
            "文档必须位于当前作品目录中。",
        ));
    }
    let path = dunce::canonicalize(root.join(relative_path)).map_err(|error| {
        failure(
            "document_unavailable",
            "无法访问文档路径",
            &root.join(relative_path),
            error,
        )
    })?;
    if !path.starts_with(root) {
        return Err(ProjectError::new(
            "invalid_document_path",
            "文档必须位于当前作品目录中。",
        ));
    }
    Ok(path)
}

fn document_path(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    let path = resolve_inside(root, relative)?;
    if !path.is_file() || !supported_document(&path) {
        return Err(ProjectError::new(
            "unsupported_document",
            "请选择 Markdown 或纯文本文档。",
        ));
    }
    Ok(path)
}

fn document_name(name: &str) -> Result<String, ProjectError> {
    let invalid = || {
        ProjectError::new("invalid_document_name", "文档名称不能为空，不能以点开头，或包含路径分隔符、特殊字符、首尾空格及系统保留名称；名称过长时请缩短。" )
    };
    validate_directory_name(name).map_err(|_| invalid())?;
    if name.starts_with('.') {
        return Err(invalid());
    }
    let file_name = if supported_document(Path::new(name)) {
        name.to_owned()
    } else {
        format!("{name}.md")
    };
    validate_directory_name(&file_name).map_err(|_| invalid())?;
    Ok(file_name)
}

fn supported_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt"
            )
        })
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap()
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn document(root: &Path, path: &Path, content: String) -> Document {
    Document {
        path: relative_path(root, path),
        file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        content,
    }
}

fn directory_entries(root: &Path, directory: &Path) -> Result<Vec<TreeEntry>, ProjectError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| failure("document_list_failed", "读取目录失败", directory, error))?
    {
        let entry = entry
            .map_err(|error| failure("document_list_failed", "读取目录项失败", directory, error))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            failure(
                "document_list_failed",
                "读取文件类型失败",
                &entry.path(),
                error,
            )
        })?;
        // Never follow directory links: they can escape the work or form cycles.
        if file_type.is_symlink() {
            continue;
        }
        let children = if file_type.is_dir() {
            Some(directory_entries(root, &entry.path())?)
        } else if file_type.is_file() && supported_document(&entry.path()) {
            None
        } else {
            continue;
        };
        entries.push(TreeEntry {
            path: relative_path(root, &entry.path()),
            name,
            children,
        });
    }
    entries.sort_by(|left, right| {
        right
            .children
            .is_some()
            .cmp(&left.children.is_some())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creating_a_document_persists_a_blank_markdown_file_and_lists_it() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        let created = store.create(root.path(), "", "第一章").unwrap();
        assert_eq!(created.path, "第一章.md");
        assert_eq!(created.content, "");
        assert_eq!(fs::read(root.path().join(&created.path)).unwrap(), b"");
        assert_eq!(store.list(root.path()).unwrap()[0].name, "第一章.md");
        assert_eq!(store.read(root.path(), &created.path).unwrap().content, "");
    }

    #[test]
    fn existing_documents_are_never_overwritten_on_creation() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        fs::write(root.path().join("第一章.md"), "原正文").unwrap();
        for name in ["第一章", "第一章.md"] {
            assert_eq!(
                store.create(root.path(), "", name).unwrap_err().code,
                "document_exists"
            );
        }
        assert_eq!(
            fs::read_to_string(root.path().join("第一章.md")).unwrap(),
            "原正文"
        );
    }

    #[test]
    fn nested_documents_support_text_and_unicode_and_survive_reopening() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        fs::create_dir(root.path().join("正文")).unwrap();
        let created = store.create(root.path(), "正文", "开篇.txt").unwrap();
        assert_eq!(created.path, "正文/开篇.txt");
        store
            .save(root.path(), &created.path, "雨落在渡口。\n第二段。", "")
            .unwrap();
        assert_eq!(
            store.read(root.path(), &created.path).unwrap().content,
            "雨落在渡口。\n第二段。"
        );
        let tree = store.list(root.path()).unwrap();
        assert_eq!(tree[0].children.as_ref().unwrap()[0].path, created.path);
        assert_eq!(fs::read_dir(root.path().join("正文")).unwrap().count(), 1);
    }

    #[test]
    fn invalid_names_and_parent_paths_do_not_create_files() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        for name in [
            "",
            ".hidden",
            "..",
            "../outside",
            "a/b",
            "a\\b",
            "CON",
            "故事.",
            " 故事",
            "故事\n",
        ] {
            assert_eq!(
                store.create(root.path(), "", name).unwrap_err().code,
                "invalid_document_name"
            );
        }
        for parent in ["..", "../outside", "/tmp", "a\\b"] {
            assert_eq!(
                store.create(root.path(), parent, "故事").unwrap_err().code,
                "invalid_document_path"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn listing_includes_only_supported_documents_and_sorts_folders_first() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        for name in ["a.md", "b.TXT", "c.markdown", "image.png", ".hidden.md"] {
            fs::write(root.path().join(name), "").unwrap();
        }
        fs::create_dir(root.path().join("正文")).unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        let tree = store.list(root.path()).unwrap();
        assert_eq!(
            tree.iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["正文", "a.md", "b.TXT", "c.markdown"]
        );
    }

    #[test]
    fn changed_or_deleted_documents_are_preserved_without_recreation() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        let created = store.create(root.path(), "", "故事").unwrap();
        fs::write(root.path().join(&created.path), "外部修改").unwrap();
        assert_eq!(
            store
                .save(root.path(), &created.path, "我的修改", "")
                .unwrap_err()
                .code,
            "document_changed"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(&created.path)).unwrap(),
            "外部修改"
        );
        fs::remove_file(root.path().join(&created.path)).unwrap();
        assert_eq!(
            store
                .save(root.path(), &created.path, "我的修改", "")
                .unwrap_err()
                .code,
            "document_unavailable"
        );
        assert!(!root.path().join(&created.path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_work_or_create_tree_cycles() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Documents::default();
        fs::write(outside.path().join("keep.md"), "保留").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(root.path(), root.path().join("cycle")).unwrap();
        assert!(store.list(root.path()).unwrap().is_empty());
        assert_eq!(
            store
                .create(root.path(), "outside", "故事")
                .unwrap_err()
                .code,
            "invalid_document_path"
        );
        assert_eq!(
            store.read(root.path(), "outside/keep.md").unwrap_err().code,
            "invalid_document_path"
        );
        assert_eq!(
            store
                .save(root.path(), "outside/keep.md", "覆盖", "保留")
                .unwrap_err()
                .code,
            "invalid_document_path"
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.md")).unwrap(),
            "保留"
        );
    }

    #[cfg(unix)]
    #[test]
    fn saving_preserves_permissions_and_rejects_readonly_files() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        let created = store.create(root.path(), "", "故事").unwrap();
        let path = root.path().join(&created.path);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        store.save(root.path(), &created.path, "正文", "").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        assert_eq!(
            store
                .save(root.path(), &created.path, "覆盖", "正文")
                .unwrap_err()
                .code,
            "document_readonly"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "正文");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
