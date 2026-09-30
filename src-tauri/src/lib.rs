use serde::Serialize;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    url: String,
    password: String,
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

#[tauri::command]
fn start_runtime(
    manager: State<'_, RuntimeManager>,
    binary_path: Option<String>,
) -> Result<RuntimeInfo, String> {
    let mut runtime = manager.0.lock().map_err(|error| error.to_string())?;
    let binary = match binary_path.filter(|path| !path.trim().is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("OpenCode binary path must be absolute.".to_string());
            }
            path.into_os_string()
        }
        None => std::env::var_os("SAI_OPENCODE_BIN").unwrap_or_else(|| "opencode".into()),
    };
    if let Some(existing) = runtime.as_mut() {
        if existing.binary == binary && existing.child.try_wait().ok().flatten().is_none() {
            return Ok(existing.info.clone());
        }
    }
    *runtime = None;

    let version = Command::new(&binary)
        .arg("--version")
        .output()
        .map_err(|_| {
            "OpenCode binary not found or cannot run. Choose an absolute binary path and retry."
                .to_string()
        })?;
    let version_text = String::from_utf8_lossy(&version.stdout);
    let version_number = version_text.split_whitespace().last().unwrap_or("");
    if !version.status.success() || !version_number.starts_with("2.") {
        return Err(format!(
            "OpenCode v2 is required (found {}). Choose a compatible binary and retry.",
            if version_number
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.')
                && !version_number.is_empty()
            {
                version_number
            } else {
                "an incompatible binary"
            }
        ));
    }

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
                    });
                }
            }
        }
    });

    let info = match receiver.recv_timeout(Duration::from_secs(15)) {
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
