use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use uuid::Uuid;

pub const INDEX_FILENAME: &str = "recent-projects.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRecord {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub last_opened_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RecentProject {
    #[serde(flatten)]
    pub project: ProjectRecord,
    pub available: bool,
}

#[derive(Debug, Serialize)]
pub struct OpenedProject {
    pub project: ProjectRecord,
    pub projects: Vec<RecentProject>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexFile {
    schema_version: u32,
    projects: Vec<ProjectRecord>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            projects: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ProjectError {
    pub code: &'static str,
    pub message: String,
}

impl ProjectError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Every command uses this one process-wide lock and re-reads the file before
/// updating it, so concurrent requests cannot overwrite an earlier update.
pub struct ProjectIndex {
    path: PathBuf,
    access: Mutex<()>,
}

impl ProjectIndex {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            access: Mutex::new(()),
        }
    }

    pub fn list(&self) -> Result<Vec<RecentProject>, ProjectError> {
        let _guard = self.lock()?;
        Ok(entries(&self.read()?))
    }

    pub fn open(&self, path: &Path) -> Result<OpenedProject, ProjectError> {
        let _guard = self.lock()?;
        let mut index = self.read()?;
        let directory = canonical_directory(path)?;
        self.register(&mut index, directory, None)
    }

    pub fn create(&self, parent: &Path, name: &str) -> Result<OpenedProject, ProjectError> {
        let _guard = self.lock()?;
        // Read first: a damaged or newer index must not cause filesystem changes.
        let mut index = self.read()?;
        validate_directory_name(name)?;
        let directory = canonical_directory(parent)?.join(name);
        fs::create_dir(&directory).map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                ProjectError::new(
                    "directory_exists",
                    "保存位置已存在同名目录，请换一个项目名称。",
                )
            } else {
                ProjectError::new("create_failed", format!("创建项目目录失败：{error}"))
            }
        })?;
        let result = canonical_directory(&directory)
            .and_then(|directory| self.register(&mut index, directory, None));
        result.map_err(|error| {
            ProjectError::new(
                error.code,
                format!(
                    "{} 项目目录已创建：{}；可通过“打开目录”重试。",
                    error.message,
                    directory.display()
                ),
            )
        })
    }

    pub fn relocate(&self, id: Uuid, path: &Path) -> Result<OpenedProject, ProjectError> {
        let _guard = self.lock()?;
        let mut index = self.read()?;
        if !index.projects.iter().any(|project| project.id == id) {
            return Err(ProjectError::new(
                "project_not_found",
                "项目记录已被移除，请刷新列表。",
            ));
        }
        let directory = canonical_directory(path)?;
        self.register(&mut index, directory, Some(id))
    }

    pub fn remove(&self, id: Uuid) -> Result<Vec<RecentProject>, ProjectError> {
        let _guard = self.lock()?;
        let mut index = self.read()?;
        let previous_count = index.projects.len();
        index.projects.retain(|project| project.id != id);
        if index.projects.len() != previous_count {
            self.save(&index)?;
        }
        Ok(entries(&index))
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, ProjectError> {
        self.access
            .lock()
            .map_err(|_| ProjectError::new("index_busy", "项目索引暂时无法访问，请重新启动应用。"))
    }

    fn read(&self) -> Result<IndexFile, ProjectError> {
        let contents = match fs::read(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(IndexFile::default()),
            Err(error) => {
                return Err(ProjectError::new(
                    "index_read_failed",
                    format!("读取项目索引失败（{}）：{error}", self.path.display()),
                ));
            }
        };
        let invalid = |reason| {
            ProjectError::new(
                "invalid_index",
                format!(
                    "项目索引格式错误，原文件已保留（{}）：{reason}",
                    self.path.display()
                ),
            )
        };
        let value: serde_json::Value =
            serde_json::from_slice(&contents).map_err(|error| invalid(error.to_string()))?;
        match value
            .get("schemaVersion")
            .and_then(|version| version.as_u64())
        {
            Some(version) if version != u64::from(SCHEMA_VERSION) => {
                return Err(ProjectError::new(
                    "unsupported_version",
                    format!(
                        "项目索引版本 {version} 暂不支持，原文件已保留（{}）。",
                        self.path.display()
                    ),
                ));
            }
            _ => {}
        }
        let mut index: IndexFile =
            serde_json::from_value(value).map_err(|error| invalid(error.to_string()))?;
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        for project in &index.projects {
            if project.name.trim().is_empty()
                || !Path::new(&project.path).is_absolute()
                || !ids.insert(project.id)
                || !paths.insert(&project.path)
            {
                return Err(invalid("项目记录存在空名称、非绝对路径或重复记录。".into()));
            }
        }
        sort_projects(&mut index);
        Ok(index)
    }

    fn register(
        &self,
        index: &mut IndexFile,
        directory: PathBuf,
        preferred_id: Option<Uuid>,
    ) -> Result<OpenedProject, ProjectError> {
        let path = directory
            .to_str()
            .ok_or_else(|| {
                ProjectError::new(
                    "unsupported_path",
                    "项目目录路径无法表示为 UTF-8，请选择其他目录。",
                )
            })?
            .to_owned();
        let id = preferred_id
            .or_else(|| {
                index
                    .projects
                    .iter()
                    .find(|project| same_directory(&project.path, &path))
                    .map(|project| project.id)
            })
            .unwrap_or_else(Uuid::new_v4);
        let name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_owned();
        let project = ProjectRecord {
            id,
            name,
            path,
            last_opened_at: Utc::now(),
        };
        // Relocating to an already indexed directory merges the records and
        // preserves the ID of the project being relocated.
        index
            .projects
            .retain(|item| item.id != id && !same_directory(&item.path, &project.path));
        index.projects.push(project.clone());
        sort_projects(index);
        self.save(index)?;
        Ok(OpenedProject {
            project,
            projects: entries(index),
        })
    }

    fn save(&self, index: &IndexFile) -> Result<(), ProjectError> {
        let failed = |reason| {
            ProjectError::new(
                "index_write_failed",
                format!("保存项目索引失败（{}）：{reason}", self.path.display()),
            )
        };
        let parent = self
            .path
            .parent()
            .ok_or_else(|| failed("存储目录无效。".into()))?;
        fs::create_dir_all(parent).map_err(|error| failed(error.to_string()))?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".recent-projects-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|error| failed(error.to_string()))?;
        serde_json::to_writer_pretty(&mut temporary, index)
            .map_err(|error| failed(error.to_string()))?;
        temporary
            .write_all(b"\n")
            .map_err(|error| failed(error.to_string()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| failed(error.to_string()))?;
        // NamedTempFile::persist atomically replaces the destination on desktop
        // platforms. A failed write leaves the previous index intact.
        temporary
            .persist(&self.path)
            .map_err(|error| failed(error.error.to_string()))?;
        Ok(())
    }
}

fn sort_projects(index: &mut IndexFile) {
    index.projects.sort_by(|left, right| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn entries(index: &IndexFile) -> Vec<RecentProject> {
    index
        .projects
        .iter()
        .map(|project| RecentProject {
            project: project.clone(),
            available: fs::read_dir(&project.path).is_ok(),
        })
        .collect()
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ProjectError> {
    if !path.is_absolute() {
        return Err(ProjectError::new(
            "invalid_path",
            "请选择绝对路径对应的目录。",
        ));
    }
    let unavailable = |error| {
        ProjectError::new(
            "project_unavailable",
            format!("无法访问目录 {}：{error}", path.display()),
        )
    };
    let directory = dunce::canonicalize(path).map_err(unavailable)?;
    // Checks both directory type and the ability to read it before registering.
    fs::read_dir(&directory).map_err(unavailable)?;
    Ok(directory)
}

fn same_directory(left: &str, right: &str) -> bool {
    left == right || same_file::is_same_file(left, right).unwrap_or(false)
}

pub(crate) fn validate_directory_name(name: &str) -> Result<(), ProjectError> {
    if name.len() > 255 {
        return Err(ProjectError::new(
            "invalid_name",
            "项目名称过长，请缩短名称。",
        ));
    }
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty()
        || name.trim() != name
        || matches!(name, "." | "..")
        || name.ends_with('.')
        || reserved
        || name
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err(ProjectError::new(
            "invalid_name",
            "项目名称不能包含路径分隔符、特殊字符、首尾空格或系统保留名称。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread};

    fn fixture() -> (tempfile::TempDir, ProjectIndex) {
        let root = tempfile::tempdir().unwrap();
        let index = ProjectIndex::new(root.path().join("config").join(INDEX_FILENAME));
        (root, index)
    }

    #[test]
    fn missing_index_is_empty_without_creating_a_file() {
        let (_root, index) = fixture();
        assert!(index.list().unwrap().is_empty());
        assert!(!index.path.exists());
    }

    #[test]
    fn creation_persists_the_agreed_schema_and_reloads() {
        let (root, index) = fixture();
        let opened = index.create(root.path(), "长夜行舟").unwrap();
        assert_eq!(opened.project.name, "长夜行舟");
        assert!(Path::new(&opened.project.path).is_absolute());
        assert!(Path::new(&opened.project.path).is_dir());
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&index.path).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], 1);
        let record = saved["projects"][0].as_object().unwrap();
        assert_eq!(record.len(), 4);
        assert!(record["lastOpenedAt"].as_str().unwrap().ends_with('Z'));
        let reloaded = ProjectIndex::new(index.path.clone()).list().unwrap();
        assert_eq!(reloaded[0].project.id, opened.project.id);
        assert!(reloaded[0].available);
    }

    #[test]
    fn repeated_and_normalized_opens_keep_one_record_and_the_same_id() {
        let (root, index) = fixture();
        let first = index.create(root.path(), "故事").unwrap();
        let repeated = index.open(&root.path().join("故事").join(".")).unwrap();
        assert_eq!(repeated.projects.len(), 1);
        assert_eq!(first.project.id, repeated.project.id);
        assert!(repeated.project.last_opened_at >= first.project.last_opened_at);
    }

    #[test]
    fn case_variants_on_case_insensitive_filesystems_keep_one_record() {
        let (root, index) = fixture();
        let first = index.create(root.path(), "Story").unwrap();
        let alternate = root.path().join("story");
        if !alternate.exists() {
            return;
        }
        let repeated = index.open(&alternate).unwrap();
        assert_eq!(first.project.id, repeated.project.id);
        assert_eq!(repeated.projects.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_do_not_create_duplicate_projects() {
        let (root, index) = fixture();
        let first = index.create(root.path(), "故事").unwrap();
        let alias = root.path().join("alias");
        std::os::unix::fs::symlink(&first.project.path, &alias).unwrap();
        let repeated = index.open(&alias).unwrap();
        assert_eq!(repeated.project.id, first.project.id);
        assert_eq!(repeated.projects.len(), 1);
    }

    #[test]
    fn most_recently_opened_project_is_first() {
        let (root, index) = fixture();
        let first = index.create(root.path(), "first").unwrap();
        let second = index.create(root.path(), "second").unwrap();
        assert_eq!(second.projects[0].project.id, second.project.id);
        let reopened = index.open(Path::new(&first.project.path)).unwrap();
        assert_eq!(reopened.projects[0].project.id, first.project.id);
    }

    #[test]
    fn removing_a_record_keeps_the_project_and_its_contents() {
        let (root, index) = fixture();
        let opened = index.create(root.path(), "故事").unwrap();
        let manuscript = Path::new(&opened.project.path).join("第一章.md");
        fs::write(&manuscript, "正文").unwrap();
        assert!(index.remove(opened.project.id).unwrap().is_empty());
        assert_eq!(fs::read_to_string(manuscript).unwrap(), "正文");
        assert!(ProjectIndex::new(index.path.clone())
            .list()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn missing_directories_stay_indexed_and_can_be_relocated() {
        let (root, index) = fixture();
        let opened = index.create(root.path(), "旧目录").unwrap();
        let new_path = root.path().join("新目录");
        fs::rename(&opened.project.path, &new_path).unwrap();
        let before = fs::read(&index.path).unwrap();
        assert!(!index.list().unwrap()[0].available);
        assert_eq!(
            index
                .open(Path::new(&opened.project.path))
                .unwrap_err()
                .code,
            "project_unavailable"
        );
        assert_eq!(fs::read(&index.path).unwrap(), before);
        let relocated = index.relocate(opened.project.id, &new_path).unwrap();
        assert_eq!(relocated.project.id, opened.project.id);
        assert_eq!(relocated.project.name, "新目录");
        assert!(relocated.projects[0].available);
    }

    #[test]
    fn relocating_to_an_existing_record_merges_by_path() {
        let (root, index) = fixture();
        let first = index.create(root.path(), "first").unwrap();
        let second = index.create(root.path(), "second").unwrap();
        let relocated = index
            .relocate(first.project.id, Path::new(&second.project.path))
            .unwrap();
        assert_eq!(relocated.projects.len(), 1);
        assert_eq!(relocated.project.id, first.project.id);
        assert!(Path::new(&first.project.path).exists());
    }

    #[test]
    fn damaged_and_future_indices_are_preserved_and_block_mutations() {
        for (contents, code) in [
            ("broken", "invalid_index"),
            ("{}", "invalid_index"),
            (
                r#"{"schemaVersion":2,"projects":[]}"#,
                "unsupported_version",
            ),
        ] {
            let (root, index) = fixture();
            fs::create_dir_all(index.path.parent().unwrap()).unwrap();
            fs::write(&index.path, contents).unwrap();
            assert_eq!(index.list().unwrap_err().code, code);
            assert_eq!(index.create(root.path(), "故事").unwrap_err().code, code);
            assert_eq!(index.remove(Uuid::new_v4()).unwrap_err().code, code);
            assert_eq!(fs::read_to_string(&index.path).unwrap(), contents);
            assert!(!root.path().join("故事").exists());
        }
    }

    #[test]
    fn invalid_and_existing_names_do_not_touch_directories_or_index() {
        let (root, index) = fixture();
        for name in [
            "", ".", "..", "../other", "a/b", "a\\b", "CON", "lpt1.txt", "故事.", " 故事", "故事\n",
        ] {
            assert_eq!(
                index.create(root.path(), name).unwrap_err().code,
                "invalid_name"
            );
        }
        assert!(!index.path.exists());
        let opened = index.create(root.path(), "故事").unwrap();
        let before = fs::read(&index.path).unwrap();
        assert_eq!(
            index.create(root.path(), "故事").unwrap_err().code,
            "directory_exists"
        );
        assert_eq!(fs::read(&index.path).unwrap(), before);
        assert!(Path::new(&opened.project.path).is_dir());
    }

    #[test]
    fn failed_atomic_replace_keeps_the_destination_and_cleans_temporary_files() {
        let (_root, index) = fixture();
        fs::create_dir_all(&index.path).unwrap();
        let marker = index.path.join("keep");
        fs::write(&marker, "original").unwrap();
        assert_eq!(
            index.save(&IndexFile::default()).unwrap_err().code,
            "index_write_failed"
        );
        assert_eq!(fs::read_to_string(marker).unwrap(), "original");
        assert_eq!(
            fs::read_dir(index.path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn concurrent_updates_do_not_lose_projects() {
        let (root, index) = fixture();
        let index = Arc::new(index);
        let workers: Vec<_> = (0..8)
            .map(|number| {
                let index = Arc::clone(&index);
                let parent = root.path().to_owned();
                thread::spawn(move || index.create(&parent, &format!("故事{number}")).unwrap())
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(index.list().unwrap().len(), 8);
        assert_eq!(
            ProjectIndex::new(index.path.clone()).list().unwrap().len(),
            8
        );
    }
}
