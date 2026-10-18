use font_kit::source::{Source, SystemSource};

#[tauri::command]
pub async fn list_system_font_families() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(list_installed_font_families)
        .await
        .map_err(|error| format!("读取系统字体列表失败：{error}"))?
}

fn list_installed_font_families() -> Result<Vec<String>, String> {
    let families = SystemSource::new()
        .all_families()
        .map_err(|error| format!("读取系统字体列表失败：{error}"))?;
    Ok(normalize_families(families))
}

fn normalize_families(mut families: Vec<String>) -> Vec<String> {
    families.retain(|family| !family.trim().is_empty());
    families.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()).then(left.cmp(right)));
    families.dedup();
    families
}

#[cfg(test)]
mod tests {
    use super::normalize_families;

    #[test]
    fn system_family_names_are_trimmed_of_blank_entries_sorted_and_deduplicated() {
        assert_eq!(
            normalize_families(vec!["Arial".into(), "".into(), "Arial".into(), "Noto Sans".into()]),
            vec!["Arial", "Noto Sans"],
        );
    }
}
