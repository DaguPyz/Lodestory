use crate::project_index::ProjectError;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileRecord {
    pub path: String,
    pub file_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryListing {
    pub exists: bool,
    pub entries: Vec<ProjectDirectoryEntry>,
    pub issues: Vec<ProjectDirectoryIssue>,
}

/// Serializes generic binary project-file operations in this application process.
/// The filesystem remains the source of truth across app restarts.
#[derive(Default)]
pub struct ProjectFiles {
    access: Mutex<()>,
}

impl ProjectFiles {
    pub fn read(&self, project: &Path, relative: &str) -> Result<ProjectFileRecord, ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let (path, segments) = resolve_file(&root, relative)?;
        let bytes = read_regular_file(&path, "project_file_read_failed", "读取项目文件失败")?;
        Ok(file_record(segments, bytes))
    }

    pub fn create(
        &self,
        project: &Path,
        relative: &str,
        bytes: &[u8],
        create_parents: bool,
        accept_identical: bool,
    ) -> Result<ProjectFileRecord, ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let segments = parse_relative(relative, false)?;
        let (file_name, parent_segments) = segments.split_last().expect("validated nonempty path");
        let parent = ensure_directory(&root, parent_segments, create_parents)?;
        let path = parent.join(file_name);

        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(symlink_error(&path));
                }
                if !metadata.is_file() {
                    return Err(not_file_error(&path));
                }
                if accept_identical {
                    let existing = read_regular_file(
                        &path,
                        "project_file_create_failed",
                        "读取同名项目文件失败",
                    )?;
                    if existing == bytes {
                        return Ok(file_record(segments, existing));
                    }
                }
                return Err(ProjectError::new(
                    "project_file_exists",
                    format!("项目文件已存在，未覆盖：{}。", relative),
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(failure(
                    "project_file_create_failed",
                    "检查项目文件失败",
                    &path,
                    error,
                ));
            }
        }

        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if accept_identical {
                    let existing = read_regular_file(
                        &path,
                        "project_file_create_failed",
                        "读取同名项目文件失败",
                    )?;
                    if existing == bytes {
                        return Ok(file_record(segments, existing));
                    }
                }
                return Err(ProjectError::new(
                    "project_file_exists",
                    format!("项目文件已存在，未覆盖：{}。", relative),
                ));
            }
            Err(error) => {
                return Err(failure(
                    "project_file_create_failed",
                    "创建项目文件失败",
                    &path,
                    error,
                ))
            }
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(failure(
                "project_file_create_failed",
                "保存新项目文件失败",
                &path,
                error,
            ));
        }
        Ok(file_record(segments, bytes.to_vec()))
    }

    pub fn save(
        &self,
        project: &Path,
        relative: &str,
        bytes: &[u8],
        expected_bytes: &[u8],
    ) -> Result<(), ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let (path, segments) = resolve_file(&root, relative)?;
        let current =
            read_regular_file(&path, "project_file_read_failed", "读取待保存项目文件失败")?;
        if current != expected_bytes {
            return Err(ProjectError::new(
                "project_file_changed",
                format!(
                    "项目文件 {} 的字节内容已变化，未覆盖磁盘文件。",
                    segments.join("/")
                ),
            ));
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            failure(
                "project_file_save_failed",
                "读取项目文件权限失败",
                &path,
                error,
            )
        })?;
        let permissions = metadata.permissions();
        if permissions.readonly() {
            return Err(ProjectError::new(
                "project_file_readonly",
                format!("项目文件 {} 为只读状态，无法保存。", segments.join("/")),
            ));
        }

        let mut temporary = tempfile::Builder::new()
            .prefix(".lodestory-project-file-")
            .tempfile_in(path.parent().expect("file path has a parent"))
            .map_err(|error| {
                failure(
                    "project_file_save_failed",
                    "创建临时项目文件失败",
                    &path,
                    error,
                )
            })?;
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| {
                failure(
                    "project_file_save_failed",
                    "保留项目文件权限失败",
                    &path,
                    error,
                )
            })?;
        temporary.write_all(bytes).map_err(|error| {
            failure("project_file_save_failed", "写入项目文件失败", &path, error)
        })?;
        temporary.as_file().sync_all().map_err(|error| {
            failure("project_file_save_failed", "同步项目文件失败", &path, error)
        })?;
        temporary.persist(&path).map_err(|error| {
            failure(
                "project_file_save_failed",
                "原子替换项目文件失败",
                &path,
                error.error,
            )
        })?;
        Ok(())
    }

    pub fn delete(
        &self,
        project: &Path,
        relative: &str,
        expected_bytes: &[u8],
    ) -> Result<(), ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let (path, segments) = resolve_file(&root, relative)?;
        let current =
            read_regular_file(&path, "project_file_read_failed", "读取待删除项目文件失败")?;
        if current != expected_bytes {
            return Err(ProjectError::new(
                "project_file_changed",
                format!(
                    "项目文件 {} 的字节内容已变化，未删除磁盘文件。",
                    segments.join("/")
                ),
            ));
        }
        fs::remove_file(&path).map_err(|error| {
            failure(
                "project_file_delete_failed",
                "删除项目文件失败",
                &path,
                error,
            )
        })
    }

    pub fn list_directory(
        &self,
        project: &Path,
        relative: &str,
    ) -> Result<ProjectDirectoryListing, ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let segments = parse_relative(relative, true)?;
        let Some(directory) = resolve_directory_maybe_missing(&root, &segments)? else {
            return Ok(ProjectDirectoryListing {
                exists: false,
                entries: Vec::new(),
                issues: Vec::new(),
            });
        };
        let directory_listing = fs::read_dir(&directory).map_err(|error| {
            failure(
                "project_directory_list_failed",
                "读取项目目录失败",
                &directory,
                error,
            )
        })?;
        let (entries, issues) = collect_directory_entries(directory_listing, relative, |path| {
            fs::symlink_metadata(path)
        });
        Ok(ProjectDirectoryListing {
            exists: true,
            entries,
            issues,
        })
    }

    pub fn create_directory(
        &self,
        project: &Path,
        relative: &str,
        recursive: bool,
    ) -> Result<(), ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let segments = parse_relative(relative, false)?;
        let (name, parents) = segments.split_last().expect("validated nonempty path");
        let parent = ensure_directory(&root, parents, recursive)?;
        let path = parent.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(symlink_error(&path)),
            Ok(metadata) if metadata.is_dir() && recursive => Ok(()),
            Ok(metadata) if metadata.is_dir() => Err(ProjectError::new(
                "project_directory_exists",
                format!("项目目录已存在：{}。", relative),
            )),
            Ok(_) => Err(ProjectError::new(
                "project_directory_exists",
                format!("同名项目文件或非目录项已存在：{}。", relative),
            )),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&path).map_err(|error| {
                    failure(
                        "project_directory_create_failed",
                        "创建项目目录失败",
                        &path,
                        error,
                    )
                })
            }
            Err(error) => Err(failure(
                "project_directory_create_failed",
                "检查项目目录失败",
                &path,
                error,
            )),
        }
    }

    pub fn rename_path(
        &self,
        project: &Path,
        from_relative: &str,
        to_relative: &str,
    ) -> Result<(), ProjectError> {
        let _guard = self.lock()?;
        let root = project_root(project)?;
        let from_segments = parse_relative(from_relative, false)?;
        let to_segments = parse_relative(to_relative, false)?;
        let from = from_segments.join("/");
        let to = to_segments.join("/");
        if from == to {
            return Ok(());
        }
        if to.starts_with(&format!("{from}/")) {
            return Err(ProjectError::new(
                "invalid_project_file_path",
                "不能将目录重命名到自身内部。",
            ));
        }

        let (source_name, source_parents) =
            from_segments.split_last().expect("validated nonempty path");
        let source_parent = ensure_directory(&root, source_parents, false)?;
        let source = source_parent.join(source_name);
        let source_metadata = fs::symlink_metadata(&source).map_err(|error| {
            failure(
                "project_path_rename_failed",
                "无法访问待重命名路径",
                &source,
                error,
            )
        })?;
        if source_metadata.file_type().is_symlink() {
            return Err(symlink_error(&source));
        }
        if !source_metadata.is_file() && !source_metadata.is_dir() {
            return Err(ProjectError::new(
                "invalid_project_file_path",
                format!("只支持重命名普通文件或文件夹：{}。", from),
            ));
        }

        let (target_name, target_parents) =
            to_segments.split_last().expect("validated nonempty path");
        let target_parent = ensure_directory(&root, target_parents, false)?;
        let target = target_parent.join(target_name);
        match fs::symlink_metadata(&target) {
            Ok(_)
                if case_only_alias(&source, &target, &source_parent, source_name, target_name)? =>
            {
                return rename_case_only(&source, &target);
            }
            Ok(_) => {
                return Err(ProjectError::new(
                    "project_path_exists",
                    format!("目标位置已存在，未覆盖：{}。", to),
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(failure(
                    "project_path_rename_failed",
                    "检查重命名目标失败",
                    &target,
                    error,
                ));
            }
        }
        rename_without_replacement(&source, &target).map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                ProjectError::new(
                    "project_path_exists",
                    format!("目标位置已存在，未覆盖：{}。", to),
                )
            } else {
                failure(
                    "project_path_rename_failed",
                    "重命名项目路径失败",
                    &source,
                    error,
                )
            }
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ProjectError> {
        self.access.lock().map_err(|_| {
            ProjectError::new(
                "project_file_busy",
                "项目文件暂时无法访问，请重新启动应用。",
            )
        })
    }
}

fn case_only_alias(
    source: &Path,
    target: &Path,
    source_parent: &Path,
    source_name: &str,
    target_name: &str,
) -> Result<bool, ProjectError> {
    if target.parent() != Some(source_parent)
        || source_name == target_name
        || !source_name.eq_ignore_ascii_case(target_name)
        || !same_file::is_same_file(source, target).unwrap_or(false)
    {
        return Ok(false);
    }
    is_case_insensitive_directory(source_parent).map_err(|error| {
        failure(
            "project_path_rename_failed",
            "检查文件系统大小写规则失败",
            source_parent,
            error,
        )
    })
}

fn is_case_insensitive_directory(parent: &Path) -> std::io::Result<bool> {
    let probe = tempfile::Builder::new()
        .prefix(".lodestory-case-probe-")
        .tempfile_in(parent)?;
    let name = probe
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            std::io::Error::new(ErrorKind::InvalidData, "temporary name is not UTF-8")
        })?;
    let case_variant = parent.join(name.to_ascii_uppercase());
    Ok(fs::symlink_metadata(case_variant).is_ok())
}

