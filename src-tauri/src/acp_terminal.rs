use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct AcpTerminalManager {
    active: Mutex<HashMap<String, Arc<AcpTerminal>>>,
    archived: Mutex<VecDeque<(String, TerminalSnapshot)>>,
}

impl AcpTerminalManager {
    pub fn server_roots(&self) -> Vec<(PathBuf, u32)> {
        self.active
            .lock()
            .ok()
            .map(|active| {
                active
                    .values()
                    .filter_map(|terminal| {
                        let mut child = terminal.child.lock().ok()?;
                        if child.try_wait().ok()?.is_some() {
                            return None;
                        }
                        Some((terminal.directory.clone(), child.id()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn stop_agent(&self, agent: &str) {
        let terminals = self
            .active
            .lock()
            .ok()
            .map(|active| {
                active
                    .iter()
                    .filter(|(_, terminal)| terminal.agent == agent)
                    .map(|(id, terminal)| (id.clone(), Arc::clone(terminal)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (id, terminal) in terminals {
            let _ = self.archive(id, &terminal);
        }
    }

    fn archive(&self, id: String, terminal: &AcpTerminal) -> Result<(), String> {
        stop(terminal)?;
        {
            let mut output = terminal.output.lock().map_err(|error| error.to_string())?;
            output.released = true;
            terminal.changed.notify_all();
            for _ in 0..20 {
                if output.exit.is_some() {
                    break;
                }
                let (next, _) = terminal
                    .changed
                    .wait_timeout(output, Duration::from_millis(50))
                    .map_err(|error| error.to_string())?;
                output = next;
            }
        }
        let mut archived = snapshot(terminal)?;
        if archived.output.len() > 256 * 1024 {
            let mut start = archived.output.len() - 256 * 1024;
            while !archived.output.is_char_boundary(start) {
                start += 1;
            }
            archived.output = archived.output[start..].to_string();
            archived.truncated = true;
        }
        self.active
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&id);
        let mut history = self.archived.lock().map_err(|error| error.to_string())?;
        history.push_back((id, archived));
        while history.len() > 128 {
            history.pop_front();
        }
        Ok(())
    }
}

impl Drop for AcpTerminalManager {
    fn drop(&mut self) {
        if let Ok(terminals) = self.active.lock() {
            for terminal in terminals.values() {
                let _ = stop(terminal);
            }
        }
    }
}

struct AcpTerminal {
    agent: String,
    session_id: String,
    directory: PathBuf,
    child: Mutex<Child>,
    output: Mutex<TerminalOutput>,
    changed: Condvar,
    limit: usize,
}

struct TerminalOutput {
    bytes: VecDeque<u8>,
    truncated: bool,
    exit: Option<ExitStatus>,
    released: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitStatus {
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    session_id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvVariable>,
    cwd: Option<String>,
    output_byte_limit: Option<usize>,
}

#[derive(Deserialize)]
struct EnvVariable {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalParams {
    session_id: String,
    terminal_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    output: String,
    truncated: bool,
    exit_status: Option<ExitStatus>,
    released: bool,
}

fn append(session: &AcpTerminal, bytes: &[u8]) {
    if let Ok(mut output) = session.output.lock() {
        output.bytes.extend(bytes);
        if output.bytes.len() > session.limit {
            let excess = output.bytes.len() - session.limit;
            output.bytes.drain(..excess);
            output.truncated = true;
            while output
                .bytes
                .front()
                .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
            {
                output.bytes.pop_front();
            }
        }
        session.changed.notify_all();
    }
}

fn snapshot(session: &AcpTerminal) -> Result<TerminalSnapshot, String> {
    let output = session.output.lock().map_err(|error| error.to_string())?;
    let bytes: Vec<u8> = output.bytes.iter().copied().collect();
    Ok(TerminalSnapshot {
        output: String::from_utf8_lossy(&bytes).into_owned(),
        truncated: output.truncated,
        exit_status: output.exit.clone(),
        released: output.released,
    })
}

fn session(
    manager: &AcpTerminalManager,
    agent: &str,
    params: Value,
) -> Result<Arc<AcpTerminal>, String> {
    let params: TerminalParams =
        serde_json::from_value(params).map_err(|error| error.to_string())?;
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&params.terminal_id)
        .cloned()
        .ok_or("Unknown terminal ID.")?;
    if terminal.agent != agent || terminal.session_id != params.session_id {
        return Err("Unknown terminal ID.".to_string());
    }
    if terminal
        .output
        .lock()
        .map_err(|error| error.to_string())?
        .released
    {
        return Err("Terminal was released.".to_string());
    }
    Ok(terminal)
}

fn stop(terminal: &AcpTerminal) -> Result<(), String> {
    let mut child = terminal.child.lock().map_err(|error| error.to_string())?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL)
                .map_err(|error| error.to_string())?;
        }
        #[cfg(windows)]
        Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn handle(
    app: &AppHandle,
    manager: &AcpTerminalManager,
    agent: &str,
    method: &str,
    params: Value,
    session_directory: Option<PathBuf>,
) -> Result<Value, String> {
    if method == "terminal/create" {
        let params: CreateParams =
            serde_json::from_value(params).map_err(|error| error.to_string())?;
        if params.command.is_empty()
            || params.command.contains('\0')
            || params.session_id.is_empty()
        {
            return Err("Command and session ID are required.".to_string());
        }
        if params.args.iter().any(|arg| arg.contains('\0'))
            || params.env.iter().any(|variable| {
                variable.name.is_empty()
                    || variable.name.contains(['=', '\0'])
                    || variable.value.contains('\0')
            })
        {
            return Err("Command arguments or environment are invalid.".to_string());
        }
        let fallback = session_directory
            .ok_or("Unknown agent session.")?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let directory = params.cwd.as_deref().map(Path::new).unwrap_or(&fallback);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(
                "Terminal working directory must be an existing absolute folder.".to_string(),
            );
        }
        let mut command = Command::new(&params.command);
        command.args(&params.args).current_dir(directory);
        #[cfg(unix)]
        command.process_group(0);
        for variable in params.env {
            command.env(variable.name, variable.value);
        }
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot start command: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Command stdout is unavailable.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Command stderr is unavailable.")?;
        let id = format!(
            "{}-{}",
            std::process::id(),
            NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed)
        );
        let terminal = Arc::new(AcpTerminal {
            agent: agent.to_string(),
            session_id: params.session_id.clone(),
            directory: fallback.clone(),
            child: Mutex::new(child),
            output: Mutex::new(TerminalOutput {
                bytes: VecDeque::new(),
                truncated: false,
                exit: None,
                released: false,
            }),
            changed: Condvar::new(),
            limit: params
                .output_byte_limit
                .unwrap_or(1024 * 1024)
                .min(16 * 1024 * 1024),
        });
        manager
            .active
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), Arc::clone(&terminal));
        let readers_done = Arc::new(AtomicU64::new(0));
        for mut stream in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
            let terminal = Arc::clone(&terminal);
            let done = Arc::clone(&readers_done);
            std::thread::spawn(move || {
                let mut buffer = [0; 8192];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(size) => append(&terminal, &buffer[..size]),
                    }
                }
                done.fetch_add(1, Ordering::Release);
            });
        }
        let waiting = Arc::clone(&terminal);
        std::thread::spawn(move || loop {
            let status = waiting
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok())
                .flatten();
            if let Some(status) = status {
                for _ in 0..20 {
                    if readers_done.load(Ordering::Acquire) == 2 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                #[cfg(unix)]
                let signal = std::os::unix::process::ExitStatusExt::signal(&status)
                    .and_then(|signal| nix::sys::signal::Signal::try_from(signal).ok())
                    .map(|signal| format!("{signal:?}"));
                #[cfg(not(unix))]
                let signal = None;
                if let Ok(mut output) = waiting.output.lock() {
                    output.exit = Some(ExitStatus {
                        exit_code: status.code(),
                        signal,
                    });
                    waiting.changed.notify_all();
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        });
        let _ = app.emit(
            "acp-terminal-created",
            json!({
                "agent": agent,
                "sessionId": params.session_id,
                "terminalId": id,
                "command": params.command,
                "directory": directory,
            }),
        );
        return Ok(json!({"terminalId":id}));
    }
    let terminal_id = params
        .get("terminalId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let terminal = session(manager, agent, params)?;
    match method {
        "terminal/output" => {
            let snapshot = snapshot(&terminal)?;
            let mut result = json!({
                "output": snapshot.output,
                "truncated": snapshot.truncated,
            });
            if let Some(status) = snapshot.exit_status {
                result["exitStatus"] = json!(status);
            }
            Ok(result)
        }
        "terminal/wait_for_exit" => {
            let mut output = terminal.output.lock().map_err(|error| error.to_string())?;
            while output.exit.is_none() && !output.released {
                output = terminal
                    .changed
                    .wait(output)
                    .map_err(|error| error.to_string())?;
            }
            output
                .exit
                .clone()
                .map(|status| json!(status))
                .ok_or("Terminal was released.".to_string())
        }
        "terminal/kill" => {
            stop(&terminal)?;
            Ok(json!({}))
        }
        "terminal/release" => {
            manager.archive(terminal_id, &terminal)?;
            Ok(json!({}))
        }
        _ => Err("Unknown terminal method.".to_string()),
    }
}

#[tauri::command]
pub fn acp_terminal_snapshot(
    manager: State<'_, AcpTerminalManager>,
    id: String,
) -> Result<TerminalSnapshot, String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = terminal {
        return snapshot(&terminal);
    }
    manager
        .archived
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .find(|(stored, _)| stored == &id)
        .map(|(_, snapshot)| snapshot.clone())
        .ok_or("Terminal is no longer available.".to_string())
}

#[tauri::command]
pub fn acp_terminal_stop(manager: State<'_, AcpTerminalManager>, id: String) -> Result<(), String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is no longer available.")?;
    stop(&terminal)
}
