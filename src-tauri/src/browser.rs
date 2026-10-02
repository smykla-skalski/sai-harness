use serde::{Deserialize, Serialize};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, Window};

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
    label: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    validate_label(&label)?;
    let url = parse_url(&url)?;
    let bounds = bounds.validate()?.in_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let navigation_window = window.clone();
        let load_window = window.clone();
        let navigation_label = label.clone();
        let load_label = label.clone();
        let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .initialization_script(SHORTCUT_SCRIPT)
            .on_navigation(move |url| {
                if !["http", "https"].contains(&url.scheme()) {
                    return false;
                }
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
        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|error| error.to_string())?;
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
pub fn browser_navigate(window: Window, label: String, url: String) -> Result<(), String> {
    window
        .get_webview(validate_label(&label)?)
        .ok_or("Browser tab is closed")?
        .navigate(parse_url(&url)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_reload(window: Window, label: String) -> Result<(), String> {
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
pub fn browser_close(window: Window, label: String) -> Result<(), String> {
    if let Some(webview) = window.get_webview(validate_label(&label)?) {
        webview.close().map_err(|error| error.to_string())?;
    }
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