fn rename_case_only(source: &Path, target: &Path) -> Result<(), ProjectError> {
    let parent = source.parent().expect("source has a parent");
    let staging = tempfile::Builder::new()
        .prefix(".lodestory-rename-stage-")
        .tempfile_in(parent)
        .map_err(|error| {
            failure(
                "project_path_rename_failed",
                "创建大小写重命名暂存路径失败",
                source,
                error,
            )
        })?;
    let staging_path = staging.path().to_path_buf();
    drop(staging);

    rename_without_replacement(source, &staging_path).map_err(|error| {
        failure(
            "project_path_rename_failed",
            "移动大小写重命名暂存文件失败",
            source,
            error,
        )
    })?;

    match rename_without_replacement(&staging_path, target) {
        Ok(()) => Ok(()),
        Err(error) => match rename_without_replacement(&staging_path, source) {
            Ok(()) if error.kind() == ErrorKind::AlreadyExists => Err(ProjectError::new(
                "project_path_exists",
                format!("目标位置已存在，未覆盖：{}。", target.display()),
            )),
            Ok(()) => Err(failure(
                "project_path_rename_failed",
                "大小写重命名失败，原文件名已恢复",
                source,
                error,
            )),
            Err(rollback) => Err(ProjectError::new(
                "project_path_rename_rollback_failed",
                format!(
                    "大小写重命名失败，文件保留在暂存路径 {}；恢复原名也失败：{}。",
                    staging_path.display(),
                    rollback
                ),
            )),
        },
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_without_replacement(source: &Path, target: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        target,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)
}

#[cfg(windows)]
fn rename_without_replacement(source: &Path, target: &Path) -> std::io::Result<()> {
    // std::fs::rename on Windows fails when the destination already exists.
    fs::rename(source, target)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_without_replacement(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        ErrorKind::Unsupported,
        "原子无覆盖重命名在此平台不可用。",
    ))
}

