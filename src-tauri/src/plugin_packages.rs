use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tempfile::{Builder, TempDir};
use zip::ZipArchive;

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_UNPACKED: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_ENTRIES: usize = 4096;
const RECORD: &str = "record.json";
const STAGING_PREFIX: &str = "plugin-stage-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPackage {
    pub id: String,
    pub name: String,
    pub version: String,
    pub status: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    record_version: u32,
    #[serde(flatten)]
    package: ImportedPackage,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    host_api: String,
    react: String,
    capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Deserialize)]
struct Capability {
    id: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    manifest_version: String,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    compatibility: ManifestCompatibility,
    dependencies: Dependencies,
    files: Option<Vec<PackageFile>>,
    frontend: Option<Frontend>,
    backend: Option<Backend>,
}

#[derive(Debug, Deserialize)]
struct PackageFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCompatibility {
    host_api: String,
    react: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Dependencies {
    plugins: Vec<Capability>,
    requires: Vec<Capability>,
    provides: Vec<Capability>,
}
#[derive(Debug, Deserialize)]
struct Frontend {
    entry: String,
    #[serde(default)]
    styles: Vec<String>,
}
#[derive(Debug, Deserialize)]
struct Backend {
    #[serde(rename = "type")]
    kind: String,
    artifacts: Vec<Artifact>,
}
#[derive(Debug, Deserialize)]
struct Artifact {
    os: String,
    arch: String,
    target: String,
    entry: String,
}

pub struct PluginPackages {
    root: PathBuf,
    assets: RwLock<HashMap<String, HashMap<String, (u64, String)>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPackage {
    pub id: String,
    pub frontend: Option<PreparedFrontend>,
    pub backend: Option<PreparedBackend>,
    pub requires: Vec<String>,
    pub provides: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PreparedFrontend {
    pub entry: String,
    pub styles: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PreparedBackend {
    #[serde(rename = "type")]
    pub kind: String,
    pub entry: String,
}

impl PluginPackages {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            assets: RwLock::new(HashMap::new()),
        }
    }

    /// The lock also coordinates multiple Lodestory processes. Staging is only
    /// cleaned while the lock is held, so an active import cannot be removed.
    fn lock(&self) -> Result<File, String> {
        fs::create_dir_all(self.root.join("staging")).map_err(io_error)?;
        fs::create_dir_all(self.root.join("installed")).map_err(io_error)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.root.join(".lock"))
            .map_err(io_error)?;
        file.lock().map_err(io_error)?;
        self.clean_staging()?;
        Ok(file)
    }

    fn clean_staging(&self) -> Result<(), String> {
        for entry in fs::read_dir(self.root.join("staging")).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
                && entry.file_type().map_err(io_error)?.is_dir()
            {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| format!("无法清理未完成的插件导入：{error}"))?;
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ImportedPackage>, String> {
        let _lock = self.lock()?;
        let mut packages = Vec::new();
        for entry in fs::read_dir(self.root.join("installed")).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if !entry.file_type().map_err(io_error)?.is_dir() {
                continue;
            }
            let record: Record = serde_json::from_reader(
                File::open(entry.path().join(RECORD))
                    .map_err(|error| format!("插件记录无法读取：{error}"))?,
            )
            .map_err(|error| format!("插件记录无效：{error}"))?;
            if record.record_version != 1
                || record.package.status != "pending-load"
                || !valid_plugin_id(&record.package.id)
                || entry.file_name().to_string_lossy()
                    != format!("plugin-{}", record.package.id.to_ascii_lowercase())
                || !entry.path().join("package/manifest.json").is_file()
                || !entry.path().join("source.zip").is_file()
            {
                return Err("插件记录或文件不完整，请检查插件目录。".into());
            }
            packages.push(record.package);
        }
        packages.sort_by(|a, b| a.id.to_ascii_lowercase().cmp(&b.id.to_ascii_lowercase()));
        Ok(packages)
    }

    fn record(&self, id: &str) -> Result<(PathBuf, Record), String> {
        if !valid_plugin_id(id) {
            return Err("插件 ID 无效。".into());
        }
        let directory = self
            .root
            .join("installed")
            .join(format!("plugin-{}", id.to_ascii_lowercase()));
        let record: Record =
            serde_json::from_slice(&read_regular(&directory, RECORD, MAX_MANIFEST)?)
                .map_err(|error| format!("插件记录无效：{error}"))?;
        if record.record_version != 1
            || record.package.id != id
            || record.package.status != "pending-load"
        {
            return Err("插件记录无效。".into());
        }
        Ok((directory, record))
    }

