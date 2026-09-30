use serde::Serialize;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::State;

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

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct RuntimeManager(Mutex<Option<OwnedRuntime>>);

fn candidate_paths() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["opencode.exe"]
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
    let output = Command::new(binary)
        .arg("--version")
        .output()
        .map_err(|_| {
            "OpenCode binary not found or cannot run. Choose an absolute binary path in settings."
                .to_string()
        })?;
    let output_text = String::from_utf8_lossy(&output.stdout);
    let version = version_number(&output_text);
    if output.status.success() && version.is_some_and(|value| value.starts_with("2.")) {
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
    if let Some(path) = std::env::var_os("SAI_OPENCODE_BIN") {
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

#[tauri::command]
fn start_runtime(
    manager: State<'_, RuntimeManager>,
    binary_path: Option<String>,
) -> Result<RuntimeInfo, String> {
    let mut runtime = manager.0.lock().map_err(|error| error.to_string())?;
    let binary = resolve_binary(binary_path)?;
    if let Some(existing) = runtime.as_mut() {
        if existing.binary == binary && existing.child.try_wait().ok().flatten().is_none() {
            return Ok(existing.info.clone());
        }
    }
    *runtime = None;

    let mut child = Command::new(&binary)
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
            "--cors",
            "http://localhost:1420",
            "--cors",
            "http://127.0.0.1:1420",
            "--cors",
            "tauri://localhost",
            "--cors",
            "http://tauri.localhost",
        ])
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
            let _ = child.kill();
            let _ = child.wait();
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
    *runtime = Some(OwnedRuntime {
        child,
        info: info.clone(),
        binary,
    });
    Ok(info)
}

#[tauri::command]
fn stop_runtime(manager: State<'_, RuntimeManager>) -> Result<(), String> {
    *manager.0.lock().map_err(|error| error.to_string())? = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![start_runtime, stop_runtime])
        .run(tauri::generate_context!())
        .expect("failed to run SAI Harness");
}

#[cfg(test)]
mod tests {
    use super::version_number;

    #[test]
    fn accepts_real_opencode_version_output() {
        assert_eq!(version_number("opencode v2.0.19\n"), Some("2.0.19"));
        assert_eq!(version_number("2.1.0\n"), Some("2.1.0"));
    }
}
