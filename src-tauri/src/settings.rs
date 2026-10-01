use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

type Settings = BTreeMap<String, String>;
type Deletions = BTreeMap<String, BTreeSet<String>>;
const DELETIONS_KEY: &str = "sai-settings-deletions";
const MODIFIED_KEY: &str = "sai-settings-modified";

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(root) = std::env::var_os("SAIL_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(root).join("settings.json"));
    }
    let config = app
        .path()
        .config_dir()
        .map_err(|error| format!("Cannot locate the configuration directory: {error}"))?;
    Ok(config.join("sail").join("settings.json"))
}

fn lock_settings(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("Cannot locate settings folder.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create settings folder: {error}"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| format!("Cannot open settings lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot lock settings: {error}"))?;
    Ok(lock)
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    let backup = path.with_extension("json.bak");
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::read_to_string(&backup) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Settings::new());
                }
                Err(error) => return Err(format!("Cannot read settings backup: {error}")),
            }
        }
        Err(error) => return Err(format!("Cannot read settings: {error}")),
    };
    serde_json::from_str(&contents).map_err(|error| format!("Cannot parse settings: {error}"))
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Cannot encode settings: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot write settings: {error}"))?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Cannot write settings: {error}"))?;
    drop(file);

    #[cfg(windows)]
    {
        let backup = path.with_extension("json.bak");
        if path.exists() {
            if backup.exists() {
                fs::remove_file(&backup)
                    .map_err(|error| format!("Cannot replace settings backup: {error}"))?;
            }
            fs::rename(path, &backup)
                .map_err(|error| format!("Cannot back up settings: {error}"))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("Cannot save settings: {error}"));
        }
        if backup.exists() {
            let _ = fs::remove_file(backup);
        }
    }
    #[cfg(not(windows))]
    fs::rename(&temporary, path).map_err(|error| format!("Cannot save settings: {error}"))?;
    Ok(())
}

fn identity(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn append_unique(base: &mut Vec<serde_json::Value>, extra: &[serde_json::Value], field: &str) {
    let mut seen: HashSet<String> = base.iter().map(|item| identity(item, field)).collect();
    for item in extra {
        if seen.insert(identity(item, field)) {
            base.push(item.clone());
        }
    }
}

fn merge_catalog(current: &str, legacy: &str, prefer_legacy: bool) -> String {
    if prefer_legacy {
        return merge_catalog(legacy, current, false);
    }
    let Ok(mut base) = serde_json::from_str::<serde_json::Value>(current) else {
        return legacy.to_string();
    };
    let Ok(extra) = serde_json::from_str::<serde_json::Value>(legacy) else {
        return current.to_string();
    };
    let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) else {
        return current.to_string();
    };
    for field in ["repositories", "groups"] {
        let Some(entries) = extra.get(field).and_then(serde_json::Value::as_array) else {
            continue;
        };
        let Some(existing) = base
            .get_mut(field)
            .and_then(serde_json::Value::as_array_mut)
        else {
            base.insert(field.to_string(), serde_json::Value::Array(entries.clone()));
            continue;
        };
        if field == "repositories" {
            append_unique(existing, entries, "");
        } else {
            for group in entries {
                let id = identity(group, "id");
                if let Some(saved) = existing.iter_mut().find(|item| identity(item, "id") == id) {
                    if let (Some(saved), Some(group)) = (saved.as_object_mut(), group.as_object()) {
                        if let Some(repositories) = group
                            .get("repositories")
                            .and_then(serde_json::Value::as_array)
                        {
                            if let Some(assigned) = saved
                                .get_mut("repositories")
                                .and_then(serde_json::Value::as_array_mut)
                            {
                                append_unique(assigned, repositories, "");
                            }
                        }
                    }
                } else {
                    existing.push(group.clone());
                }
            }
        }
    }
    if let Some(worktrees) = extra
        .get("worktrees")
        .and_then(serde_json::Value::as_object)
    {
        let saved = base
            .entry("worktrees")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(saved) = saved.as_object_mut() {
            for (repository, entries) in worktrees {
                let Some(entries) = entries.as_array() else {
                    continue;
                };
                let existing = saved
                    .entry(repository)
                    .or_insert_with(|| serde_json::json!([]));
                if let Some(existing) = existing.as_array_mut() {
                    append_unique(existing, entries, "path");
                }
            }
        }
    }
    serde_json::to_string(base).unwrap_or_else(|_| current.to_string())
}

fn merge_threads(current: &str, legacy: &str) -> String {
    let Ok(mut base) = serde_json::from_str::<Vec<serde_json::Value>>(current) else {
        return legacy.to_string();
    };
    let Ok(extra) = serde_json::from_str::<Vec<serde_json::Value>>(legacy) else {
        return current.to_string();
    };
    let mut seen: HashSet<String> = base
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}",
                identity(item, "agent"),
                identity(item, "directory"),
                identity(item, "sessionId")
            )
        })
        .collect();
    for item in extra {
        let id = format!(
            "{}:{}:{}",
            identity(&item, "agent"),
            identity(&item, "directory"),
            identity(&item, "sessionId")
        );
        if seen.insert(id) {
            base.push(item);
        }
    }
    serde_json::to_string(&base).unwrap_or_else(|_| current.to_string())
}

