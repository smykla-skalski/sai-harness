use crate::browser_agent::BrowserManager;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, Window};

#[derive(Clone, Copy, Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BrowserBounds {
    fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width >= 1.0
            && self.height >= 1.0
        {
            Ok(self)
        } else {
            Err("Invalid browser bounds".to_string())
        }
    }

    fn in_window(self, window: &Window) -> Result<Self, String> {
        let main = window
            .get_webview("main")
            .ok_or("Main webview is missing")?;
        let main_bounds = main.bounds().map_err(|error| error.to_string())?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let origin = main_bounds.position.to_logical::<f64>(scale);
        #[cfg(target_os = "macos")]
        let main_size = main_bounds.size.to_logical::<f64>(scale);
        #[cfg(target_os = "macos")]
        let outer = window.outer_size().map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        let outer = outer.to_logical::<f64>(scale);
        #[cfg(target_os = "macos")]
        let titlebar = (outer.height - main_size.height).max(0.0);
        #[cfg(target_os = "macos")]
        let titlebar = if window.is_fullscreen().map_err(|error| error.to_string())? {
            0.0
        } else {
            titlebar.max(32.0)
        };
        #[cfg(not(target_os = "macos"))]
        let titlebar = 0.0;
        Ok(Self {
            x: self.x + origin.x,
            y: self.y + origin.y + titlebar,
            ..self
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct BrowserShortcutEvent {
    label: String,
    action: String,
}

#[derive(Clone, Serialize)]
struct BrowserRouteEvent {
    label: String,
    url: String,
    mode: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedElement {
    #[serde(default)]
    label: String,
    url: String,
    html: String,
    styles: HashMap<String, String>,
    rect: PickRect,
    viewport: PickViewport,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PickRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PickViewport {
    width: f64,
    height: f64,
}

pub struct CaptureStore {
    root: PathBuf,
    files: Mutex<HashSet<PathBuf>>,
    attachments: Mutex<HashSet<PathBuf>>,
}

impl Default for CaptureStore {
    fn default() -> Self {
        Self {
            root: std::env::temp_dir().join(format!("sail-picks-{}", uuid::Uuid::new_v4())),
            files: Mutex::new(HashSet::new()),
            attachments: Mutex::new(HashSet::new()),
        }
    }
}

#[tauri::command]
pub fn clipboard_save_file(
    store: State<'_, CaptureStore>,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Clipboard file must be between 1 byte and 20 MiB".to_string());
    }
    let name = std::path::Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or("Invalid clipboard file name")?;
    let name = name.replace(['/', '\\', ':'], "_");
    let root = store.root.join("clipboard");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{}-{name}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    store
        .attachments
        .lock()
        .map_err(|error| error.to_string())?
        .insert(path.clone());
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clipboard_remove_file(store: State<'_, CaptureStore>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !store
        .attachments
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&path)
    {
        return Err("Unknown clipboard file".to_string());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

impl Drop for CaptureStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl CaptureStore {
    pub fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let path = PathBuf::from(path);
        if !self
            .files
            .lock()
            .map_err(|error| error.to_string())?
            .contains(&path)
        {
            return Err("Unknown browser capture".to_string());
        }
        std::fs::read(path).map_err(|error| error.to_string())
    }
}

const SHORTCUT_SCRIPT: &str = r#"
  (() => {
    const route = (mode) => window.__TAURI_INTERNALS__?.invoke('browser_route', {
      mode,
      url: location.href,
    });
    for (const mode of ['pushState', 'replaceState']) {
      const original = history[mode];
      history[mode] = function (...args) {
        const result = original.apply(this, args);
        route(mode === 'pushState' ? 'push' : 'replace');
        return result;
      };
    }
    window.addEventListener('popstate', () => route('pop'));
    window.addEventListener('hashchange', () => route('pop'));
    let observedUrl = location.href;
    setInterval(() => {
      if (location.href === observedUrl) return;
      observedUrl = location.href;
      route('push');
    }, 250);
  })();
  document.addEventListener('keydown', (event) => {
    if (event.shiftKey) return;
    const direction = event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
    if (!(event.metaKey || event.ctrlKey) || !direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__TAURI_INTERNALS__?.invoke('browser_shortcut', {
      action: event.key.toLowerCase(),
    });
  }, true);
  document.addEventListener('pointerdown', () => {
    window.__TAURI_INTERNALS__?.invoke('browser_shortcut', { action: 'focus' });
  }, true);
  (() => {
    let active = false;
    let overlay;
    const clear = () => {
      active = false;
      overlay?.remove();
      overlay = undefined;
    };
    window.__sailPicker = (enabled) => {
      clear();
      active = enabled;
      if (!enabled) return;
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #60a5fa;background:#60a5fa33;box-sizing:border-box';
      document.documentElement.append(overlay);
    };
    document.addEventListener('pointermove', (event) => {
      if (!active || !overlay) return;
      const rect = event.target.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
    }, true);
    document.addEventListener('click', (event) => {
      if (!active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = event.target;
      if (!(element instanceof Element)) return;
      const box = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const styles = Object.fromEntries([
        'display', 'position', 'color', 'backgroundColor', 'fontFamily',
        'fontSize', 'fontWeight', 'lineHeight', 'padding', 'margin',
        'border', 'borderRadius', 'width', 'height',
      ].map((key) => [key, computed[key]]));
      const selection = {
        url: location.href, html: element.outerHTML.slice(0, 3000),
        styles,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { width: innerWidth, height: innerHeight },
      };
      clear();
      window.__TAURI_INTERNALS__?.invoke('browser_pick_selection', { selection });
    }, true);
    document.addEventListener('keydown', (event) => {
      if (!active || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clear();
      window.__TAURI_INTERNALS__?.invoke('browser_pick_cancel');
    }, true);
  })();
"#;

#[cfg(target_os = "linux")]
const CLOSE_SCRIPT: &str = r#"
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'w') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__TAURI_INTERNALS__?.invoke('browser_shortcut', { action: 'close' });
  }, true);
"#;

fn validate_label(value: &str) -> Result<&str, String> {
    if value.starts_with("browser-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(value)
    } else {
        Err("Invalid browser label".to_string())
    }
}

fn parse_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|error| error.to_string())?;
    if ["http", "https"].contains(&url.scheme()) {
        Ok(url)
    } else {
        Err("Browser URLs must use http or https".to_string())
    }
}

#[tauri::command]
pub async fn browser_open(
    window: Window,
    manager: State<'_, BrowserManager>,
    label: String,
    directory: String,
    pane_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    validate_label(&label)?;
    let url = parse_url(&url)?;
    let bounds = bounds.validate()?.in_window(&window)?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let navigation_window = window.clone();
        let load_window = window.clone();
        let navigation_label = label.clone();
        let load_label = label.clone();
        let registration_label = label.clone();
        let load_manager = manager.clone();
        let navigation_manager = manager.clone();
        let navigation_pane_id = pane_id.clone();
        let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .initialization_script(SHORTCUT_SCRIPT)
            .on_navigation(move |url| {
                if !["http", "https"].contains(&url.scheme()) {
                    return false;
                }
                if !navigation_manager.allow_navigation(&navigation_pane_id, url) {
                    return false;
                }
                navigation_manager.cancel_picker(&navigation_label);
                let _ = navigation_window.emit_to(
                    "main",
                    "browser:navigate",
                    BrowserEvent {
                        label: navigation_label.clone(),
                        url: url.to_string(),
                    },
                );
                true
            })
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    load_manager.loaded(&load_label, payload.url().as_str());
                    let _ = load_window.emit_to(
                        "main",
                        "browser:loaded",
                        BrowserEvent {
                            label: load_label.clone(),
                            url: payload.url().to_string(),
                        },
                    );
                }
            });
        #[cfg(target_os = "linux")]
        let builder = builder.initialization_script(CLOSE_SCRIPT);
        manager.register(&directory, &pane_id, &registration_label)?;
        let result = window.add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        );
        if let Err(error) = result {
            manager.unregister(&registration_label);
            return Err(error.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn browser_bounds(window: Window, label: String, bounds: BrowserBounds) -> Result<(), String> {
    let bounds = bounds.validate()?.in_window(&window)?;
    let webview = window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_navigate(
    window: Window,
    manager: State<'_, BrowserManager>,
    label: String,
    url: String,
) -> Result<(), String> {
    manager.clear_guard(&label);
    window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?
        .navigate(parse_url(&url)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_reload(
    window: Window,
    manager: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    manager.clear_guard(&label);
    window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_visibility(window: Window, label: String, visible: bool) -> Result<(), String> {
    let webview = window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_devtools(window: Window, label: String) -> Result<(), String> {
    window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?
        .open_devtools();
    Ok(())
}

#[tauri::command]
pub fn browser_close(
    window: Window,
    manager: State<'_, BrowserManager>,
    label: String,
) -> Result<(), String> {
    manager.unregister(&label);
    if let Some(webview) = window.get_webview(validate_label(&label)?) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_focus(manager: State<'_, BrowserManager>, label: String) -> Result<(), String> {
    validate_label(&label)?;
    manager.focus(&label);
    Ok(())
}

#[tauri::command]
pub fn browser_shortcut(webview: tauri::Webview, action: String) -> Result<(), String> {
    let label = validate_label(webview.label())?;
    if ![
        "focus",
        "close",
        "arrowleft",
        "arrowright",
        "arrowup",
        "arrowdown",
    ]
    .contains(&action.as_str())
    {
        return Err("Invalid browser action".to_string());
    }
    webview
        .emit_to(
            "main",
            "browser:shortcut",
            BrowserShortcutEvent {
                label: label.to_string(),
                action,
            },
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_picker(
    window: Window,
    manager: State<'_, BrowserManager>,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    let webview = window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser page is missing")?;
    manager.set_picker(&label, enabled)?;
    let result = webview
        .eval(format!("window.__sailPicker?.({enabled})"))
        .map_err(|error| error.to_string());
    if result.is_err() {
        manager.cancel_picker(&label);
    }
    result
}

#[tauri::command]
pub fn browser_pick_selection(
    webview: tauri::Webview,
    manager: State<'_, BrowserManager>,
    mut selection: PickedElement,
) -> Result<(), String> {
    selection.label = validate_label(webview.label())?.to_string();
    let url = parse_url(&selection.url)?;
    if url.origin() != webview.url().map_err(|error| error.to_string())?.origin() {
        return Err("Browser selection changed origin".to_string());
    }
    if selection.html.len() > 12000 {
        return Err("Browser selection is too large".to_string());
    }
    if selection.url.len() > 4096
        || selection.styles.len() > 32
        || selection
            .styles
            .iter()
            .any(|(key, value)| key.len() > 64 || value.len() > 2048)
        || selection
            .styles
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 16384
    {
        return Err("Browser selection styles are too large".to_string());
    }
    let bounds = [
        selection.rect.x,
        selection.rect.y,
        selection.rect.width,
        selection.rect.height,
        selection.viewport.width,
        selection.viewport.height,
    ];
    if bounds
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 100_000.0)
        || selection.rect.width <= 0.0
        || selection.rect.height <= 0.0
        || selection.viewport.width <= 0.0
        || selection.viewport.height <= 0.0
    {
        return Err("Invalid browser selection bounds".to_string());
    }
    manager.take_picker(&selection.label)?;
    webview
        .emit_to("main", "browser:picked", selection)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_pick_cancel(
    webview: tauri::Webview,
    manager: State<'_, BrowserManager>,
) -> Result<(), String> {
    let label = validate_label(webview.label())?;
    manager.cancel_picker(label);
    webview
        .emit_to("main", "browser:pick-cancel", label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_capture(window: Window, label: String) -> Result<String, String> {
    let webview = window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser page is missing")?;
    tauri::async_runtime::spawn_blocking(move || {
        let png = crate::browser_agent::screenshot(&webview)?;
        if png.len() > 20 * 1024 * 1024 {
            return Err("Browser snapshot exceeds 20 MiB.".to_string());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(png))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn browser_save_capture(store: State<'_, CaptureStore>, png: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Invalid browser capture".to_string());
    }
    std::fs::create_dir_all(&store.root).map_err(|error| error.to_string())?;
    let path = store
        .root
        .join(format!("picked-{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    store
        .files
        .lock()
        .map_err(|error| error.to_string())?
        .insert(path.clone());
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn browser_remove_capture(store: State<'_, CaptureStore>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !store
        .files
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&path)
    {
        return Err("Unknown browser capture".to_string());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_route(webview: tauri::Webview, mode: String, url: String) -> Result<(), String> {
    let label = validate_label(webview.label())?;
    if !["push", "replace", "pop"].contains(&mode.as_str()) {
        return Err("Invalid browser route action".to_string());
    }
    let url = parse_url(&url)?;
    let current = webview.url().map_err(|error| error.to_string())?;
    if url.origin() != current.origin() {
        return Err("Browser route changed origin".to_string());
    }
    webview
        .emit_to(
            "main",
            "browser:route",
            BrowserRouteEvent {
                label: label.to_string(),
                url: url.to_string(),
                mode,
            },
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod picker_tests {
    use super::{CaptureStore, PickedElement};

    #[test]
    fn rejects_untracked_local_image() {
        let path = std::env::temp_dir().join(format!("sail-test-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        let store = CaptureStore::default();
        assert!(store.read(path.to_str().unwrap()).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_malformed_selection_geometry() {
        let selection = serde_json::json!({
            "url":"http://localhost:3000",
            "html":"<button>Pick</button>",
            "styles":{"display":"block"},
            "rect":{"x":"invalid","y":0,"width":20,"height":20},
            "viewport":{"width":800,"height":600}
        });
        assert!(serde_json::from_value::<PickedElement>(selection).is_err());
    }
}
