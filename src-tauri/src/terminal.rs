use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
pub struct TerminalSize {
    cols: u16,
    rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: u32 },
}

struct TerminalOutput {
    history: VecDeque<u8>,
    #[cfg(windows)]
    current_directory: PathBuf,
    #[cfg(windows)]
    osc_tail: Vec<u8>,
    exit_code: Option<u32>,
    subscriber: Option<(String, Channel<TerminalEvent>)>,
}

struct TerminalSession {
    directory: PathBuf,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    process_id: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<Mutex<TerminalOutput>>,
}

impl TerminalSession {
    fn stop(&self) {
        if self
            .output
            .lock()
            .is_ok_and(|output| output.exit_code.is_some())
        {
            return;
        }
        #[cfg(unix)]
        {
            if let Ok(master) = self.master.lock() {
                if let Some(group) = master.process_group_leader() {
                    let group = nix::unistd::Pid::from_raw(group);
                    if group.as_raw() > 0 && group != nix::unistd::getpgrp() {
                        let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGTERM);
                    }
                }
            }
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

fn default_editor() -> String {
    #[cfg(target_os = "macos")]
    {
        for candidate in [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Zed.app/Contents/MacOS/cli",
        ] {
            if Path::new(candidate).is_file() {
                return shell_words::quote(candidate).into_owned();
            }
        }
    }
    "code".to_string()
}

#[cfg(test)]
mod tests {
    use super::default_editor;

    #[test]
    fn default_editor_path_survives_argument_parsing() {
        let editor = default_editor();
        let parts = shell_words::split(&editor).expect("valid default editor");
        assert_eq!(parts.len(), 1);
    }
}

fn editor_program(program: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    if !Path::new(program).is_absolute() {
        let candidate = match program {
            "code" => Some("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
            "zed" => Some("/Applications/Zed.app/Contents/MacOS/cli"),
            _ => None,
        };
        if let Some(candidate) = candidate.filter(|path| Path::new(path).is_file()) {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from(program)
}

#[derive(Default)]
pub struct TerminalManager(Mutex<HashMap<String, Arc<TerminalSession>>>);

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(sessions) = self.0.lock() {
            for session in sessions.values() {
                session.stop();
            }
        }
    }
}

fn shell() -> PathBuf {
    #[cfg(windows)]
    return std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    #[cfg(not(windows))]
    return std::env::var_os("SHELL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
}

fn spawn(
    directory: PathBuf,
    cols: u16,
    rows: u16,
    script: Option<&str>,
) -> Result<TerminalSession, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new(shell());
    #[cfg(not(windows))]
    if let Some(script) = script {
        command.arg("-lc");
        command.arg(script);
    } else {
        command.arg("-l");
    }
    #[cfg(windows)]
    if let Some(script) = script {
        command.arg("/C");
        command.arg(script);
    }
    command.cwd(&directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    command.env("PROMPT", "$E]9;9;$P$E\\$P$G");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let output = Arc::new(Mutex::new(TerminalOutput {
        history: VecDeque::new(),
        #[cfg(windows)]
        current_directory: directory.clone(),
        #[cfg(windows)]
        osc_tail: Vec::new(),
        exit_code: None,
        subscriber: None,
    }));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let process_id = child.process_id();
    let killer = child.clone_killer();
    let child = Arc::new(Mutex::new(child));
    let background_output = Arc::clone(&output);
    let background_child = Arc::clone(&child);
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if let Ok(mut state) = background_output.lock() {
                        state.history.extend(&buffer[..size]);
                        let excess = state.history.len().saturating_sub(MAX_OUTPUT);
                        state.history.drain(..excess);
                        #[cfg(windows)]
                        update_windows_directory(&mut state, &buffer[..size]);
                        if let Some((_, channel)) = &state.subscriber {
                            let _ = channel.send(TerminalEvent::Output {
                                data: buffer[..size].to_vec(),
                            });
                        }
                    }
                }
            }
        }
        let code = background_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code())
            .unwrap_or(1);
        if let Ok(mut state) = background_output.lock() {
            state.exit_code = Some(code);
            if let Some((_, channel)) = &state.subscriber {
                let _ = channel.send(TerminalEvent::Exit { code });
            }
        }
    });
    Ok(TerminalSession {
        directory,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        process_id,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        output,
    })
}

