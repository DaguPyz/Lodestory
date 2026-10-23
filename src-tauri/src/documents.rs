use crate::project_index::ProjectError;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

#[derive(Default)]
pub struct Documents;

impl Documents {
    pub fn list(&self, project: &Path) -> Result<Vec<TreeEntry>, ProjectError> {
        let root = project_root(project)?;
        directory_entries(&root, &root)
    }
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

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap()
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn supported_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt" | "lode"
            )
        })
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
    fn listing_filters_hidden_and_unsupported_entries_and_sorts_folders_first() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        for name in [
            "a.md",
            "b.TXT",
            "c.markdown",
            "d.lode",
            "image.png",
            ".hidden.md",
        ] {
            fs::write(root.path().join(name), "").unwrap();
        }
        fs::create_dir(root.path().join("正文")).unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();

        let tree = store.list(root.path()).unwrap();

        assert_eq!(
            tree.iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["正文", "a.md", "b.TXT", "c.markdown", "d.lode"]
        );
    }

    #[test]
    fn listing_recurses_into_directories_and_sorts_each_level() {
        let root = tempfile::tempdir().unwrap();
        let store = Documents::default();
        fs::create_dir(root.path().join("章节乙")).unwrap();
        fs::create_dir(root.path().join("章节甲")).unwrap();
        fs::write(root.path().join("章节甲/第二章.md"), "").unwrap();
        fs::write(root.path().join("章节甲/第一章.txt"), "").unwrap();
        fs::write(root.path().join("章节甲/忽略.json"), "").unwrap();

        let tree = store.list(root.path()).unwrap();

        assert_eq!(tree[0].name, "章节乙");
        assert_eq!(tree[1].name, "章节甲");
        assert_eq!(tree[1].path, "章节甲");
        assert_eq!(
            tree[1]
                .children
                .as_ref()
                .unwrap()
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["第一章.txt", "第二章.md"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_symlinks_without_following_targets_or_cycles() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Documents::default();
        fs::write(outside.path().join("keep.md"), "保留").unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/visible.md"), "").unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        symlink(root.path(), root.path().join("cycle")).unwrap();
        symlink(
            outside.path().join("keep.md"),
            root.path().join("linked.md"),
        )
        .unwrap();

        let tree = store.list(root.path()).unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "safe");
        assert_eq!(
            tree[0].children.as_ref().unwrap()[0].path,
            "safe/visible.md"
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.md")).unwrap(),
            "保留"
        );
    }
}