    /// Recheck the original archive, manifest and all installed files before executing code.
    pub fn prepare(
        &self,
        id: &str,
        compatibility: &Compatibility,
    ) -> Result<PreparedPackage, String> {
        let _lock = self.lock()?;
        let (directory, record) = self.record(id)?;
        let archive_bytes = read_regular(&directory, "source.zip", MAX_ARCHIVE)?;
        if format!("{:x}", Sha256::digest(&archive_bytes)) != record.sha256 {
            return Err("原始插件包校验失败。".into());
        }
        let mut archive =
            ZipArchive::new(io::Cursor::new(archive_bytes)).map_err(|e| e.to_string())?;
        let mut original_manifest = Vec::new();
        archive
            .by_name("manifest.json")
            .map_err(|e| e.to_string())?
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut original_manifest)
            .map_err(io_error)?;
        if original_manifest.len() as u64 > MAX_MANIFEST {
            return Err("插件清单过大。".into());
        }
        let root = directory.join("package");
        let installed_manifest = read_regular(&root, "manifest.json", MAX_MANIFEST)?;
        if original_manifest != installed_manifest {
            return Err("插件清单已被修改。".into());
        }
        let manifest: Manifest = serde_json::from_slice(&original_manifest)
            .map_err(|error| format!("插件清单无效：{error}"))?;
        if manifest.id != id
            || manifest.name != record.package.name
            || manifest.version != record.package.version
        {
            return Err("插件清单与导入记录不一致。".into());
        }
        let mut files = HashMap::new();
        files.insert(
            "manifest.json".to_owned(),
            (
                installed_manifest.len() as u64,
                format!("{:x}", Sha256::digest(&installed_manifest)),
            ),
        );
        let declared = manifest.files.as_ref().ok_or("插件文件清单缺失。")?;
        if declared.len() > MAX_ENTRIES
            || declared
                .iter()
                .try_fold(installed_manifest.len() as u64, |size, item| {
                    size.checked_add(item.size)
                })
                .filter(|size| *size <= MAX_UNPACKED)
                .is_none()
        {
            return Err("插件文件清单超过大小限制。".into());
        }
        for item in declared {
            let bytes = read_regular(&root, &item.path, item.size)?;
            files.insert(
                item.path.clone(),
                (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes))),
            );
        }
        validate(&manifest, &root, &files, compatibility)?;
        let frontend = manifest.frontend.as_ref().map(|item| PreparedFrontend {
            entry: item.entry.clone(),
            styles: item.styles.clone(),
        });
        let backend = manifest
            .backend
            .as_ref()
            .map(|item| {
                let os = std::env::consts::OS;
                let arch = if std::env::consts::ARCH == "aarch64" {
                    "arm64"
                } else {
                    "x64"
                };
                let artifact = item
                    .artifacts
                    .iter()
                    .find(|a| {
                        a.os == os && a.arch == arch && a.target == env!("LODESTORY_BUILD_TARGET")
                    })
                    .ok_or("插件后端与当前系统或处理器不兼容。")?;
                let entry = root
                    .join(&artifact.entry)
                    .to_str()
                    .ok_or("后端路径无法表示。")?
                    .to_owned();
                Ok::<_, String>(PreparedBackend {
                    kind: item.kind.clone(),
                    entry,
                })
            })
            .transpose()?;
        let backend_files: HashSet<&str> = manifest
            .backend
            .as_ref()
            .into_iter()
            .flat_map(|backend| {
                backend
                    .artifacts
                    .iter()
                    .map(|artifact| artifact.entry.as_str())
            })
            .collect();
        let assets = manifest
            .files
            .as_ref()
            .unwrap()
            .iter()
            .filter(|item| !backend_files.contains(item.path.as_str()))
            .map(|item| (item.path.clone(), (item.size, item.sha256.clone())))
            .collect();
        self.assets
            .write()
            .map_err(|_| "插件资源状态不可用。")?
            .insert(id.to_owned(), assets);
        Ok(PreparedPackage {
            id: id.to_owned(),
            frontend,
            backend,
            requires: manifest
                .dependencies
                .requires
                .iter()
                .map(|item| item.id.clone())
                .collect(),
            provides: manifest
                .dependencies
                .provides
                .iter()
                .map(|item| item.id.clone())
                .collect(),
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let _lock = self.lock()?;
        let (directory, mut record) = self.record(id)?;
        record.package.enabled = enabled;
        let mut file = Builder::new()
            .prefix("record-")
            .tempfile_in(&directory)
            .map_err(io_error)?;
        serde_json::to_writer(&mut file, &record).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(io_error)?;
        file.as_file().sync_all().map_err(io_error)?;
        file.persist(directory.join(RECORD))
            .map_err(|e| format!("保存插件启用状态失败：{}", e.error))?;
        Ok(())
    }

    pub fn release_assets(&self, id: &str) {
        if let Ok(mut assets) = self.assets.write() {
            assets.remove(id);
        }
    }

    /// Only files from a successfully prepared frontend can be served, with integrity checked again.
    pub fn asset(&self, id: &str, path: &str) -> Result<Vec<u8>, String> {
        let assets = self.assets.read().map_err(|_| "插件资源状态不可用。")?;
        let expected = assets
            .get(id)
            .and_then(|files| files.get(path))
            .ok_or("插件资源不存在。")?;
        let root = self
            .root
            .join("installed")
            .join(format!("plugin-{}", id.to_ascii_lowercase()))
            .join("package");
        let bytes = read_regular(&root, path, expected.0)?;
        if bytes.len() as u64 != expected.0 || format!("{:x}", Sha256::digest(&bytes)) != expected.1
        {
            return Err("插件资源校验失败。".into());
        }
        Ok(bytes)
    }

    pub fn import(
        &self,
        source: &Path,
        compatibility: &Compatibility,
    ) -> Result<ImportedPackage, String> {
        let _lock = self.lock()?;
        let stage = Builder::new()
            .prefix(STAGING_PREFIX)
            .tempdir_in(self.root.join("staging"))
            .map_err(io_error)?;
        match self.import_staged(source, compatibility, &stage) {
            Ok(package) => {
                let _ = stage.keep();
                Ok(package)
            }
            Err(error) => match stage.close() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}；临时文件清理失败，稍后会重试：{cleanup}")),
            },
        }
    }

    fn import_staged(
        &self,
        source: &Path,
        compatibility: &Compatibility,
        stage: &TempDir,
    ) -> Result<ImportedPackage, String> {
        let mut input = File::open(source).map_err(|error| format!("无法读取插件包：{error}"))?;
        let metadata = input.metadata().map_err(io_error)?;
        if !metadata.is_file() || metadata.len() > MAX_ARCHIVE {
            return Err("插件包不是有效文件或超过大小限制。".into());
        }
        let archive_path = stage.path().join("source.zip");
        let mut archive_copy = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&archive_path)
            .map_err(io_error)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let n = input.read(&mut buffer).map_err(io_error)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_ARCHIVE {
                return Err("插件包超过大小限制。".into());
            }
            archive_copy.write_all(&buffer[..n]).map_err(io_error)?;
            hasher.update(&buffer[..n]);
        }
        archive_copy.sync_all().map_err(io_error)?;
        drop(archive_copy);
        let sha256 = format!("{:x}", hasher.finalize());
        let package_dir = stage.path().join("package");
        fs::create_dir(&package_dir).map_err(io_error)?;
        let unpacked = unpack(&archive_path, &package_dir)?;
        let manifest_file = File::open(package_dir.join("manifest.json"))
            .map_err(|_| "插件包根目录缺少 manifest.json。".to_owned())?;
        if manifest_file.metadata().map_err(io_error)?.len() > MAX_MANIFEST {
            return Err("插件清单过大。".into());
        }
        let manifest: Manifest = serde_json::from_reader(manifest_file)
            .map_err(|error| format!("插件清单格式无效：{error}"))?;
        validate(&manifest, &package_dir, &unpacked, compatibility)?;
        let package = ImportedPackage {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            status: "pending-load".into(),
            enabled: false,
        };
        let destination = self
            .root
            .join("installed")
            .join(format!("plugin-{}", package.id.to_ascii_lowercase()));
        if destination.exists() {
            return Err(format!("插件 {} 已导入，未覆盖现有文件。", package.id));
        }
        let record = Record {
            record_version: 1,
            package: package.clone(),
            sha256,
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.path().join(RECORD))
            .map_err(io_error)?;
        serde_json::to_writer(&mut file, &record)
            .map_err(|error| format!("无法写入插件记录：{error}"))?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        move_no_replace(stage.path(), &destination).map_err(|error| {
            if destination.exists() {
                format!("插件 {} 已导入，未覆盖现有文件。", package.id)
            } else {
                format!("保存插件包失败：{error}")
            }
        })?;
        Ok(package)
    }
}

