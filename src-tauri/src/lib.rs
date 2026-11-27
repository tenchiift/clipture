use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserSettings {
    open_at_login: Option<bool>,
    prioritize_clipture_shortcuts: Option<bool>,
    toggle_shortcut: Option<String>,
    drawer_shortcut: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfig {
    pub toggle_shortcut: String,
    pub drawer_shortcut: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPayload {
    pub kind: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub local_path: Option<String>,
    pub data_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMediaResult {
    pub local_path: String,
    pub size_bytes: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub data_url: Option<String>,
}

#[derive(Default)]
struct WatcherState {
    last_text: String,
    last_image_hash: String,
    last_file_path: String,
    suppress_until_ms: u128,
}

struct ActiveShortcuts {
    toggle_str: String,
    toggle: Shortcut,
    drawer_str: String,
    drawer: Shortcut,
}

impl Default for ActiveShortcuts {
    fn default() -> Self {
        let toggle_str = default_toggle_shortcut_str().to_string();
        let drawer_str = default_drawer_shortcut_str().to_string();
        Self {
            toggle: parse_shortcut_str(&toggle_str).unwrap_or_else(|_| {
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyV)
            }),
            toggle_str,
            drawer: parse_shortcut_str(&drawer_str).unwrap_or_else(|_| {
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyV)
            }),
            drawer_str,
        }
    }
}

struct TrayShortcutItems {
    toggle_item: MenuItem<tauri::Wry>,
    drawer_item: MenuItem<tauri::Wry>,
}

struct AppState {
    watcher: Mutex<WatcherState>,
    clips_io: Mutex<()>,
    shortcuts: Mutex<ActiveShortcuts>,
    tray_items: Mutex<Option<TrayShortcutItems>>,
    is_polling: AtomicBool,
    is_quitting: AtomicBool,
    prioritize_shortcuts: AtomicBool,
    auto_launch: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(WatcherState::default()),
            clips_io: Mutex::new(()),
            shortcuts: Mutex::new(ActiveShortcuts::default()),
            tray_items: Mutex::new(None),
            is_polling: AtomicBool::new(false),
            is_quitting: AtomicBool::new(false),
            prioritize_shortcuts: AtomicBool::new(true),
            auto_launch: AtomicBool::new(true),
        }
    }
}

fn default_toggle_shortcut_str() -> &'static str {
    "CmdOrCtrl+Shift+V"
}

fn default_drawer_shortcut_str() -> &'static str {
    "CmdOrCtrl+Alt+V"
}

