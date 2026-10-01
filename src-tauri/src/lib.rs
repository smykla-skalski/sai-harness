use serde::Serialize;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
#[cfg(any(target_os = "macos", windows))]
use tauri::{Emitter, Manager};

#[cfg(any(target_os = "macos", windows))]
fn configure_pane_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};

    let menu = Menu::default(app)?;
    let close_pane = MenuItem::with_id(app, "close-pane", "Close Pane", true, Some("CmdOrCtrl+W"))?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, entry) in submenu.items()?.into_iter().enumerate().rev() {
                if let Some(predefined) = entry.as_predefined_menuitem() {
                    if ["Close", "C&lose Window"].contains(&predefined.text()?.as_str()) {
                        submenu.remove_at(index)?;
                    }
                }
            }
            if submenu.text()? == "File" {
                submenu.insert(&close_pane, 0)?;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() != "close-pane" {
            return;
        }
        if let Some(settings) = app.get_webview_window("settings") {
            if settings.is_focused().unwrap_or(false) {
                let _ = settings.close();
                return;
            }
        }
        let _ = app.emit_to("main", "pane:close", ());
    });
    Ok(())
}

mod acp;
mod attention;
mod browser;
mod settings;
mod terminal;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    url: String,
    password: String,
    binary_path: String,
}

struct OwnedRuntime {
    child: Child,
    info: RuntimeInfo,
    binary: OsString,
}

fn stop_child(child: &mut Child, binary: &Path) {
    let _ = binary;
    #[cfg(windows)]
    if binary.extension().is_some_and(|extension| {
        let extension = extension.to_string_lossy();
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    }) && child.try_wait().ok().flatten().is_none()
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        stop_child(&mut self.child, Path::new(&self.binary));
    }
}

#[derive(Default)]
struct RuntimeManager(Mutex<Option<OwnedRuntime>>);

fn candidate_paths() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["opencode.exe", "opencode.cmd", "opencode.bat"]
    } else {
        &["opencode"]
    };
    let mut directories = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&paths));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        directories.extend([
            home.join(".local/bin"),
            home.join(".opencode/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".bun/bin"),
            home.join("scoop/shims"),
        ]);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local).join("Programs/opencode"));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(roaming).join("npm"));
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ]);
    directories
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .collect()
}

fn version_number(output: &str) -> Option<&str> {
    let version = output.split_whitespace().last()?.trim_start_matches('v');
    if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(version)
    } else {
        None
    }
}

fn compatible_version(binary: &Path) -> Result<(), String> {
    let mut child = Command::new(binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "OpenCode binary not found or cannot run. Choose an absolute binary path in settings."
                .to_string()
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or("OpenCode did not provide version output")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = sender.send(line);
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                stop_child(&mut child, binary);
                return Err(
                    "OpenCode version check timed out. Choose another binary in settings."
                        .to_string(),
                );
            }
        }
    };
    let output = receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap_or_default();
    let version = version_number(&output);
    if status.success() && version.is_some_and(|value| value.starts_with("2.")) {
        Ok(())
    } else {
        Err(format!(
            "OpenCode v2 is required (found {}). Choose a compatible binary in settings.",
            version.unwrap_or("an incompatible binary")
        ))
    }
}

fn resolve_binary(binary_path: Option<String>) -> Result<OsString, String> {
    if let Some(path) = binary_path.filter(|path| !path.trim().is_empty()) {
        let binary = PathBuf::from(path);
        if !binary.is_absolute() {
            return Err("OpenCode binary path must be absolute.".to_string());
        }
        compatible_version(&binary)?;
        return Ok(binary.into_os_string());
    }
    if let Some(path) =
        std::env::var_os("SAIL_OPENCODE_BIN").or_else(|| std::env::var_os("SAI_OPENCODE_BIN"))
    {
        let binary = PathBuf::from(path);
        compatible_version(&binary)?;
        return Ok(binary.into_os_string());
    }
    let mut incompatible = None;
    for binary in candidate_paths() {
        if binary.is_file() {
            match compatible_version(&binary) {
                Ok(()) => return Ok(binary.into_os_string()),
                Err(error) => incompatible = Some(error),
            }
        }
    }
    Err(incompatible.unwrap_or_else(|| {
        "OpenCode v2 was not found. Install it or choose an absolute binary path in settings."
            .to_string()
    }))
}