fn io_error(error: io::Error) -> String {
    format!("插件文件操作失败：{error}")
}

fn read_regular(root: &Path, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    if !safe_path(name) {
        return Err("插件文件路径无效。".into());
    }
    let root_metadata = fs::symlink_metadata(root).map_err(io_error)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("插件目录无效。".into());
    }
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err("插件文件不能是符号链接。".into());
        }
    }
    let file = File::open(&path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("插件文件无效或过大。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Err("插件文件过大。".into());
    }
    Ok(bytes)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(io::Error::from)
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination exists",
        ));
    }
    fs::rename(from, to)
}

fn safe_path(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 4096
        || name.starts_with('/')
        || name.contains(['\\', ':', '\0'])
    {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part.len() <= 255
            && !part.ends_with(['.', ' '])
            && !part.chars().any(char::is_control)
            && !matches!(
                part.split('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_uppercase()
                    .as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    })
}

fn unpack(
    archive_path: &Path,
    destination: &Path,
) -> Result<HashMap<String, (u64, String)>, String> {
    let mut file = File::open(archive_path).map_err(io_error)?;
    check_archive_directory(&mut file)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("插件包不是有效的 ZIP：{error}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("插件包中的文件过多。".into());
    }
    let mut names = HashSet::new();
    let mut files = HashMap::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取插件包：{error}"))?;
        let directory = entry.is_dir();
        let name = if directory {
            entry.name().strip_suffix('/').unwrap_or(entry.name())
        } else {
            entry.name()
        }
        .to_owned();
        if !safe_path(&name) || !names.insert(name.to_lowercase()) {
            return Err("插件包包含无效或重复的文件路径。".into());
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != if directory { 0o040000 } else { 0o100000 } {
                return Err("插件包只能包含普通文件和目录。".into());
            }
        }
        let output = destination.join(&name);
        if directory {
            if entry.size() != 0 {
                return Err("插件包目录内容无效。".into());
            }
            fs::create_dir_all(output).map_err(io_error)?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .ok_or("插件包解压后过大。")?;
        if total > MAX_UNPACKED || (name == "manifest.json" && entry.size() > MAX_MANIFEST) {
            return Err("插件包解压后超过大小限制。".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let mut output_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(io_error)?;
        let expected_size = entry.size();
        let mut limited = (&mut entry).take(expected_size + 1);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut copied = 0u64;
        loop {
            let count = limited
                .read(&mut buffer)
                .map_err(|error| format!("插件包文件损坏：{error}"))?;
            if count == 0 {
                break;
            }
            output_file.write_all(&buffer[..count]).map_err(io_error)?;
            hasher.update(&buffer[..count]);
            copied += count as u64;
        }
        if copied != expected_size {
            return Err("插件包文件大小不匹配。".into());
        }
        output_file.sync_all().map_err(io_error)?;
        files.insert(name, (copied, format!("{:x}", hasher.finalize())));
    }
    Ok(files)
}

// Inspect the end record before ZipArchive allocates one entry per file.
// The generated package limits make ZIP64 and split archives unnecessary.
fn check_archive_directory(file: &mut File) -> Result<(), String> {
    let size = file.metadata().map_err(io_error)?.len();
    let tail_size = size.min(65_557) as usize;
    if tail_size < 22 {
        return Err("插件包不是有效的 ZIP。".into());
    }
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(io_error)?;
    let mut tail = vec![0; tail_size];
    file.read_exact(&mut tail).map_err(io_error)?;
    let position = (0..=tail_size - 22)
        .rev()
        .find(|&index| {
            tail[index..index + 4] == *b"PK\x05\x06"
                && index + 22 + u16::from_le_bytes([tail[index + 20], tail[index + 21]]) as usize
                    == tail_size
        })
        .ok_or("插件包不是有效的 ZIP。")?;
    let number =
        |offset| u16::from_le_bytes([tail[position + offset], tail[position + offset + 1]]);
    let total = number(10) as usize;
    if number(4) != 0 || number(6) != 0 || number(8) as usize != total || total == u16::MAX as usize
    {
        return Err("暂不支持分卷或 ZIP64 插件包。".into());
    }
    if total > MAX_ENTRIES {
        return Err("插件包中的文件过多。".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok(())
}

fn valid_plugin_id(id: &str) -> bool {
    id.len() <= 200
        && id.split('.').count() >= 2
        && id.split('.').all(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

fn valid_capability_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | '@'))
}

fn valid_text(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.trim() == text
        && text.len() <= max
        && !text.chars().any(char::is_control)
}

fn version(value: &str) -> Result<Version, String> {
    Version::parse(value).map_err(|_| format!("无效的版本号：{value}"))
}

fn requirement(value: &str) -> Result<VersionReq, String> {
    let (caret, raw) = value
        .strip_prefix('^')
        .map_or((false, value), |s| (true, s));
    let parsed = version(raw)?;
    if !parsed.build.is_empty() || raw != parsed.to_string() {
        return Err(format!(
            "版本范围仅支持完整版本号或 ^ 加完整版本号：{value}"
        ));
    }
    VersionReq::parse(&format!("{}{raw}", if caret { "^" } else { "=" }))
        .map_err(|_| format!("无效的版本范围：{value}"))
}

fn matches_version(range: &str, actual: &str, what: &str) -> Result<(), String> {
    if requirement(range)?.matches(&version(actual)?) {
        Ok(())
    } else {
        Err(format!("{what}版本不兼容：需要 {range}，当前是 {actual}。"))
    }
}

fn check_file(root: &Path, entry: &str) -> Result<(), String> {
    if !safe_path(entry) || !root.join(entry).is_file() {
        return Err(format!("插件包中的文件路径无效或文件缺失：{entry}"));
    }
    Ok(())
}

fn validate(
    manifest: &Manifest,
    root: &Path,
    unpacked: &HashMap<String, (u64, String)>,
    current: &Compatibility,
) -> Result<(), String> {
    if manifest.manifest_version != "1.0" {
        return Err("不支持此插件清单格式。".into());
    }
    if !valid_plugin_id(&manifest.id)
        || !valid_text(&manifest.name, 512)
        || manifest.description.len() > 16 * 1024
    {
        return Err("插件 ID、名称或说明无效。".into());
    }
    let files = manifest.files.as_ref().ok_or("插件文件清单缺失。")?;
    let mut paths = HashSet::new();
    for file in files {
        if !safe_path(&file.path)
            || file.path.eq_ignore_ascii_case("manifest.json")
            || !paths.insert(file.path.to_lowercase())
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("插件文件清单无效或包含重复路径。".into());
        }
        let actual = unpacked
            .get(&file.path)
            .ok_or_else(|| format!("插件包中的文件缺失：{}", file.path))?;
        if actual.0 != file.size || actual.1 != file.sha256 {
            return Err(format!("插件文件校验失败：{}", file.path));
        }
    }
    if !unpacked.contains_key("manifest.json") || unpacked.len() != files.len() + 1 {
        return Err("插件文件与清单不一致。".into());
    }
    version(&manifest.version)?;
    matches_version(
        &manifest.compatibility.host_api,
        &current.host_api,
        "Lodestory 接口",
    )?;
    if manifest.frontend.is_none() && manifest.backend.is_none() {
        return Err("插件必须包含前端或后端。".into());
    }
    if let Some(frontend) = &manifest.frontend {
        let react = manifest
            .compatibility
            .react
            .as_ref()
            .ok_or("前端插件缺少 React 版本要求。")?;
        matches_version(react, &current.react, "React")?;
        check_file(root, &frontend.entry)?;
        let mut seen = HashSet::new();
        for style in &frontend.styles {
            if !seen.insert(style) {
                return Err("前端样式重复。".into());
            }
            check_file(root, style)?;
        }
    } else if manifest.compatibility.react.is_some() {
        return Err("没有前端的插件不能声明 React 版本。".into());
    }
    if let Some(backend) = &manifest.backend {
        if !["process", "dynamic-library"].contains(&backend.kind.as_str())
            || backend.artifacts.is_empty()
        {
            return Err("插件后端类型或平台信息无效。".into());
        }
        let mut platforms = HashSet::new();
        let mut selected = None;
        let os = std::env::consts::OS;
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => "unsupported",
        };
        for artifact in &backend.artifacts {
            if !["macos", "windows", "linux"].contains(&artifact.os.as_str())
                || !["x64", "arm64"].contains(&artifact.arch.as_str())
                || !valid_text(&artifact.target, 200)
                || !platforms.insert((&artifact.os, &artifact.arch, &artifact.target))
            {
                return Err("插件后端平台声明无效或重复。".into());
            }
            check_file(root, &artifact.entry)?;
            if artifact.os == os
                && artifact.arch == arch
                && artifact.target == env!("LODESTORY_BUILD_TARGET")
            {
                selected = Some(&artifact.entry);
            }
        }
        let entry = selected.ok_or("插件后端与当前系统或处理器不兼容。")?;
        #[cfg(unix)]
        if backend.kind == "process" {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(entry), fs::Permissions::from_mode(0o755))
                .map_err(io_error)?;
        }
        #[cfg(not(unix))]
        let _ = entry;
    }
    for (label, entries) in [
        ("插件依赖", &manifest.dependencies.plugins),
        ("所需能力", &manifest.dependencies.requires),
        ("提供能力", &manifest.dependencies.provides),
    ] {
        let mut seen = HashSet::new();
        for item in entries {
            if !(if label == "插件依赖" {
                valid_plugin_id(&item.id)
            } else {
                valid_capability_id(&item.id)
            }) || !seen.insert(&item.id)
            {
                return Err(format!("{label}包含无效或重复的 ID。"));
            }
            if label == "提供能力" {
                version(&item.version)?;
            } else {
                requirement(&item.version)?;
            }
            if label == "插件依赖" {
                return Err(format!(
                    "尚无法验证所需插件 {} 的运行版本，请待插件加载功能完善后导入。",
                    item.id
                ));
            }
            if label == "所需能力" {
                let available = current
                    .capabilities
                    .iter()
                    .find(|capability| capability.id == item.id)
                    .ok_or_else(|| format!("缺少可验证的所需能力：{}。", item.id))?;
                matches_version(
                    &item.version,
                    &available.version,
                    &format!("能力 {}", item.id),
                )?;
            }
            if label == "提供能力"
                && current
                    .capabilities
                    .iter()
                    .any(|capability| capability.id == item.id)
            {
                return Err(format!("能力 {} 已由其他插件提供。", item.id));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use zip::write::SimpleFileOptions;

    fn compatibility() -> Compatibility {
        Compatibility {
            host_api: "0.1.0".into(),
            react: "19.3.0".into(),
            capabilities: vec![Capability {
                id: "lodestory/layout@0".into(),
                version: "0.1.0".into(),
            }],
        }
    }

    fn manifest() -> Value {
        json!({
            "manifestVersion": "1.0", "id": "com.example.front", "name": "测试插件", "version": "0.1.0",
            "compatibility": {"hostApi": "^0.1.0", "react": "^19.1.0"},
            "dependencies": {"plugins": [], "requires": [{"id": "lodestory/layout@0", "version": "^0.1.0"}], "provides": []},
            "frontend": {"entry": "dist/frontend/index.js", "styles": ["dist/frontend/index.css"]}
        })
    }

    fn archive(path: &Path, manifest: &Value, extra: &[(&str, &[u8])]) {
        let mut manifest = manifest.clone();
        manifest["files"] = Value::Array(
            extra
                .iter()
                .map(|(path, bytes)| {
                    json!({
                        "path": path,
                        "size": bytes.len(),
                        "sha256": format!("{:x}", Sha256::digest(bytes)),
                    })
                })
                .collect(),
        );
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        for (name, data) in extra {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    fn front_files() -> Vec<(&'static str, &'static [u8])> {
        vec![
            ("dist/frontend/index.js", b"throw new Error('not executed')"),
            ("dist/frontend/index.css", b"body{}"),
        ]
    }

    #[test]
    fn rechecks_installed_files_and_persists_desired_enabled_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        archive(&path, &manifest(), &front_files());
        let root = temp.path().join("store");
        let packages = PluginPackages::new(root.clone());
        let imported = packages.import(&path, &compatibility()).unwrap();
        let prepared = packages.prepare(&imported.id, &compatibility()).unwrap();
        assert_eq!(prepared.frontend.unwrap().entry, "dist/frontend/index.js");
        assert_eq!(
            packages
                .asset(&imported.id, "dist/frontend/index.css")
                .unwrap(),
            b"body{}"
        );
        assert!(packages.asset(&imported.id, "../source.zip").is_err());
        packages.set_enabled(&imported.id, true).unwrap();
        assert!(PluginPackages::new(root.clone()).list().unwrap()[0].enabled);
        fs::write(
            root.join("installed/plugin-com.example.front/package/dist/frontend/index.css"),
            b"changed",
        )
        .unwrap();
        assert!(packages
            .asset(&imported.id, "dist/frontend/index.css")
            .is_err());
        assert!(packages.prepare(&imported.id, &compatibility()).is_err());
        packages.release_assets(&imported.id);
        assert!(packages
            .asset(&imported.id, "dist/frontend/index.js")
            .is_err());
        packages.set_enabled(&imported.id, false).unwrap();
        assert!(!packages.list().unwrap()[0].enabled);
    }

    #[test]
    fn rejects_manifest_changes_after_import() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        archive(&path, &manifest(), &front_files());
        let root = temp.path().join("store");
        let packages = PluginPackages::new(root.clone());
        let imported = packages.import(&path, &compatibility()).unwrap();
        fs::write(
            root.join("installed/plugin-com.example.front/package/manifest.json"),
            b"{}",
        )
        .unwrap();
        assert!(packages
            .prepare(&imported.id, &compatibility())
            .unwrap_err()
            .contains("已被修改"));
    }

    #[test]
    fn imports_and_remembers_valid_package_without_executing_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        archive(&path, &manifest(), &front_files());
        let packages = PluginPackages::new(temp.path().join("store"));
        let imported = packages.import(&path, &compatibility()).unwrap();
        assert_eq!(imported.status, "pending-load");
        assert_eq!(packages.list().unwrap(), vec![imported.clone()]);
        let after_restart = PluginPackages::new(temp.path().join("store"));
        assert_eq!(after_restart.list().unwrap(), vec![imported]);
        let record: Record = serde_json::from_reader(
            File::open(
                temp.path()
                    .join("store/installed/plugin-com.example.front/record.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(record.sha256.len(), 64);
        assert!(temp
            .path()
            .join("store/installed/plugin-com.example.front/package/dist/frontend/index.js")
            .is_file());
        assert!(packages
            .import(&path, &compatibility())
            .unwrap_err()
            .contains("已导入"));
    }

    #[test]
    fn rejects_missing_incompatible_and_unverifiable_dependencies_without_committing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let packages = PluginPackages::new(temp.path().join("store"));
        let mut cases = Vec::new();
        let mut m = manifest();
        m["manifestVersion"] = json!("2.0");
        cases.push((m, "清单格式"));
        let mut m = manifest();
        m["compatibility"]["hostApi"] = json!("^1.0.0");
        cases.push((m, "接口版本不兼容"));
        let mut m = manifest();
        m["compatibility"]["react"] = json!("^18.0.0");
        cases.push((m, "React版本不兼容"));
        let mut m = manifest();
        m["dependencies"]["requires"][0]["id"] = json!("unknown/service@0");
        cases.push((m, "缺少可验证"));
        let mut m = manifest();
        m["dependencies"]["requires"][0]["version"] = json!("^0.2.0");
        cases.push((m, "版本不兼容"));
        let mut m = manifest();
        m["dependencies"]["plugins"] = json!([{"id":"com.example.other", "version":"^0.1.0"}]);
        cases.push((m, "无法验证所需插件"));
        let mut m = manifest();
        m["frontend"]["entry"] = json!("dist/frontend/missing.js");
        cases.push((m, "文件缺失"));
        let mut m = manifest();
        m["compatibility"]["hostApi"] = json!(">=0.1.0 <1.0.0");
        cases.push((m, "版本"));
        for (value, expected) in cases {
            archive(&path, &value, &front_files());
            let error = packages.import(&path, &compatibility()).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(packages.list().unwrap().is_empty());
            assert_eq!(
                fs::read_dir(temp.path().join("store/staging"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn accepts_matching_backend_and_rejects_other_platforms() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let mut m = manifest();
        m.as_object_mut().unwrap().remove("frontend");
        m["compatibility"].as_object_mut().unwrap().remove("react");
        m["dependencies"]["requires"] = json!([]);
        m["backend"] = json!({"type":"process", "artifacts": [{
            "os": std::env::consts::OS,
            "arch": if std::env::consts::ARCH == "aarch64" {"arm64"} else {"x64"},
            "target": env!("LODESTORY_BUILD_TARGET"), "entry": "dist/backend/tool"
        }]});
        archive(&path, &m, &[("dist/backend/tool", b"native")]);
        let packages = PluginPackages::new(temp.path().join("store"));
        packages.import(&path, &compatibility()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(
                temp.path()
                    .join("store/installed/plugin-com.example.front/package/dist/backend/tool"),
            )
            .unwrap()
            .permissions()
            .mode();
            assert_ne!(mode & 0o111, 0);
        }
        m["id"] = json!("com.example.other");
        m["backend"]["artifacts"][0]["target"] = json!("different-target");
        archive(&path, &m, &[("dist/backend/tool", b"native")]);
        assert!(packages
            .import(&path, &compatibility())
            .unwrap_err()
            .contains("不兼容"));
        assert_eq!(packages.list().unwrap().len(), 1);
    }

    #[test]
    fn rejects_traversal_collisions_and_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let packages = PluginPackages::new(temp.path().join("store"));
        for (bad, data) in [
            ("../escape", &b"bad"[..]),
            ("dist/frontend/INDEX.JS", &b"bad"[..]),
            ("C:/escape", &b"bad"[..]),
        ] {
            let mut entries = front_files();
            entries.push((bad, data));
            archive(&path, &manifest(), &entries);
            assert!(packages.import(&path, &compatibility()).is_err(), "{bad}");
            assert!(packages.list().unwrap().is_empty());
        }
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(manifest().to_string().as_bytes()).unwrap();
        writer
            .add_symlink("dist/link", "../../escape", SimpleFileOptions::default())
            .unwrap();
        writer.finish().unwrap();
        assert!(packages
            .import(&path, &compatibility())
            .unwrap_err()
            .contains("普通文件"));
        assert!(!temp.path().join("escape").exists());
    }

    #[test]
    fn interrupted_staging_is_cleaned_and_existing_packages_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        archive(&path, &manifest(), &front_files());
        let packages = PluginPackages::new(temp.path().join("store"));
        packages.import(&path, &compatibility()).unwrap();
        let abandoned = temp.path().join("store/staging/plugin-stage-interrupted");
        fs::create_dir(&abandoned).unwrap();
        fs::write(abandoned.join("partial"), "data").unwrap();
        assert_eq!(packages.list().unwrap().len(), 1);
        assert!(!abandoned.exists());
        assert!(packages.import(&path, &compatibility()).is_err());
        assert_eq!(packages.list().unwrap().len(), 1);
    }

    #[test]
    fn corrupted_zip_contents_are_rejected_without_a_record() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(manifest().to_string().as_bytes()).unwrap();
        writer
            .start_file("dist/frontend/index.js", options)
            .unwrap();
        writer.write_all(b"unique-javascript-content").unwrap();
        writer
            .start_file("dist/frontend/index.css", options)
            .unwrap();
        writer.write_all(b"body{}").unwrap();
        writer.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let position = bytes
            .windows(b"unique-javascript-content".len())
            .position(|part| part == b"unique-javascript-content")
            .unwrap();
        bytes[position] ^= 1;
        fs::write(&path, bytes).unwrap();
        let packages = PluginPackages::new(temp.path().join("store"));
        assert!(packages
            .import(&path, &compatibility())
            .unwrap_err()
            .contains("损坏"));
        assert!(packages.list().unwrap().is_empty());
    }

    #[test]
    fn oversized_archive_directory_is_rejected_before_allocating_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        archive(&path, &manifest(), &front_files());
        let mut bytes = fs::read(&path).unwrap();
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
        bytes[end + 8..end + 10].copy_from_slice(&5000u16.to_le_bytes());
        bytes[end + 10..end + 12].copy_from_slice(&5000u16.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let packages = PluginPackages::new(temp.path().join("store"));
        assert!(packages
            .import(&path, &compatibility())
            .unwrap_err()
            .contains("过多"));
        assert!(packages.list().unwrap().is_empty());
    }

    #[test]
    fn missing_or_modified_non_entry_files_fail_the_manifest_inventory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let packages = PluginPackages::new(temp.path().join("store"));
        for missing in [true, false] {
            let mut manifest = manifest();
            let declared: Vec<Value> = [
                ("dist/frontend/index.js", &b"entry"[..]),
                ("dist/frontend/index.css", &b"body{}"[..]),
                ("dist/frontend/chunks/panel.js", &b"panel"[..]),
            ].iter().map(|(path, bytes)| json!({
                "path": path, "size": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes)),
            })).collect();
            manifest["files"] = Value::Array(declared);
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("manifest.json", options).unwrap();
            writer.write_all(manifest.to_string().as_bytes()).unwrap();
            writer
                .start_file("dist/frontend/index.js", options)
                .unwrap();
            writer.write_all(b"entry").unwrap();
            writer
                .start_file("dist/frontend/index.css", options)
                .unwrap();
            writer.write_all(b"body{}").unwrap();
            if !missing {
                writer
                    .start_file("dist/frontend/chunks/panel.js", options)
                    .unwrap();
                writer.write_all(b"other").unwrap();
            }
            writer.finish().unwrap();
            let error = packages.import(&path, &compatibility()).unwrap_err();
            assert!(
                error.contains(if missing {
                    "文件缺失"
                } else {
                    "校验失败"
                }),
                "{error}"
            );
            assert!(packages.list().unwrap().is_empty());
        }
    }

    #[test]
    fn concurrent_imports_of_the_same_id_never_overwrite_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin.zip");
        let root = temp.path().join("store");
        archive(&path, &manifest(), &front_files());
        let results = std::thread::scope(|scope| {
            let first =
                scope.spawn(|| PluginPackages::new(root.clone()).import(&path, &compatibility()));
            let second =
                scope.spawn(|| PluginPackages::new(root.clone()).import(&path, &compatibility()));
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result.as_ref().is_err_and(|error| error.contains("已导入")))
                .count(),
            1
        );
        assert_eq!(PluginPackages::new(root).list().unwrap().len(), 1);
    }

    #[test]
    fn version_rules_match_full_exact_and_caret_versions() {
        assert!(matches_version("^0.1.0", "0.1.9", "test").is_ok());
        assert!(matches_version("^0.1.0", "0.2.0", "test").is_err());
        assert!(matches_version("1.0.0", "1.0.1", "test").is_err());
        assert!(matches_version("^1.0.0", "1.2.0-beta.1", "test").is_err());
        assert!(requirement("*").is_err());
        assert!(requirement("1.0.0+build").is_err());
    }
}