fn collect_directory_entries(
    directory_listing: fs::ReadDir,
    relative: &str,
    mut metadata_for: impl FnMut(&Path) -> std::io::Result<fs::Metadata>,
) -> (Vec<ProjectDirectoryEntry>, Vec<ProjectDirectoryIssue>) {
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    for item in directory_listing {
        let entry = match item {
            Ok(entry) => entry,
            Err(error) => {
                issues.push(ProjectDirectoryIssue {
                    path: relative.to_owned(),
                    message: format!("读取目录项失败：{error}"),
                });
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_path = join_relative(relative, &name);
        match metadata_for(&entry.path()) {
            Ok(metadata) => {
                let kind = if metadata.file_type().is_symlink() {
                    "symlink"
                } else if metadata.is_file() {
                    "file"
                } else if metadata.is_dir() {
                    "directory"
                } else {
                    "other"
                };
                entries.push(ProjectDirectoryEntry {
                    path: child_path,
                    name,
                    kind: kind.to_owned(),
                    size: metadata.is_file().then_some(metadata.len()),
                });
            }
            Err(error) => issues.push(ProjectDirectoryIssue {
                path: child_path,
                message: format!("读取目录项元数据失败：{error}"),
            }),
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    issues.sort_by(|left, right| left.path.cmp(&right.path));
    (entries, issues)
}

fn file_record(segments: Vec<&str>, bytes: Vec<u8>) -> ProjectFileRecord {
    let path = segments.join("/");
    let file_name = segments
        .last()
        .expect("validated nonempty path")
        .to_string();
    ProjectFileRecord {
        path,
        file_name,
        bytes,
    }
}

fn project_root(project: &Path) -> Result<PathBuf, ProjectError> {
    if !project.is_absolute() {
        return Err(ProjectError::new(
            "invalid_path",
            "作品目录必须使用绝对路径。",
        ));
    }
    let root = dunce::canonicalize(project)
        .map_err(|error| failure("project_unavailable", "无法访问作品目录", project, error))?;
    fs::read_dir(&root)
        .map_err(|error| failure("project_unavailable", "无法读取作品目录", &root, error))?;
    Ok(root)
}

fn parse_relative(relative: &str, allow_empty: bool) -> Result<Vec<&str>, ProjectError> {
    if relative.is_empty() && allow_empty {
        return Ok(Vec::new());
    }
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.ends_with('/')
        || relative.contains('\\')
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return Err(invalid_path());
    }
    let segments: Vec<_> = relative.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(invalid_path());
    }
    Ok(segments)
}

fn resolve_directory_maybe_missing(
    root: &Path,
    segments: &[&str],
) -> Result<Option<PathBuf>, ProjectError> {
    let mut current = root.to_path_buf();
    for segment in segments {
        current.push(segment);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(failure(
                    "project_directory_list_failed",
                    "检查项目目录失败",
                    &current,
                    error,
                ))
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(symlink_error(&current));
        }
        if !metadata.is_dir() {
            return Err(ProjectError::new(
                "invalid_project_file_path",
                format!("路径必须是目录：{}", current.display()),
            ));
        }
    }
    Ok(Some(current))
}

fn ensure_directory(
    root: &Path,
    segments: &[&str],
    create_missing: bool,
) -> Result<PathBuf, ProjectError> {
    let mut current = root.to_path_buf();
    for segment in segments {
        current.push(segment);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound && create_missing => {
                match fs::create_dir(&current) {
                    Ok(()) => fs::symlink_metadata(&current).map_err(|error| {
                        failure(
                            "project_directory_create_failed",
                            "检查新建项目目录失败",
                            &current,
                            error,
                        )
                    })?,
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                        fs::symlink_metadata(&current).map_err(|error| {
                            failure(
                                "project_directory_create_failed",
                                "检查项目目录失败",
                                &current,
                                error,
                            )
                        })?
                    }
                    Err(error) => {
                        return Err(failure(
                            "project_directory_create_failed",
                            "创建父目录失败",
                            &current,
                            error,
                        ))
                    }
                }
            }
            Err(error) => {
                return Err(failure(
                    "project_file_path_unavailable",
                    "无法访问项目目录",
                    &current,
                    error,
                ))
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(symlink_error(&current));
        }
        if !metadata.is_dir() {
            return Err(ProjectError::new(
                "invalid_project_file_path",
                format!("路径必须是目录：{}", current.display()),
            ));
        }
    }
    Ok(current)
}