fn parse_shortcut_str(input: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut key_code: Option<Code> = None;

    for raw_part in input.split('+') {
        let part = raw_part.trim();
        if part.is_empty() {
            continue;
        }
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "cmdorctrl" | "commandorcontrol" => {
                if cfg!(target_os = "macos") {
                    mods |= Modifiers::SUPER;
                } else {
                    mods |= Modifiers::CONTROL;
                }
            }
            "super" | "cmd" | "command" | "meta" | "win" => mods |= Modifiers::SUPER,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" | "opt" => mods |= Modifiers::ALT,
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            _ => {
                let code = match lower.as_str() {
                    "a" => Code::KeyA,
                    "b" => Code::KeyB,
                    "c" => Code::KeyC,
                    "d" => Code::KeyD,
                    "e" => Code::KeyE,
                    "f" => Code::KeyF,
                    "g" => Code::KeyG,
                    "h" => Code::KeyH,
                    "i" => Code::KeyI,
                    "j" => Code::KeyJ,
                    "k" => Code::KeyK,
                    "l" => Code::KeyL,
                    "m" => Code::KeyM,
                    "n" => Code::KeyN,
                    "o" => Code::KeyO,
                    "p" => Code::KeyP,
                    "q" => Code::KeyQ,
                    "r" => Code::KeyR,
                    "s" => Code::KeyS,
                    "t" => Code::KeyT,
                    "u" => Code::KeyU,
                    "v" => Code::KeyV,
                    "w" => Code::KeyW,
                    "x" => Code::KeyX,
                    "y" => Code::KeyY,
                    "z" => Code::KeyZ,
                    "0" => Code::Digit0,
                    "1" => Code::Digit1,
                    "2" => Code::Digit2,
                    "3" => Code::Digit3,
                    "4" => Code::Digit4,
                    "5" => Code::Digit5,
                    "6" => Code::Digit6,
                    "7" => Code::Digit7,
                    "8" => Code::Digit8,
                    "9" => Code::Digit9,
                    "space" => Code::Space,
                    "tab" => Code::Tab,
                    "enter" | "return" => Code::Enter,
                    "escape" | "esc" => Code::Escape,
                    "backquote" | "`" => Code::Backquote,
                    "minus" | "-" => Code::Minus,
                    "equal" | "=" => Code::Equal,
                    "bracketleft" | "[" => Code::BracketLeft,
                    "bracketright" | "]" => Code::BracketRight,
                    "backslash" | "\\" => Code::Backslash,
                    "semicolon" | ";" => Code::Semicolon,
                    "quote" | "'" => Code::Quote,
                    "comma" | "," => Code::Comma,
                    "period" | "." => Code::Period,
                    "slash" | "/" => Code::Slash,
                    "f1" => Code::F1,
                    "f2" => Code::F2,
                    "f3" => Code::F3,
                    "f4" => Code::F4,
                    "f5" => Code::F5,
                    "f6" => Code::F6,
                    "f7" => Code::F7,
                    "f8" => Code::F8,
                    "f9" => Code::F9,
                    "f10" => Code::F10,
                    "f11" => Code::F11,
                    "f12" => Code::F12,
                    _ => return Err(format!("Unsupported key: {}", part)),
                };
                key_code = Some(code);
            }
        }
    }

    if mods.is_empty() {
        return Err("Shortcut must include at least one modifier (Cmd/Ctrl/Alt/Shift)".to_string());
    }
    let code = key_code.ok_or_else(|| "Shortcut must include a key".to_string())?;
    Ok(Shortcut::new(Some(mods), code))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn set_restrictive_permissions(path: &Path, is_dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if is_dir { 0o700 } else { 0o600 };
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, is_dir);
    }
}

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("clipture"));
    let _ = fs::create_dir_all(&dir);
    set_restrictive_permissions(&dir, true);
    dir
}

fn media_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let dir = app_data_dir(app).join("clips-media");
    let _ = fs::create_dir_all(&dir);
    set_restrictive_permissions(&dir, true);
    dir
}

fn validate_media_path<R: Runtime>(app: &AppHandle<R>, local_path: &str) -> Option<PathBuf> {
    let root = fs::canonicalize(media_dir(app)).ok()?;
    let target = fs::canonicalize(Path::new(local_path)).ok()?;
    if target.starts_with(&root) && target.is_file() {
        Some(target)
    } else {
        None
    }
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app_data_dir(app).join("settings.json")
}

fn clips_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app_data_dir(app).join("clips.json")
}

fn read_settings<R: Runtime>(app: &AppHandle<R>) -> UserSettings {
    let p = settings_path(app);
    if let Ok(raw) = fs::read_to_string(p) {
        if let Ok(parsed) = serde_json::from_str::<UserSettings>(&raw) {
            return parsed;
        }
    }
    UserSettings::default()
}

fn write_settings<R: Runtime>(app: &AppHandle<R>, settings: &UserSettings) {
    let p = settings_path(app);
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        if fs::write(&p, json).is_ok() {
            set_restrictive_permissions(&p, false);
        }
    }
}