fn thread_id(thread: &serde_json::Value) -> String {
    serde_json::json!([
        identity(thread, "agent"),
        identity(thread, "directory"),
        identity(thread, "sessionId")
    ])
    .to_string()
}

fn catalog_entries(raw: &str) -> Deletions {
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Deletions::new();
    };
    let mut entries = Deletions::new();
    let mut collect = |kind: &str, values: Vec<String>| {
        entries.insert(kind.to_string(), values.into_iter().collect());
    };
    collect(
        "repositories",
        catalog["repositories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
    );
    collect(
        "groups",
        catalog["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|group| identity(group, "id"))
            .collect(),
    );
    collect(
        "memberships",
        catalog["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| {
                group["repositories"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|path| {
                        path.as_str().map(|path| {
                            serde_json::json!([identity(group, "id"), path]).to_string()
                        })
                    })
            })
            .collect(),
    );
    collect(
        "worktrees",
        catalog["worktrees"]
            .as_object()
            .into_iter()
            .flat_map(|worktrees| worktrees.values())
            .filter_map(serde_json::Value::as_array)
            .flatten()
            .map(|entry| identity(entry, "path"))
            .collect(),
    );
    entries
}

fn entries_for(key: &str, raw: &str) -> Deletions {
    if key == "sai-project-catalog" {
        return catalog_entries(raw);
    }
    let threads = serde_json::from_str::<Vec<serde_json::Value>>(raw).unwrap_or_default();
    Deletions::from([(
        "threads".to_string(),
        threads.iter().map(thread_id).collect(),
    )])
}

fn update_deletions(saved: &mut Settings, key: &str, next: &str) -> Result<(), String> {
    let mut deleted: Deletions = saved
        .get(DELETIONS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let before = saved
        .get(key)
        .map(|raw| entries_for(key, raw))
        .unwrap_or_default();
    let after = entries_for(key, next);
    for (kind, previous) in before {
        let active = after.get(&kind).cloned().unwrap_or_default();
        deleted
            .entry(kind)
            .or_default()
            .extend(previous.difference(&active).cloned());
    }
    for (kind, active) in after {
        if let Some(removed) = deleted.get_mut(&kind) {
            for id in active {
                removed.remove(&id);
            }
        }
    }
    saved.insert(
        DELETIONS_KEY.to_string(),
        serde_json::to_string(&deleted)
            .map_err(|error| format!("Cannot encode deletions: {error}"))?,
    );
    Ok(())
}

fn filter_legacy(key: &str, raw: &str, deleted: &Deletions) -> String {
    let has = |kind: &str, id: &str| deleted.get(kind).is_some_and(|ids| ids.contains(id));
    if key == "sail-agent-threads" {
        let Ok(mut threads) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else {
            return raw.to_string();
        };
        threads.retain(|thread| !has("threads", &thread_id(thread)));
        return serde_json::to_string(&threads).unwrap_or_else(|_| raw.to_string());
    }
    let Ok(mut catalog) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    if let Some(repositories) = catalog["repositories"].as_array_mut() {
        repositories.retain(|path| !path.as_str().is_some_and(|path| has("repositories", path)));
    }
    if let Some(groups) = catalog["groups"].as_array_mut() {
        groups.retain(|group| !has("groups", &identity(group, "id")));
        for group in groups {
            let id = identity(group, "id");
            if let Some(repositories) = group["repositories"].as_array_mut() {
                repositories.retain(|path| {
                    !path.as_str().is_some_and(|path| {
                        has("repositories", path)
                            || has("memberships", &serde_json::json!([id, path]).to_string())
                    })
                });
            }
        }
    }
    if let Some(worktrees) = catalog["worktrees"].as_object_mut() {
        worktrees.retain(|repository, _| !has("repositories", repository));
        for entries in worktrees.values_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| !has("worktrees", &identity(entry, "path")));
            }
        }
    }
    serde_json::to_string(&catalog).unwrap_or_else(|_| raw.to_string())
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    read_settings(&path)
}