fn resolve_file<'a>(
    root: &Path,
    relative: &'a str,
) -> Result<(PathBuf, Vec<&'a str>), ProjectError> {
    let segments = parse_relative(relative, false)?;
    let (file_name, parents) = segments.split_last().expect("validated nonempty path");
    let parent = ensure_directory(root, parents, false)?;
    let path = parent.join(file_name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        failure(
            "project_file_path_unavailable",
            "无法访问项目文件",
            &path,
            error,
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(symlink_error(&path));
    }
    if !metadata.is_file() {
        return Err(not_file_error(&path));
    }
    Ok((path, segments))
}

fn read_regular_file(
    path: &Path,
    code: &'static str,
    action: &str,
) -> Result<Vec<u8>, ProjectError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| failure(code, action, path, error))?;
    if metadata.file_type().is_symlink() {
        return Err(symlink_error(path));
    }
    if !metadata.is_file() {
        return Err(not_file_error(path));
    }
    fs::read(path).map_err(|error| failure(code, action, path, error))
}

fn invalid_path() -> ProjectError {
    ProjectError::new(
        "invalid_project_file_path",
        "项目文件路径必须是项目内相对路径，使用正斜杠且不含空段、点路径、反斜杠、冒号或控制字符。",
    )
}

fn symlink_error(path: &Path) -> ProjectError {
    ProjectError::new(
        "invalid_project_file_path",
        format!("项目路径不能经过符号链接：{}", path.display()),
    )
}