fn probe_runtime(info: &RuntimeInfo) -> Result<(), String> {
    let diagnostic =
        "OpenCode did not respond with a compatible v2 API. Check its configuration and retry.";
    let url = reqwest::Url::parse(&info.url).map_err(|_| diagnostic.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err(diagnostic.to_string());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|_| diagnostic.to_string())?;
    let response = client
        .get(format!("{}/api/info", info.url.trim_end_matches('/')))
        .basic_auth("opencode", Some(&info.password))
        .send()
        .map_err(|_| diagnostic.to_string())?;
    if !response.status().is_success() {
        return Err(diagnostic.to_string());
    }
    let body: serde_json::Value = response.json().map_err(|_| diagnostic.to_string())?;
    if body
        .get("version")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|version| version.starts_with("2."))
    {
        Ok(())
    } else {
        Err(diagnostic.to_string())
    }
}

fn server_args() -> Vec<&'static str> {
    let mut args = vec![
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--cors",
        "tauri://localhost",
        "--cors",
        "http://tauri.localhost",
    ];
    if cfg!(debug_assertions) {
        args.extend([
            "--cors",
            "http://localhost:1420",
            "--cors",
            "http://127.0.0.1:1420",
        ]);
    }
    args
}

#[tauri::command]
fn start_runtime(
    manager: State<'_, RuntimeManager>,
    binary_path: Option<String>,
    restart: bool,
) -> Result<RuntimeInfo, String> {
    let mut runtime = manager.0.lock().map_err(|error| error.to_string())?;
    let binary = resolve_binary(binary_path)?;
    if let Some(existing) = runtime.as_mut() {
        if !restart
            && existing.binary == binary
            && existing.child.try_wait().ok().flatten().is_none()
        {
            return Ok(existing.info.clone());
        }
    }

    let mut child = Command::new(&binary)
        .args(server_args())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start OpenCode. Check the binary path and retry.".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or("OpenCode did not provide startup output")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut url = None;
        let mut password = None;
        let mut sender = Some(sender);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("server listening on ") {
                url = Some(value.trim().to_string());
            }
            if let Some(value) = line.strip_prefix("server password ") {
                password = Some(value.trim().to_string());
            }
            if let (Some(url), Some(password)) = (url.as_ref(), password.as_ref()) {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(RuntimeInfo {
                        url: url.clone(),
                        password: password.clone(),
                        binary_path: String::new(),
                    });
                }
            }
        }
    });

    let mut info = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(info) => info,
        Err(_) => {
            let exit = child.try_wait().ok().flatten();
            stop_child(&mut child, Path::new(&binary));
            return Err(match exit {
                Some(status) => format!(
                    "OpenCode exited before becoming ready ({status}). Check its configuration and retry."
                ),
                None => "OpenCode did not become ready within 15 seconds. Retry or choose another binary."
                    .to_string(),
            });
        }
    };
    info.binary_path = Path::new(&binary).to_string_lossy().into_owned();
    let mut ready = false;
    for _ in 0..5 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if probe_runtime(&info).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !ready {
        stop_child(&mut child, Path::new(&binary));
        return Err(
            "OpenCode did not respond with a compatible v2 API. Check its configuration and retry."
                .to_string(),
        );
    }
    *runtime = Some(OwnedRuntime {
        child,
        info: info.clone(),
        binary,
    });
    Ok(info)
}

#[tauri::command]
fn validate_repository(path: String) -> Result<String, String> {
    let directory = Path::new(&path)
        .canonicalize()
        .map_err(|_| "Repository path does not exist. Choose an existing directory.".to_string())?;
    if !directory.is_dir() {
        return Err("Repository path is not a directory.".to_string());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&directory)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|_| "Git is unavailable. Install Git to select a repository.".to_string())?;
    if !output.status.success() {
        return Err("Selected directory is not inside a Git repository.".to_string());
    }
    let root = String::from_utf8(output.stdout)
        .map_err(|_| "Git returned a repository path that cannot be displayed.".to_string())?;
    Ok(root.trim().to_string())
}

#[derive(Serialize)]
struct WorkingDiff {
    file: String,
    patch: String,
    additions: usize,
    deletions: usize,
    status: &'static str,
}

