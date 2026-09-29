use std::{fs, io, path::Path};

pub fn migrate_legacy_directory(directory: &Path, legacy: &Path) -> io::Result<()> {
    // An existing destination is authoritative and must never be replaced.
    if directory_exists(directory)? || !directory_exists(legacy)? {
        return Ok(());
    }
    fs::rename(legacy, directory)
}

fn directory_exists(path: &Path) -> io::Result<bool> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("配置路径不是目录：{}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_does_not_create_configuration_directories() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Lodestory");
        let legacy = root.path().join("com.lodestory.app");

        migrate_legacy_directory(&directory, &legacy).unwrap();

        assert!(!directory.exists());
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_preserves_the_index_and_other_configuration_files() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Lodestory");
        let legacy = root.path().join("com.lodestory.app");
        fs::create_dir(&legacy).unwrap();
        let index = br#"{"schemaVersion":1,"projects":[]}"#;
        fs::write(legacy.join("recent-projects.json"), index).unwrap();
        fs::write(legacy.join("settings.json"), "{}").unwrap();

        migrate_legacy_directory(&directory, &legacy).unwrap();
        migrate_legacy_directory(&directory, &legacy).unwrap();

        assert_eq!(
            fs::read(directory.join("recent-projects.json")).unwrap(),
            index
        );
        assert_eq!(
            fs::read_to_string(directory.join("settings.json")).unwrap(),
            "{}"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn existing_destination_is_preserved_along_with_the_legacy_directory() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Lodestory");
        let legacy = root.path().join("com.lodestory.app");
        fs::create_dir(&directory).unwrap();
        fs::create_dir(&legacy).unwrap();
        fs::write(directory.join("recent-projects.json"), "current").unwrap();
        fs::write(legacy.join("recent-projects.json"), "legacy").unwrap();

        migrate_legacy_directory(&directory, &legacy).unwrap();

        assert_eq!(
            fs::read_to_string(directory.join("recent-projects.json")).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(legacy.join("recent-projects.json")).unwrap(),
            "legacy"
        );
    }

    #[test]
    fn invalid_destination_leaves_legacy_configuration_intact() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Lodestory");
        let legacy = root.path().join("com.lodestory.app");
        fs::write(&directory, "keep").unwrap();
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("recent-projects.json"), "legacy").unwrap();

        assert_eq!(
            migrate_legacy_directory(&directory, &legacy)
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotADirectory,
        );
        assert_eq!(fs::read_to_string(&directory).unwrap(), "keep");
        assert_eq!(
            fs::read_to_string(legacy.join("recent-projects.json")).unwrap(),
            "legacy"
        );
    }
}