fn save_media_buffer<R: Runtime>(
    app: &AppHandle<R>,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let safe_name = Path::new(file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("clip.bin");
    let item_dir = media_dir(app).join(Uuid::new_v4().to_string());
    fs::create_dir_all(&item_dir).map_err(|e| e.to_string())?;
    set_restrictive_permissions(&item_dir, true);
    let dest = item_dir.join(safe_name);
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    set_restrictive_permissions(&dest, false);
    Ok(dest)
}

fn guess_mime_from_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "zip" => "application/zip",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(target_os = "macos")]
fn get_mac_finder_file_path() -> Option<String> {
    let output = Command::new("osascript")
        .args(["-e", "POSIX path of (the clipboard as «class furl»)"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let p = Path::new(&path_str);
    if !path_str.is_empty() && p.exists() && p.is_file() {
        Some(path_str)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn get_mac_finder_file_path() -> Option<String> {
    None
}

const MAX_CAPTURE_BYTES: usize = 50 * 1024 * 1024;

fn emit_file_from_path<R: Runtime>(app: &AppHandle<R>, file_path: &str) {
    let p = Path::new(file_path);
    if let Ok(meta) = fs::metadata(p) {
        if meta.len() >= MAX_CAPTURE_BYTES as u64 {
            return;
        }
    }
    let Ok(bytes) = fs::read(p) else {
        return;
    };
    if bytes.len() >= MAX_CAPTURE_BYTES {
        return;
    }
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mime_type = guess_mime_from_ext(ext).to_string();
    let is_image = mime_type.starts_with("image/") && mime_type != "image/svg+xml";
    let Ok(dest) = save_media_buffer(app, &file_name, &bytes) else {
        return;
    };

    let (width, height) = if is_image {
        image::load_from_memory(&bytes)
            .map(|img| (Some(img.width()), Some(img.height())))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let data_url = if is_image {
        Some(format!("data:{};base64,{}", mime_type, BASE64.encode(&bytes)))
    } else {
        None
    };

    let _ = app.emit(
        "clipboard:media-changed",
        MediaPayload {
            kind: if is_image { "image" } else { "file" }.to_string(),
            file_name,
            mime_type,
            size_bytes: bytes.len(),
            local_path: Some(dest.to_string_lossy().to_string()),
            data_url,
            width,
            height,
        },
    );
}

fn sync_last_seen(state: &AppState) {
    let Ok(mut cb) = arboard::Clipboard::new() else {
        return;
    };
    let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(text) = cb.get_text() {
        watcher.last_text = text;
    }
    if let Ok(img) = cb.get_image() {
        watcher.last_image_hash = sha256_hex(&img.bytes);
    }
}

fn poll_clipboard_once<R: Runtime>(app: &AppHandle<R>, force: bool) {
    let state = app.state::<AppState>();
    if state.is_polling.swap(true, Ordering::SeqCst) {
        return;
    }

    struct ResetFlag<'a>(&'a AtomicBool);
    impl<'a> Drop for ResetFlag<'a> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = ResetFlag(&state.is_polling);

    if !force {
        let suppress = state.watcher.lock().unwrap_or_else(|e| e.into_inner()).suppress_until_ms;
        if now_ms() < suppress {
            return;
        }
    }

    let Ok(mut cb) = arboard::Clipboard::new() else {
        return;
    };
    let current_text = cb.get_text().unwrap_or_default();

    // 1. Check for macOS Finder file copy
    if cfg!(target_os = "macos")
        && (force || (!current_text.is_empty() && current_text != state.watcher.lock().unwrap_or_else(|e| e.into_inner()).last_text))
        && !current_text.contains('\n')
        && current_text.len() < 260
    {
        if let Some(finder_path) = get_mac_finder_file_path() {
            let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
            watcher.last_text = current_text;
            if !force && finder_path == watcher.last_file_path {
                return;
            }
            watcher.last_file_path = finder_path.clone();
            drop(watcher);
            emit_file_from_path(app, &finder_path);
            return;
        }
    }

    // 2. Check for copied image
    if let Ok(img_data) = cb.get_image() {
        let hash = sha256_hex(&img_data.bytes);
        {
            let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
            if !force && hash == watcher.last_image_hash {
                return;
            }
            watcher.last_image_hash = hash;
            watcher.last_file_path.clear();
            watcher.last_text = current_text.clone();
        }

        if let Some(rgba) = RgbaImage::from_raw(
            img_data.width as u32,
            img_data.height as u32,
            img_data.bytes.into_owned(),
        ) {
            let mut png_bytes = Vec::new();
            if rgba
                .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                .is_ok()
                && png_bytes.len() < MAX_CAPTURE_BYTES
            {
                let file_name = format!("screenshot-{}.png", now_ms());
                if let Ok(dest) = save_media_buffer(app, &file_name, &png_bytes) {
                    let data_url =
                        format!("data:image/png;base64,{}", BASE64.encode(&png_bytes));
                    let _ = app.emit(
                        "clipboard:media-changed",
                        MediaPayload {
                            kind: "image".to_string(),
                            file_name,
                            mime_type: "image/png".to_string(),
                            size_bytes: png_bytes.len(),
                            local_path: Some(dest.to_string_lossy().to_string()),
                            data_url: Some(data_url),
                            width: Some(img_data.width as u32),
                            height: Some(img_data.height as u32),
                        },
                    );
                }
            }
        }
        return;
    }

    // 3. Plain text fallback
    if !current_text.is_empty() {
        let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if force || current_text != watcher.last_text {
            watcher.last_text = current_text.clone();
            watcher.last_file_path.clear();
            watcher.last_image_hash.clear();
            drop(watcher);
            let _ = app.emit("clipboard:changed", current_text);
        }
    }
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn position_popup_near_cursor<R: Runtime>(app: &AppHandle<R>, win: &tauri::WebviewWindow<R>) {
    let popup_w = 340.0_f64;
    let popup_h = 420.0_f64;
    let cursor = app.cursor_position().ok();

    let monitor = if let Some(c) = cursor {
        app.available_monitors()
            .ok()
            .and_then(|list| {
                list.into_iter().find(|m| {
                    let pos = m.position();
                    let size = m.size();
                    c.x >= pos.x as f64
                        && c.x < (pos.x + size.width as i32) as f64
                        && c.y >= pos.y as f64
                        && c.y < (pos.y + size.height as i32) as f64
                })
            })
            .or_else(|| app.primary_monitor().ok().flatten())
    } else {
        win.current_monitor()
            .ok()
            .flatten()
            .or_else(|| app.primary_monitor().ok().flatten())
    };

    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let screen_x = pos.x as f64 / scale;
        let screen_y = pos.y as f64 / scale;
        let screen_w = size.width as f64 / scale;
        let screen_h = size.height as f64 / scale;
        let top_pad = if cfg!(target_os = "macos") { 28.0 } else { 12.0 };
        let pad = 12.0;

        let (cx, cy) = match cursor {
            Some(c) => (c.x / scale, c.y / scale),
            None => (screen_x + screen_w / 2.0, screen_y + screen_h / 2.0),
        };

        let mut x = cx + 10.0;
        if x + popup_w > screen_x + screen_w - pad {
            x = cx - popup_w - 10.0;
        }
        x = x.clamp(screen_x + pad, (screen_x + screen_w - popup_w - pad).max(screen_x + pad));

        let mut y = cy + 10.0;
        if y + popup_h > screen_y + screen_h - pad {
            y = cy - popup_h - 10.0;
        }
        y = y.clamp(
            screen_y + top_pad,
            (screen_y + screen_h - popup_h - pad).max(screen_y + top_pad),
        );

        let _ = win.set_size(tauri::LogicalSize::new(popup_w, popup_h));
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn toggle_drawer_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("drawer") {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = app.emit_to("drawer", "drawer:close", ());
        } else {
            if let Some(main_win) = app.get_webview_window("main") {
                if !main_win.is_focused().unwrap_or(false) {
                    let _ = main_win.hide();
                }
            }
            position_popup_near_cursor(app, &win);
            let _ = win.show();
            let _ = win.set_focus();
            let _ = app.emit_to("drawer", "drawer:open", ());
        }
    }
}

fn focused_shortcuts() -> [(&'static str, Shortcut); 4] {
    [
        ("k", Shortcut::new(Some(Modifiers::SUPER), Code::KeyK)),
        ("t", Shortcut::new(Some(Modifiers::SUPER), Code::KeyT)),
        ("e", Shortcut::new(Some(Modifiers::SUPER), Code::KeyE)),
        ("x", Shortcut::new(Some(Modifiers::SUPER), Code::KeyX)),
    ]
}

fn register_focused_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let state = app.state::<AppState>();
    if !state.prioritize_shortcuts.load(Ordering::SeqCst) {
        unregister_focused_shortcuts(app);
        return;
    }
    let gs = app.global_shortcut();
    for (_, shortcut) in focused_shortcuts() {
        if !gs.is_registered(shortcut) {
            let _ = gs.register(shortcut);
        }
    }
}

fn unregister_focused_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let gs = app.global_shortcut();
    for (_, shortcut) in focused_shortcuts() {
        if gs.is_registered(shortcut) {
            let _ = gs.unregister(shortcut);
        }
    }
}

#[tauri::command]
fn clipboard_read() -> String {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.get_text())
        .unwrap_or_default()
}

#[tauri::command]
fn clipboard_import_now<R: Runtime>(app: AppHandle<R>) {
    poll_clipboard_once(&app, true);
}

#[tauri::command]
fn clipboard_write<R: Runtime>(app: AppHandle<R>, text: String) {
    let state = app.state::<AppState>();
    {
        let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
        watcher.suppress_until_ms = now_ms() + 1600;
        watcher.last_text = text.clone();
    }
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text);
    }
}