fn not_file_error(path: &Path) -> ProjectError {
    ProjectError::new(
        "invalid_project_file_path",
        format!("路径必须是普通文件：{}", path.display()),
    )
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn failure(code: &'static str, action: &str, path: &Path, error: std::io::Error) -> ProjectError {
    ProjectError::new(code, format!("{action}（{}）：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn binary_files_round_trip_create_save_delete_and_restart() {
        let project = tempdir().unwrap();
        let bytes = vec![0, 0xff, 0xc3, 0x28, 0, 42];
        let first = ProjectFiles::default();
        let created = first
            .create(project.path(), "data/archive.bin", &bytes, true, false)
            .unwrap();
        assert_eq!(created.path, "data/archive.bin");
        assert_eq!(created.file_name, "archive.bin");
        assert_eq!(created.bytes, bytes);

        let restarted = ProjectFiles::default();
        assert_eq!(
            restarted.read(project.path(), &created.path).unwrap().bytes,
            bytes
        );
        let updated = [0xfe, 0, 1, 2, 0xff];
        restarted
            .save(project.path(), &created.path, &updated, &bytes)
            .unwrap();
        assert_eq!(
            restarted.read(project.path(), &created.path).unwrap().bytes,
            updated
        );
        restarted
            .delete(project.path(), &created.path, &updated)
            .unwrap();
        assert!(!project.path().join(&created.path).exists());
    }

    #[test]
    fn hidden_names_and_all_file_types_are_listed_without_format_filtering() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(
                project.path(),
                ".lodestory/outline/timelines/item.json",
                &[0, 255],
                true,
                false,
            )
            .unwrap();
        store
            .create(project.path(), ".cache/state.bin", b"bytes", true, false)
            .unwrap();
        store
            .create(project.path(), "ordinary.txt", b"text", false, false)
            .unwrap();

        let listing = store.list_directory(project.path(), "").unwrap();
        assert!(listing.exists);
        assert!(listing.issues.is_empty());
        assert_eq!(listing.entries.len(), 3);
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == ".lodestory" && entry.kind == "directory"));
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == ".cache" && entry.kind == "directory"));
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == "ordinary.txt" && entry.kind == "file"));
        assert_eq!(
            store
                .read(project.path(), ".lodestory/outline/timelines/item.json")
                .unwrap()
                .bytes,
            [0, 255]
        );
        let hidden_listing = store
            .list_directory(project.path(), ".lodestory/outline/timelines")
            .unwrap();
        assert!(hidden_listing.entries.iter().any(|entry| {
            entry.path == ".lodestory/outline/timelines/item.json" && entry.kind == "file"
        }));
    }

    #[test]
    fn create_never_overwrites_and_identical_retry_is_opt_in() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(project.path(), "one.json", b"same", false, false)
            .unwrap();
        assert_eq!(
            store
                .create(project.path(), "one.json", b"same", false, true)
                .unwrap()
                .bytes,
            b"same"
        );
        assert_eq!(
            store
                .create(project.path(), "one.json", b"different", false, true)
                .unwrap_err()
                .code,
            "project_file_exists"
        );
        assert_eq!(fs::read(project.path().join("one.json")).unwrap(), b"same");
    }

    #[test]
    fn list_missing_directory_is_empty_and_non_directory_is_an_error() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        let missing = store
            .list_directory(project.path(), "missing/child")
            .unwrap();
        assert!(!missing.exists);
        assert!(missing.entries.is_empty());
        assert!(missing.issues.is_empty());
        assert!(!project.path().join("missing").exists());
        store
            .create(project.path(), "file", b"x", false, false)
            .unwrap();
        assert_eq!(
            store
                .list_directory(project.path(), "file")
                .unwrap_err()
                .code,
            "invalid_project_file_path"
        );
    }

    #[test]
    fn listing_records_one_metadata_issue_and_keeps_other_entries() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(project.path(), "broken", b"x", false, false)
            .unwrap();
        store
            .create(project.path(), "valid", b"y", false, false)
            .unwrap();
        let listing = fs::read_dir(project.path()).unwrap();

        let (entries, issues) = collect_directory_entries(listing, "", |path| {
            if path.file_name().is_some_and(|name| name == "broken") {
                Err(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "test metadata failure",
                ))
            } else {
                fs::symlink_metadata(path)
            }
        });

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "valid");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "broken");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_directory_is_an_error_when_the_os_enforces_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let project = tempdir().unwrap();
        let directory = project.path().join("private");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o000)).unwrap();
        let os_denies_read = fs::read_dir(&directory).is_err();
        let result = ProjectFiles::default().list_directory(project.path(), "private");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();

        if os_denies_read {
            assert_eq!(result.unwrap_err().code, "project_directory_list_failed");
        } else {
            assert!(result.unwrap().exists);
        }
    }

    #[cfg(unix)]
    #[test]
    fn save_preserves_permissions_and_compare_delete_conflicts_leave_bytes_untouched() {
        use std::os::unix::fs::PermissionsExt;
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(project.path(), "draft", &[0, 255], false, false)
            .unwrap();
        let path = project.path().join("draft");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        store
            .save(project.path(), "draft", &[1, 2, 0], &[0, 255])
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::write(&path, [8, 9]).unwrap();
        assert_eq!(
            store
                .save(project.path(), "draft", &[3], &[1, 2, 0])
                .unwrap_err()
                .code,
            "project_file_changed"
        );
        assert_eq!(
            store
                .delete(project.path(), "draft", &[1, 2, 0])
                .unwrap_err()
                .code,
            "project_file_changed"
        );
        assert_eq!(fs::read(&path).unwrap(), [8, 9]);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        assert_eq!(
            store
                .save(project.path(), "draft", &[3], &[8, 9])
                .unwrap_err()
                .code,
            "project_file_readonly"
        );
        assert_eq!(fs::read(&path).unwrap(), [8, 9]);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn path_validation_and_file_operations_reject_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let project = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let store = ProjectFiles::default();
        for invalid in [
            "",
            ".",
            "..",
            "../outside",
            "a//b",
            "a/./b",
            "a/../b",
            "a\\b",
            "a:b",
        ] {
            assert_eq!(
                store
                    .create(project.path(), invalid, b"x", true, false)
                    .unwrap_err()
                    .code,
                "invalid_project_file_path"
            );
        }

        symlink(outside.path(), project.path().join("alias")).unwrap();
        let root_listing = store.list_directory(project.path(), "").unwrap();
        assert!(root_listing
            .entries
            .iter()
            .any(|entry| entry.path == "alias" && entry.kind == "symlink"));
        assert_eq!(
            store
                .create(project.path(), "alias/new.bin", b"x", true, false)
                .unwrap_err()
                .code,
            "invalid_project_file_path"
        );
        assert_eq!(
            store
                .list_directory(project.path(), "alias")
                .unwrap_err()
                .code,
            "invalid_project_file_path"
        );
        fs::write(outside.path().join("target"), [4, 5]).unwrap();
        symlink(outside.path().join("target"), project.path().join("link")).unwrap();
        for result in [
            store.read(project.path(), "link").unwrap_err(),
            store
                .save(project.path(), "link", b"bad", &[4, 5])
                .unwrap_err(),
            store.delete(project.path(), "link", &[4, 5]).unwrap_err(),
            store
                .create(project.path(), "link", &[4, 5], false, true)
                .unwrap_err(),
        ] {
            assert_eq!(result.code, "invalid_project_file_path");
        }
        assert_eq!(fs::read(outside.path().join("target")).unwrap(), [4, 5]);
    }

    #[test]
    fn recursive_directory_creation_is_explicit_and_idempotent_only_for_directories() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        assert!(store
            .create_directory(project.path(), "a/b", false)
            .is_err());
        store.create_directory(project.path(), "a/b", true).unwrap();
        store.create_directory(project.path(), "a/b", true).unwrap();
        assert_eq!(
            store
                .create_directory(project.path(), "a/b", false)
                .unwrap_err()
                .code,
            "project_directory_exists"
        );
        store
            .create(project.path(), "occupied", b"x", false, false)
            .unwrap();
        assert_eq!(
            store
                .create_directory(project.path(), "occupied", true)
                .unwrap_err()
                .code,
            "project_directory_exists"
        );
    }

    #[test]
    fn rename_moves_files_and_directories_without_replacing_existing_paths() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(
                project.path(),
                "drafts/chapter.txt",
                b"chapter",
                true,
                false,
            )
            .unwrap();
        store
            .create(project.path(), "drafts/notes/idea.md", b"idea", true, false)
            .unwrap();

        store
            .rename_path(project.path(), "drafts/chapter.txt", "chapter.md")
            .unwrap();
        assert_eq!(
            fs::read(project.path().join("chapter.md")).unwrap(),
            b"chapter"
        );
        assert!(!project.path().join("drafts/chapter.txt").exists());

        store
            .rename_path(project.path(), "drafts", "archive")
            .unwrap();
        assert_eq!(
            fs::read(project.path().join("archive/notes/idea.md")).unwrap(),
            b"idea"
        );
        assert!(!project.path().join("drafts").exists());

        fs::write(project.path().join("occupied.txt"), b"keep me").unwrap();
        assert_eq!(
            store
                .rename_path(project.path(), "chapter.md", "occupied.txt")
                .unwrap_err()
                .code,
            "project_path_exists"
        );
        assert_eq!(
            fs::read(project.path().join("occupied.txt")).unwrap(),
            b"keep me"
        );
        assert_eq!(
            fs::read(project.path().join("chapter.md")).unwrap(),
            b"chapter"
        );
        assert_eq!(
            store
                .rename_path(project.path(), "archive", "archive/inside")
                .unwrap_err()
                .code,
            "invalid_project_file_path"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rename_rejects_symlinks_and_missing_paths() {
        use std::os::unix::fs::symlink;
        let project = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let store = ProjectFiles::default();
        fs::write(outside.path().join("secret.txt"), b"private").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            project.path().join("alias.txt"),
        )
        .unwrap();

        assert_eq!(
            store
                .rename_path(project.path(), "alias.txt", "moved.txt")
                .unwrap_err()
                .code,
            "invalid_project_file_path"
        );
        assert_eq!(
            store
                .rename_path(project.path(), "missing.txt", "moved.txt")
                .unwrap_err()
                .code,
            "project_path_rename_failed"
        );
        assert_eq!(
            fs::read(outside.path().join("secret.txt")).unwrap(),
            b"private"
        );
    }

    #[test]
    fn rename_supports_case_only_changes_without_creating_another_entry() {
        let project = tempdir().unwrap();
        let store = ProjectFiles::default();
        store
            .create(project.path(), "draft.txt", b"draft", false, false)
            .unwrap();
        store
            .create(project.path(), "folder/item.txt", b"item", true, false)
            .unwrap();

        store
            .rename_path(project.path(), "draft.txt", "Draft.txt")
            .unwrap();
        store
            .rename_path(project.path(), "folder", "Folder")
            .unwrap();

        assert_eq!(
            fs::read(project.path().join("Draft.txt")).unwrap(),
            b"draft"
        );
        assert_eq!(
            fs::read(project.path().join("Folder/item.txt")).unwrap(),
            b"item"
        );
        let entries = fs::read_dir(project.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(entries.contains(&"Draft.txt".to_owned()));
        assert!(entries.contains(&"Folder".to_owned()));
        assert_eq!(
            entries.len(),
            2,
            "case-only changes leave no staging artifacts"
        );
    }
}