#[tauri::command]
pub fn terminal_open(
    manager: State<'_, TerminalManager>,
    id: String,
    directory: String,
    command: Option<String>,
    size: TerminalSize,
    attachment: String,
    on_event: Channel<TerminalEvent>,
) -> Result<(), String> {
    let TerminalSize { cols, rows } = size;
    if id.is_empty() {
        return Err("Terminal ID is required".to_string());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Terminal directory is not a folder".to_string());
    }
    let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
    let session = if let Some(session) = sessions.get(&id) {
        if session.directory != directory {
            return Err("Terminal belongs to another directory".to_string());
        }
        Arc::clone(session)
    } else {
        if command
            .as_ref()
            .is_some_and(|script| script.trim().is_empty())
        {
            return Err("Command is empty".to_string());
        }
        let session = Arc::new(spawn(directory, cols, rows, command.as_deref())?);
        sessions.insert(id, Arc::clone(&session));
        session
    };
    drop(sessions);
    session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut output = session.output.lock().map_err(|error| error.to_string())?;
    output.subscriber = Some((attachment, on_event.clone()));
    for slice in [output.history.as_slices().0, output.history.as_slices().1] {
        for chunk in slice.chunks(8192) {
            on_event
                .send(TerminalEvent::Output {
                    data: chunk.to_vec(),
                })
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(code) = output.exit_code {
        on_event
            .send(TerminalEvent::Exit { code })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_detach(
    manager: State<'_, TerminalManager>,
    id: String,
    attachment: String,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(session) = session {
        let mut output = session.output.lock().map_err(|error| error.to_string())?;
        if output
            .subscriber
            .as_ref()
            .is_some_and(|(current, _)| current == &attachment)
        {
            output.subscriber = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .writer
        .lock()
        .map_err(|error| error.to_string())?
        .write_all(&data)
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub fn terminal_close(manager: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if let Some(session) = session {
        session.stop();
    }
    Ok(())
}

fn shell_directory(session: &TerminalSession) -> PathBuf {
    #[cfg(windows)]
    if let Ok(output) = session.output.lock() {
        return output.current_directory.clone();
    }
    #[cfg(target_os = "linux")]
    if let Some(pid) = session.process_id {
        if let Ok(directory) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            return directory;
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(pid) = session.process_id {
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        {
            if output.status.success() {
                if let Some(directory) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .find_map(|line| line.strip_prefix('n'))
                {
                    return PathBuf::from(directory);
                }
            }
        }
    }
    session.directory.clone()
}

#[cfg(windows)]
fn update_windows_directory(output: &mut TerminalOutput, bytes: &[u8]) {
    output.osc_tail.extend_from_slice(bytes);
    for start in 0..output.osc_tail.len().saturating_sub(3) {
        if !output.osc_tail[start..].starts_with(b"\x1b]9;9;") {
            continue;
        }
        if let Some(end) = output.osc_tail[start + 6..]
            .windows(2)
            .position(|pair| pair == b"\x1b\\")
        {
            let path = &output.osc_tail[start + 6..start + 6 + end];
            if let Ok(path) = std::str::from_utf8(path) {
                let directory = PathBuf::from(path);
                if directory.is_dir() {
                    output.current_directory = directory;
                }
            }
        }
    }
    if output.osc_tail.len() > 8192 {
        let excess = output.osc_tail.len() - 8192;
        output.osc_tail.drain(..excess);
    }
}

#[tauri::command]
pub fn terminal_open_file(
    manager: State<'_, TerminalManager>,
    id: String,
    path: String,
    line: u32,
) -> Result<(), String> {
    if line == 0 {
        return Err("Line number must be positive".to_string());
    }
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let directory = shell_directory(&session);
    let candidate = Path::new(&path);
    let file = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        directory.join(candidate)
    }
    .canonicalize()
    .map_err(|error| error.to_string())?;
    if !file.is_file() {
        return Err("Terminal link is not a file".to_string());
    }
    let editor = std::env::var("SAIL_EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| default_editor());
    let parts = shell_words::split(&editor).map_err(|error| error.to_string())?;
    let (program, arguments) = parts.split_first().ok_or("Editor is empty")?;
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    let terminal_editor = ["vim", "nvim", "vi", "nano", "emacs"].contains(&name);
    let mut command = if terminal_editor {
        #[cfg(target_os = "macos")]
        {
            let ghostty = Path::new("/Applications/Ghostty.app/Contents/MacOS/ghostty");
            if ghostty.is_file() {
                let mut command = Command::new(ghostty);
                command.arg("-e").arg(program);
                command
            } else {
                let invocation = std::iter::once(program.as_str())
                    .chain(arguments.iter().map(String::as_str))
                    .chain(
                        [format!("+{line}"), file.to_string_lossy().into_owned()]
                            .iter()
                            .map(String::as_str),
                    )
                    .map(shell_words::quote)
                    .collect::<Vec<_>>()
                    .join(" ");
                Command::new("/usr/bin/osascript")
                    .args([
                        "-e",
                        "on run argv",
                        "-e",
                        "tell application \"Terminal\" to do script (item 1 of argv)",
                        "-e",
                        "end run",
                        "--",
                        &invocation,
                    ])
                    .spawn()
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut command = Command::new("x-terminal-emulator");
            command.arg("-e").arg(program);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("wt.exe");
            command.arg(program);
            command
        }
    } else {
        Command::new(editor_program(program))
    };
    command.args(arguments);
    if ["code", "codium", "cursor"].contains(&name) {
        command.arg("--goto");
        command.arg(format!("{}:{line}", file.display()));
    } else if terminal_editor {
        command.arg(format!("+{line}"));
        command.arg(file);
    } else {
        command.arg(format!("{}:{line}", file.display()));
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