#[tauri::command]
fn clipboard_write_image<R: Runtime>(
    app: AppHandle<R>,
    local_path: Option<String>,
    data_url: Option<String>,
) -> bool {
    let bytes = if let Some(p) = local_path.as_deref() {
        let Some(safe_path) = validate_media_path(&app, p) else {
            return false;
        };
        fs::read(safe_path).ok()
    } else if let Some(url) = data_url.as_deref() {
        url.split_once(",")
            .and_then(|(_, b64)| BASE64.decode(b64).ok())
    } else {
        None
    };

    let Some(raw_bytes) = bytes else {
        return false;
    };
    let Ok(dyn_img) = image::load_from_memory(&raw_bytes) else {
        return false;
    };
    let rgba = dyn_img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let state = app.state::<AppState>();
    {
        let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
        watcher.suppress_until_ms = now_ms() + 2000;
    }

    let ok = arboard::Clipboard::new()
        .and_then(|mut cb| {
            cb.set_image(arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            })
        })
        .is_ok();

    if ok {
        sync_last_seen(&state);
    }
    ok
}

#[tauri::command]
fn clipboard_write_file<R: Runtime>(app: AppHandle<R>, local_path: String) -> bool {
    let Some(safe_path) = validate_media_path(&app, &local_path) else {
        return false;
    };
    let safe_str = safe_path.to_string_lossy().to_string();
    let state = app.state::<AppState>();
    {
        let mut watcher = state.watcher.lock().unwrap_or_else(|e| e.into_inner());
        watcher.suppress_until_ms = now_ms() + 2500;
        watcher.last_file_path = safe_str.clone();
        watcher.last_text = safe_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
    }

    #[cfg(target_os = "macos")]
    {
        let ok = Command::new("osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "set the clipboard to (POSIX file (item 1 of argv))",
                "-e",
                "end run",
                &safe_str,
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            sync_last_seen(&state);
        }
        return ok;
    }

    #[cfg(target_os = "windows")]
    {
        let ok = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Set-Clipboard -Path $args[0]", &safe_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            sync_last_seen(&state);
        }
        return ok;
    }

    #[allow(unreachable_code)]
    false
}