#[tauri::command]
async fn working_tree_diff(path: String) -> Result<Vec<WorkingDiff>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let output = Command::new("git")
            .args([
                "-C",
                &root,
                "status",
                "--porcelain=v1",
                "-z",
                "--no-renames",
                "--untracked-files=all",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("Could not read working tree changes.".into());
        }
        let has_head = Command::new("git")
            .args(["-C", &root, "rev-parse", "--verify", "HEAD"])
            .output()
            .is_ok_and(|result| result.status.success());
        let mut files = Vec::new();
        for record in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            if record.len() < 4 {
                continue;
            }
            let file = String::from_utf8_lossy(&record[3..]).into_owned();
            let untracked = &record[..2] == b"??";
            let status = if untracked || record[..2].contains(&b'A') {
                "added"
            } else if record[..2].contains(&b'D') {
                "deleted"
            } else {
                "modified"
            };
            let patch = if untracked || !has_head {
                Command::new("git")
                    .args(["-C", &root, "diff", "--no-index", "--", "/dev/null"])
                    .arg(Path::new(&root).join(&file))
                    .output()
            } else {
                Command::new("git")
                    .args(["-C", &root, "diff", "HEAD", "--", &file])
                    .output()
            }
            .map_err(|error| error.to_string())?;
            let patch = String::from_utf8_lossy(&patch.stdout).into_owned();
            let additions = patch
                .lines()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++ "))
                .count();
            let deletions = patch
                .lines()
                .filter(|line| line.starts_with('-') && !line.starts_with("--- "))
                .count();
            files.push(WorkingDiff {
                file,
                patch,
                additions,
                deletions,
                status,
            });
        }
        Ok(files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedWorktree {
    path: String,
    branch: String,
    base: String,
}

fn git_reference(repository: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn worktree_base(repository: &Path) -> String {
    if let Some(reference) = git_reference(
        repository,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        return reference;
    }
    for reference in ["origin/main", "origin/master", "main", "master"] {
        if git_reference(repository, &["rev-parse", "--verify", reference]).is_some() {
            return reference.to_string();
        }
    }
    if let Some(worktrees) = git_reference(repository, &["worktree", "list", "--porcelain"]) {
        if let Some(branch) = worktrees.split("\n\n").next().and_then(|entry| {
            entry
                .lines()
                .find_map(|line| line.strip_prefix("branch refs/heads/"))
        }) {
            return branch.to_string();
        }
    }
    "HEAD".to_string()
}

fn repository_namespace(repository: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in repository.to_string_lossy().as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    let name = repository.file_name().unwrap_or_default().to_string_lossy();
    format!("{name}-{hash:016x}")
}

#[tauri::command]
fn create_worktree(
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
) -> Result<CreatedWorktree, String> {
    let repository = validate_repository(repository)?;
    let repository = Path::new(&repository);
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(
            "Use 1–64 letters, numbers, dashes, or underscores for the worktree name.".to_string(),
        );
    }
    let valid_branch = Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(|_| "Git is unavailable. Install Git to create a worktree.".to_string())?;
    if !valid_branch.status.success() {
        return Err("This name is not a valid Git branch name.".to_string());
    }
    let parent = match destination_parent {
        Some(path) => {
            let parent = Path::new(&path)
                .canonicalize()
                .map_err(|_| "Worktree destination does not exist.".to_string())?;
            if !parent.is_dir() {
                return Err("Worktree destination is not a directory.".to_string());
            }
            parent
        }
        None => {
            let root = if let Some(root) = std::env::var_os("SAIL_WORKTREE_ROOT") {
                let root = PathBuf::from(root);
                if !root.is_absolute() {
                    return Err("SAIL_WORKTREE_ROOT must be an absolute path.".to_string());
                }
                root
            } else {
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .ok_or("Home directory is unavailable. Choose a worktree destination.")?;
                Path::new(&home).join("sail").join("worktrees")
            };
            root.join(repository_namespace(repository))
        }
    };
    let path = parent.join(name);
    if path.exists() {
        return Err("A folder with this worktree name already exists.".to_string());
    }
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create worktree folder: {error}"))?;
    let base = if let Some(reference) = base_ref.filter(|value| !value.trim().is_empty()) {
        let reference = reference.trim();
        if reference.starts_with('-')
            || git_reference(repository, &["rev-parse", "--verify", reference]).is_none()
        {
            return Err("Base branch or reference does not exist.".to_string());
        }
        reference.to_string()
    } else {
        worktree_base(repository)
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["worktree", "add", "-b", name])
        .arg(&path)
        .arg(&base)
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot create worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve new worktree: {error}"))?;
    Ok(CreatedWorktree {
        path: path.to_string_lossy().into_owned(),
        branch: name.to_string(),
        base,
    })
}

#[tauri::command]
fn delete_worktree(repository: String, worktree: String) -> Result<(), String> {
    let repository = PathBuf::from(validate_repository(repository)?)
        .canonicalize()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let worktree = Path::new(&worktree)
        .canonicalize()
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    if worktree == repository {
        return Err("Cannot delete the main repository.".to_string());
    }
    let listed = git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    let registered = listed
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "));
    if !registered.into_iter().any(|path| {
        Path::new(path)
            .canonicalize()
            .is_ok_and(|registered| registered == worktree)
    }) {
        return Err("This folder is not a worktree of the selected repository.".to_string());
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args([
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
        ])
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !status.status.success() {
        return Err("Cannot inspect worktree files before deletion.".to_string());
    }
    if String::from_utf8_lossy(&status.stdout)
        .lines()
        .any(|line| line.starts_with("!! "))
    {
        return Err("Worktree has ignored files. Move or remove them before deleting.".to_string());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&repository)
        .args(["worktree", "remove"])
        .arg(&worktree)
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot delete worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[tauri::command]
fn local_plugin_version(path: String) -> Option<String> {
    let source = Path::new(&path);
    let directory = if source.is_dir() {
        source
    } else {
        source.parent()?
    };
    let package_path = directory.join("package.json");
    let metadata = std::fs::metadata(&package_path).ok()?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let package = std::fs::read_to_string(package_path).ok()?;
    let package: serde_json::Value = serde_json::from_str(&package).ok()?;
    if package.get("name")?.as_str()? != "@smykla-skalski/opencode-plugin-plan-review" {
        return None;
    }
    package.get("version")?.as_str().map(str::to_string)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|_app| {
            #[cfg(any(target_os = "macos", windows))]
            configure_pane_menu(_app.handle())?;
            Ok(())
        })
        .manage(RuntimeManager::default())
        .manage(acp::AgentManager::default())
        .manage(terminal::TerminalManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::migrate_settings,
            settings::save_setting,
            start_runtime,
            validate_repository,
            working_tree_diff,
            create_worktree,
            delete_worktree,
            local_plugin_version,
            acp::acp_agents,
            acp::acp_connect,
            acp::acp_new_session,
            acp::acp_load_session,
            acp::acp_prompt,
            acp::acp_cancel,
            acp::acp_permission,
            acp::acp_pending_permissions,
            acp::acp_pending_inbox,
            acp::acp_activity,
            acp::acp_set_config,
            acp::acp_authenticate,
            attention::show_attention_notification,
            attention::set_attention_badge,
            terminal::terminal_open,
            terminal::terminal_detach,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_open_file,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_visibility,
            browser::browser_devtools,
            browser::browser_close,
            browser::browser_shortcut,
            browser::browser_route
        ]);
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .run(tauri::generate_context!())
        .expect("failed to run Sail");
}

#[cfg(test)]
mod tests {
    use super::{repository_namespace, server_args, version_number};
    use std::path::Path;

    #[test]
    fn same_named_repositories_have_distinct_worktree_folders() {
        assert_ne!(
            repository_namespace(Path::new("/first/service")),
            repository_namespace(Path::new("/second/service"))
        );
    }

    #[test]
    fn accepts_real_opencode_version_output() {
        assert_eq!(version_number("opencode v2.0.19\n"), Some("2.0.19"));
        assert_eq!(version_number("2.1.0\n"), Some("2.1.0"));
    }

    #[test]
    fn server_is_loopback_and_only_allows_packaged_origins_in_release() {
        let args = server_args();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--hostname", "127.0.0.1"]));
        assert!(args.windows(2).any(|pair| pair == ["--port", "0"]));
        assert!(args.contains(&"tauri://localhost"));
        assert!(args.contains(&"http://tauri.localhost"));
        if !cfg!(debug_assertions) {
            assert!(!args.contains(&"http://localhost:1420"));
            assert!(!args.contains(&"http://127.0.0.1:1420"));
        }
    }
}
