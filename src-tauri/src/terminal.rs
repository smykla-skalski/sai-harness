use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: u32 },
}

struct TerminalOutput {
    history: Vec<u8>,
    exit_code: Option<u32>,
    subscriber: Option<(String, Channel<TerminalEvent>)>,
}

struct TerminalSession {
    directory: PathBuf,
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    output: Arc<Mutex<TerminalOutput>>,
}

impl TerminalSession {
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub struct TerminalManager(Mutex<HashMap<String, TerminalSession>>);

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

fn spawn(directory: PathBuf, cols: u16, rows: u16) -> Result<TerminalSession, String> {
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
    command.arg("-l");
    command.cwd(&directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
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
        history: Vec::new(),
        exit_code: None,
        subscriber: None,
    }));
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
                        state.history.extend_from_slice(&buffer[..size]);
                        if state.history.len() > MAX_OUTPUT {
                            let excess = state.history.len() - MAX_OUTPUT;
                            state.history.drain(..excess);
                        }
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
        master: pair.master,
        writer: Mutex::new(writer),
        child,
        output,
    })
}

#[tauri::command]
pub fn terminal_open(
    manager: State<'_, TerminalManager>,
    id: String,
    directory: String,
    cols: u16,
    rows: u16,
    attachment: String,
    on_event: Channel<TerminalEvent>,
) -> Result<(), String> {
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
    let session = if let Some(session) = sessions.get_mut(&id) {
        if session.directory != directory {
            return Err("Terminal belongs to another directory".to_string());
        }
        session
    } else {
        sessions.insert(id.clone(), spawn(directory, cols, rows)?);
        sessions.get_mut(&id).expect("terminal was inserted")
    };
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut output = session.output.lock().map_err(|error| error.to_string())?;
    output.subscriber = Some((attachment, on_event.clone()));
    if !output.history.is_empty() {
        on_event
            .send(TerminalEvent::Output {
                data: output.history.clone(),
            })
            .map_err(|error| error.to_string())?;
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
    let sessions = manager.0.lock().map_err(|error| error.to_string())?;
    if let Some(session) = sessions.get(&id) {
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
    let sessions = manager.0.lock().map_err(|error| error.to_string())?;
    let session = sessions.get(&id).ok_or("Terminal is closed")?;
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
    let sessions = manager.0.lock().map_err(|error| error.to_string())?;
    sessions
        .get(&id)
        .ok_or("Terminal is closed")?
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_close(manager: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
    if let Some(session) = sessions.remove(&id) {
        session.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_open_file(directory: String, path: String, line: u32) -> Result<(), String> {
    if line == 0 {
        return Err("Line number must be positive".to_string());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
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
        .unwrap_or_else(|_| "code".to_string());
    let parts = shell_words::split(&editor).map_err(|error| error.to_string())?;
    let (program, arguments) = parts.split_first().ok_or("Editor is empty")?;
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    let mut command = Command::new(program);
    command.args(arguments);
    if ["code", "codium", "cursor"].contains(&name) {
        command.arg("--goto");
        command.arg(format!("{}:{line}", file.display()));
    } else if ["vim", "nvim", "vi", "nano", "emacs"].contains(&name) {
        command.arg(format!("+{line}"));
        command.arg(file);
    } else {
        command.arg(format!("{}:{line}", file.display()));
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