#[tauri::command]
pub fn migrate_settings(
    app: tauri::AppHandle,
    legacy: Settings,
    prefer_legacy: bool,
) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut saved = read_settings(&path)?;
    let before = saved.clone();
    let deleted: Deletions = saved
        .get(DELETIONS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let modified: BTreeSet<String> = saved
        .get(MODIFIED_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    for (key, value) in legacy {
        if (!key.starts_with("sai-") && key != "sail-agent-threads")
            || key == DELETIONS_KEY
            || key == MODIFIED_KEY
        {
            continue;
        }
        let value = if key == "sai-project-catalog" || key == "sail-agent-threads" {
            filter_legacy(&key, &value, &deleted)
        } else {
            value
        };
        match saved.get(&key) {
            None if !modified.contains(&key) => {
                saved.insert(key, value);
            }
            None => {}
            Some(current) if key == "sai-project-catalog" => {
                let merged = merge_catalog(
                    current,
                    &value,
                    prefer_legacy && !modified.contains("sai-project-catalog"),
                );
                saved.insert(key, merged);
            }
            Some(current) if key == "sail-agent-threads" => {
                let merged = merge_threads(current, &value);
                saved.insert(key, merged);
            }
            Some(_) if prefer_legacy && !modified.contains(&key) => {
                saved.insert(key, value);
            }
            Some(_) => {}
        }
    }
    if saved != before {
        write_settings(&path, &saved)?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn save_setting(
    app: tauri::AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    if !key.starts_with("sai-") && key != "sail-agent-threads" {
        return Err("Unknown settings key.".to_string());
    }
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut saved = read_settings(&path)?;
    if key == DELETIONS_KEY || key == MODIFIED_KEY {
        return Err("Unknown settings key.".to_string());
    }
    let mut modified: BTreeSet<String> = saved
        .get(MODIFIED_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    modified.insert(key.clone());
    saved.insert(
        MODIFIED_KEY.to_string(),
        serde_json::to_string(&modified)
            .map_err(|error| format!("Cannot encode changes: {error}"))?,
    );
    if key == "sai-project-catalog" || key == "sail-agent-threads" {
        update_deletions(&mut saved, &key, value.as_deref().unwrap_or_default())?;
    }
    match value {
        Some(value) => {
            saved.insert(key, value);
        }
        None => {
            saved.remove(&key);
        }
    }
    write_settings(&path, &saved)
}

#[cfg(test)]
mod tests {
    use super::{
        filter_legacy, lock_settings, merge_catalog, merge_threads, read_settings,
        update_deletions, write_settings, Deletions, Settings, DELETIONS_KEY,
    };

    #[test]
    fn merges_projects_from_two_webview_origins() {
        let dev = r#"{"repositories":["/dev"],"groups":[],"worktrees":{}}"#;
        let packaged = r#"{"repositories":["/daily"],"groups":[{"id":"daily","name":"Daily","repositories":["/daily"]}],"worktrees":{}}"#;
        let merged: serde_json::Value =
            serde_json::from_str(&merge_catalog(dev, packaged, true)).unwrap();
        assert_eq!(
            merged["repositories"],
            serde_json::json!(["/daily", "/dev"])
        );
        assert_eq!(merged["groups"][0]["name"], "Daily");
    }

    #[test]
    fn deduplicates_restored_agent_threads() {
        let thread = r#"{"agent":"claude","directory":"/daily","sessionId":"1"}"#;
        let merged = merge_threads(&format!("[{thread}]"), &format!("[{thread}]"));
        let threads: Vec<serde_json::Value> = serde_json::from_str(&merged).unwrap();
        assert_eq!(threads.len(), 1);
    }

    #[test]
    fn deleted_legacy_items_stay_deleted() {
        let old = r#"{"repositories":["/keep","/deleted"],"groups":[{"id":"group","repositories":["/keep","/deleted"]},{"id":"removed","repositories":[]}],"worktrees":{"/keep":[{"path":"/tree","branch":"old"}]}}"#;
        let new = r#"{"repositories":["/keep"],"groups":[{"id":"group","repositories":[]}],"worktrees":{"/keep":[]}}"#;
        let mut saved = Settings::from([("sai-project-catalog".to_string(), old.to_string())]);
        update_deletions(&mut saved, "sai-project-catalog", new).unwrap();
        let deleted: Deletions = serde_json::from_str(&saved[DELETIONS_KEY]).unwrap();
        let filtered: serde_json::Value =
            serde_json::from_str(&filter_legacy("sai-project-catalog", old, &deleted)).unwrap();
        assert_eq!(filtered["repositories"], serde_json::json!(["/keep"]));
        assert_eq!(filtered["groups"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["groups"][0]["repositories"], serde_json::json!([]));
        assert_eq!(filtered["worktrees"]["/keep"], serde_json::json!([]));

        let thread = r#"{"agent":"claude","directory":"/keep","sessionId":"1"}"#;
        saved.insert("sail-agent-threads".to_string(), format!("[{thread}]"));
        update_deletions(&mut saved, "sail-agent-threads", "[]").unwrap();
        let deleted: Deletions = serde_json::from_str(&saved[DELETIONS_KEY]).unwrap();
        assert_eq!(
            filter_legacy("sail-agent-threads", &format!("[{thread}]"), &deleted),
            "[]"
        );
    }

    #[test]
    fn concurrent_writers_keep_distinct_settings() {
        let directory = std::env::temp_dir().join(format!(
            "sail-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("settings.json");
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _lock = lock_settings(&path).unwrap();
                    let mut saved = read_settings(&path).unwrap();
                    saved.insert(format!("sai-key-{index}"), index.to_string());
                    write_settings(&path, &saved).unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(read_settings(&path).unwrap().len(), 8);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