#[tauri::command]
fn media_save<R: Runtime>(
    app: AppHandle<R>,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<SavedMediaResult, String> {
    if bytes.len() >= MAX_CAPTURE_BYTES {
        return Err("File exceeds 50 MB limit".to_string());
    }
    let dest = save_media_buffer(&app, &file_name, &bytes)?;
    let is_image = mime_type.starts_with("image/") && mime_type != "image/svg+xml";
    let (width, height) = if is_image {
        image::load_from_memory(&bytes)
            .map(|img| (Some(img.width()), Some(img.height())))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    let data_url = if is_image {
        Some(format!("data:{};base64,{}", mime_type, BASE64.encode(&bytes)))
    } else {
        None
    };

    Ok(SavedMediaResult {
        local_path: dest.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
        width,
        height,
        data_url,
    })
}

#[tauri::command]
fn media_delete<R: Runtime>(app: AppHandle<R>, local_path: String) -> bool {
    let Some(safe_path) = validate_media_path(&app, &local_path) else {
        return false;
    };
    if fs::remove_file(&safe_path).is_err() {
        return false;
    }
    if let Ok(root) = fs::canonicalize(media_dir(&app)) {
        if let Some(parent) = safe_path.parent() {
            if parent.starts_with(&root) && parent != root {
                if let Ok(mut entries) = fs::read_dir(parent) {
                    if entries.next().is_none() {
                        let _ = fs::remove_dir(parent);
                    }
                }
            }
        }
    }
    true
}

#[tauri::command]
fn media_show_in_finder<R: Runtime>(app: AppHandle<R>, local_path: String) -> bool {
    let Some(safe_path) = validate_media_path(&app, &local_path) else {
        return false;
    };
    let safe_str = safe_path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .args(["-R", &safe_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("explorer")
            .arg(format!("/select,{}", safe_str))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
fn media_open_file<R: Runtime>(app: AppHandle<R>, local_path: String) -> bool {
    let Some(safe_path) = validate_media_path(&app, &local_path) else {
        return false;
    };
    let safe_str = safe_path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg(&safe_str)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "start", "", &safe_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
fn app_get_auto_launch<R: Runtime>(app: AppHandle<R>) -> bool {
    app.state::<AppState>().auto_launch.load(Ordering::SeqCst)
}

#[tauri::command]
fn app_set_auto_launch<R: Runtime>(app: AppHandle<R>, enabled: bool) -> bool {
    app.state::<AppState>()
        .auto_launch
        .store(enabled, Ordering::SeqCst);
    let mut settings = read_settings(&app);
    settings.open_at_login = Some(enabled);
    write_settings(&app, &settings);
    enabled
}

#[tauri::command]
fn app_get_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

#[tauri::command]
fn clips_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let _guard = state.clips_io.lock().unwrap_or_else(|e| e.into_inner());
    let path = clips_path(&app);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(raw))
}

const MAX_CLIPS_JSON_BYTES: usize = 128 * 1024 * 1024;

#[tauri::command]
fn clips_save<R: Runtime>(app: AppHandle<R>, clips_json: String) -> Result<(), String> {
    if clips_json.len() > MAX_CLIPS_JSON_BYTES {
        return Err("Clips payload exceeds 128 MB limit".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(&clips_json)
        .map_err(|e| format!("Invalid clips JSON: {}", e))?;
    if !parsed.is_array() {
        return Err("Clips JSON must be an array".to_string());
    }
    let state = app.state::<AppState>();
    let _guard = state.clips_io.lock().unwrap_or_else(|e| e.into_inner());
    let target = clips_path(&app);
    let tmp = app_data_dir(&app).join("clips.json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(clips_json.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    set_restrictive_permissions(&tmp, false);
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    set_restrictive_permissions(&target, false);
    let _ = app.emit("clips:updated", ());
    Ok(())
}

#[tauri::command]
fn drawer_hide<R: Runtime>(app: AppHandle<R>) {
    if let Some(win) = app.get_webview_window("drawer") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn app_get_shortcuts(app: AppHandle<tauri::Wry>) -> ShortcutConfig {
    let state = app.state::<AppState>();
    let guard = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
    ShortcutConfig {
        toggle_shortcut: guard.toggle_str.clone(),
        drawer_shortcut: guard.drawer_str.clone(),
    }
}

#[tauri::command]
fn app_set_shortcuts(
    app: AppHandle<tauri::Wry>,
    toggle_shortcut: String,
    drawer_shortcut: String,
) -> Result<ShortcutConfig, String> {
    let toggle_trimmed = toggle_shortcut.trim().to_string();
    let drawer_trimmed = drawer_shortcut.trim().to_string();
    let new_toggle = parse_shortcut_str(&toggle_trimmed)?;
    let new_drawer = parse_shortcut_str(&drawer_trimmed)?;
    if new_toggle == new_drawer {
        return Err("Toggle Window and Quick Drawer shortcuts must be different".to_string());
    }

    let state = app.state::<AppState>();
    let (old_toggle, old_drawer) = {
        let guard = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
        (guard.toggle, guard.drawer)
    };

    let gs = app.global_shortcut();
    if gs.is_registered(old_toggle) {
        let _ = gs.unregister(old_toggle);
    }
    if gs.is_registered(old_drawer) {
        let _ = gs.unregister(old_drawer);
    }

    if let Err(e) = gs.register(new_toggle) {
        let _ = gs.register(old_toggle);
        let _ = gs.register(old_drawer);
        return Err(format!("Could not register Toggle shortcut: {}", e));
    }
    if let Err(e) = gs.register(new_drawer) {
        let _ = gs.unregister(new_toggle);
        let _ = gs.register(old_toggle);
        let _ = gs.register(old_drawer);
        return Err(format!("Could not register Drawer shortcut: {}", e));
    }

    {
        let mut guard = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
        guard.toggle_str = toggle_trimmed.clone();
        guard.toggle = new_toggle;
        guard.drawer_str = drawer_trimmed.clone();
        guard.drawer = new_drawer;
    }

    let mut settings = read_settings(&app);
    settings.toggle_shortcut = Some(toggle_trimmed.clone());
    settings.drawer_shortcut = Some(drawer_trimmed.clone());
    write_settings(&app, &settings);

    if let Some(ref items) = *state.tray_items.lock().unwrap_or_else(|e| e.into_inner()) {
        let _ = items.toggle_item.set_accelerator(Some(toggle_trimmed.as_str()));
        let _ = items.drawer_item.set_accelerator(Some(drawer_trimmed.as_str()));
    }

    let cfg = ShortcutConfig {
        toggle_shortcut: toggle_trimmed,
        drawer_shortcut: drawer_trimmed,
    };
    let _ = app.emit("shortcuts:updated", cfg.clone());
    Ok(cfg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_drag::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let (cur_toggle, cur_drawer) = {
                        let state = app.state::<AppState>();
                        let guard = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
                        (guard.toggle, guard.drawer)
                    };
                    if *shortcut == cur_toggle {
                        toggle_main_window(app);
                        return;
                    }
                    if *shortcut == cur_drawer {
                        toggle_drawer_window(app);
                        return;
                    }
                    for (key, s) in focused_shortcuts() {
                        if *shortcut == s {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_focused().unwrap_or(false) {
                                    let _ = app.emit("shortcut:trigger", key);
                                }
                            }
                            break;
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = read_settings(&handle);
            let auto_launch = settings.open_at_login.unwrap_or(true);
            let prioritize_shortcuts = settings.prioritize_clipture_shortcuts.unwrap_or(true);
            let toggle_str = settings
                .toggle_shortcut
                .clone()
                .unwrap_or_else(|| default_toggle_shortcut_str().to_string());
            let drawer_str = settings
                .drawer_shortcut
                .clone()
                .unwrap_or_else(|| default_drawer_shortcut_str().to_string());
            let toggle_sc = parse_shortcut_str(&toggle_str).unwrap_or_else(|_| {
                parse_shortcut_str(default_toggle_shortcut_str()).unwrap()
            });
            let drawer_sc = parse_shortcut_str(&drawer_str).unwrap_or_else(|_| {
                parse_shortcut_str(default_drawer_shortcut_str()).unwrap()
            });

            let state = handle.state::<AppState>();
            state.auto_launch.store(auto_launch, Ordering::SeqCst);
            state
                .prioritize_shortcuts
                .store(prioritize_shortcuts, Ordering::SeqCst);
            {
                let mut sc_guard = state.shortcuts.lock().unwrap_or_else(|e| e.into_inner());
                sc_guard.toggle_str = toggle_str.clone();
                sc_guard.toggle = toggle_sc;
                sc_guard.drawer_str = drawer_str.clone();
                sc_guard.drawer = drawer_sc;
            }
            sync_last_seen(&state);

            // Build Tray Menu
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Show / Hide Clipture", true, Some(toggle_str.as_str()))?;
            let drawer_item =
                MenuItem::with_id(app, "drawer", "Quick Cursor Popup", true, Some(drawer_str.as_str()))?;
            let custom_shortcuts_item =
                MenuItem::with_id(app, "custom_shortcuts", "Custom Shortcuts...", true, None::<&str>)?;
            let import_item =
                MenuItem::with_id(app, "import", "Import Clipboard Now", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let auto_launch_item =
                CheckMenuItem::with_id(app, "auto_launch", "Launch at Login", true, auto_launch, None::<&str>)?;

            let priority_item = if cfg!(target_os = "macos") {
                Some(CheckMenuItem::with_id(
                    app,
                    "priority_shortcuts",
                    "Prioritize Clipture Shortcuts",
                    true,
                    prioritize_shortcuts,
                    None::<&str>,
                )?)
            } else {
                None
            };

            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Clipture", true, Some("CmdOrCtrl+Q"))?;

            *state.tray_items.lock().unwrap_or_else(|e| e.into_inner()) = Some(TrayShortcutItems {
                toggle_item: toggle_item.clone(),
                drawer_item: drawer_item.clone(),
            });

            let menu = if let Some(ref prio) = priority_item {
                Menu::with_items(
                    app,
                    &[
                        &toggle_item,
                        &drawer_item,
                        &custom_shortcuts_item,
                        &import_item,
                        &sep1,
                        &auto_launch_item,
                        prio,
                        &sep2,
                        &quit_item,
                    ],
                )?
            } else {
                Menu::with_items(
                    app,
                    &[
                        &toggle_item,
                        &drawer_item,
                        &custom_shortcuts_item,
                        &import_item,
                        &sep1,
                        &auto_launch_item,
                        &sep2,
                        &quit_item,
                    ],
                )?
            };

            let tray_icon_bytes = if cfg!(target_os = "macos") {
                include_bytes!("../icons/trayTemplate.png").as_slice()
            } else {
                include_bytes!("../icons/32x32.png").as_slice()
            };
            let tray_image = tauri::image::Image::from_bytes(tray_icon_bytes)?;

            let priority_item_clone = priority_item.clone();
            let auto_launch_item_clone = auto_launch_item.clone();

            let mut tray_builder = TrayIconBuilder::new()
                .icon(tray_image)
                .menu(&menu)
                .tooltip("Clipture")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle" => toggle_main_window(app),
                    "drawer" => toggle_drawer_window(app),
                    "custom_shortcuts" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                        let _ = app.emit_to("main", "shortcuts:open-settings", ());
                    }
                    "import" => poll_clipboard_once(app, true),
                    "auto_launch" => {
                        let next = !app.state::<AppState>().auto_launch.load(Ordering::SeqCst);
                        app.state::<AppState>().auto_launch.store(next, Ordering::SeqCst);
                        let _ = auto_launch_item_clone.set_checked(next);
                        let mut s = read_settings(app);
                        s.open_at_login = Some(next);
                        write_settings(app, &s);
                    }
                    "priority_shortcuts" => {
                        let next = !app
                            .state::<AppState>()
                            .prioritize_shortcuts
                            .load(Ordering::SeqCst);
                        app.state::<AppState>()
                            .prioritize_shortcuts
                            .store(next, Ordering::SeqCst);
                        if let Some(ref item) = priority_item_clone {
                            let _ = item.set_checked(next);
                        }
                        let mut s = read_settings(app);
                        s.prioritize_clipture_shortcuts = Some(next);
                        write_settings(app, &s);
                        if next {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_focused().unwrap_or(false) {
                                    register_focused_shortcuts(app);
                                }
                            }
                        } else {
                            unregister_focused_shortcuts(app);
                        }
                    }
                    "quit" => {
                        app.state::<AppState>()
                            .is_quitting
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                });

            if cfg!(target_os = "macos") {
                tray_builder = tray_builder.icon_as_template(true);
            }

            let _tray = tray_builder.build(app)?;

            // Create hidden Quick Cursor Popup window
            if let Ok(drawer_win) = WebviewWindowBuilder::new(
                app,
                "drawer",
                WebviewUrl::App("index.html?view=drawer".into()),
            )
            .title("Clipture Quick Popup")
            .inner_size(340.0, 420.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            {
                position_popup_near_cursor(&handle, &drawer_win);
            }

            // Register global toggle shortcuts
            let _ = app.global_shortcut().register(toggle_sc);
            let _ = app.global_shortcut().register(drawer_sc);

            // Start 800ms background clipboard watcher
            let watcher_handle = Arc::new(handle.clone());
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(800));
                poll_clipboard_once(watcher_handle.as_ref(), false);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            if window.label() == "drawer" {
                match event {
                    WindowEvent::Focused(false) => {
                        let _ = app.emit_to("drawer", "drawer:close", ());
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            match event {
                WindowEvent::Focused(true) => register_focused_shortcuts(app),
                WindowEvent::Focused(false) => unregister_focused_shortcuts(app),
                WindowEvent::CloseRequested { api, .. } => {
                    if cfg!(target_os = "macos")
                        && !app.state::<AppState>().is_quitting.load(Ordering::SeqCst)
                    {
                        api.prevent_close();
                        unregister_focused_shortcuts(app);
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            clipboard_read,
            clipboard_import_now,
            clipboard_write,
            clipboard_write_image,
            clipboard_write_file,
            media_save,
            media_delete,
            media_show_in_finder,
            media_open_file,
            app_get_auto_launch,
            app_set_auto_launch,
            app_get_platform,
            clips_load,
            clips_save,
            drawer_hide,
            app_get_shortcuts,
            app_set_shortcuts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clipture");
}
