// Spark - the small Rust core. It owns the windows, the global shortcut, the
// tray icon, settings on disk and everything that touches the system. The
// command engine itself is JavaScript (src/engine.js) running in the bar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Write,
    net::UdpSocket,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const BAR_WIDTH: f64 = 700.0;
const CLIP_HISTORY: usize = 25;

#[derive(Default)]
struct State {
    data_dir: PathBuf,
    config: Mutex<Value>,
    notice: Mutex<Option<String>>,
    clips: Mutex<Vec<String>>,
    visible: Mutex<bool>,
    custom_pos: Mutex<Option<PhysicalPosition<i32>>>,
    drag_origin: Mutex<Option<(PhysicalPosition<i32>, f64)>>,
}

// ----------------------------------------------------------------- config

fn default_config() -> Value {
    json!({
        "hotkey": "Ctrl+Shift+Space",
        // Quick links: type the name in the bar to open it. Names that are
        // already commands (like "maps") would never be reached, so none here.
        "aliases": {
            "github": "https://github.com",
            "mail": "https://mail.google.com",
            "calendar": "https://calendar.google.com",
            "drive": "https://drive.google.com",
            "gdocs": "https://docs.google.com",
            "sheets": "https://sheets.google.com",
            "photos": "https://photos.google.com",
            "outlook": "https://outlook.live.com",
            "whatsapp": "https://web.whatsapp.com",
            "discord": "https://discord.com/app",
            "telegram": "https://web.telegram.org",
            "instagram": "https://www.instagram.com",
            "linkedin": "https://www.linkedin.com",
            "netflix": "https://www.netflix.com",
            "twitch": "https://www.twitch.tv",
            "notion": "https://www.notion.so",
            "figma": "https://www.figma.com",
            "chatgpt": "https://chatgpt.com",
            "claude": "https://claude.ai",
            "speedtest": "https://www.speedtest.net"
        },
        "ollama_url": "http://localhost:11434",
        "ollama_model": "llama3.1"
    })
}

/// Old "<ctrl>+<shift>+<space>" style (Spark 0.x) -> "Ctrl+Shift+Space".
fn migrate_hotkey(hotkey: &str) -> String {
    if !hotkey.contains('<') {
        return hotkey.to_string();
    }
    hotkey
        .split('+')
        .map(|p| {
            let p = p.trim().trim_matches(|c| c == '<' || c == '>');
            let mut chars = p.chars();
            match chars.next() {
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// User values over defaults. If the user has a quick-link list it replaces
/// the default one, so links they deleted stay deleted.
fn merge_config(user: &Value) -> Value {
    let mut cfg = default_config();
    if let Value::Object(map) = user {
        for (key, value) in map {
            if key == "aliases" {
                if let Value::Object(aliases) = value {
                    let mut own = Map::new();
                    for (name, target) in aliases {
                        let target = target.as_str().map(String::from).unwrap_or_else(|| target.to_string());
                        own.insert(name.clone(), Value::String(target));
                    }
                    cfg["aliases"] = Value::Object(own);
                }
            } else {
                cfg[key] = value.clone();
            }
        }
    }
    if let Some(h) = cfg["hotkey"].as_str() {
        cfg["hotkey"] = Value::String(migrate_hotkey(h));
    }
    cfg
}

/// Creates the data folder on first run. A broken file is left alone and the
/// defaults are used, with a warning for the bar.
fn load_config(dir: &Path) -> (Value, Option<String>) {
    let _ = fs::create_dir_all(dir.join("plugins"));
    let file = dir.join("config.json");
    if !file.exists() {
        let _ = fs::write(&file, serde_json::to_string_pretty(&default_config()).unwrap_or_default());
        return (default_config(), None);
    }
    match fs::read_to_string(&file).map_err(|e| e.to_string()).and_then(|t| {
        serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())
    }) {
        Ok(v) if v.is_object() => (merge_config(&v), None),
        Ok(_) => (default_config(), Some("Config error (not a JSON object); using defaults.".into())),
        Err(e) => (default_config(), Some(format!("Config error ({e}); using defaults."))),
    }
}

/// Portable if a `spark_data` folder sits next to the program, else the
/// normal per-user app-data folder.
fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("SPARK_HOME") {
        return PathBuf::from(dir);
    }
    if let Some(portable) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("spark_data")))
        .filter(|p| p.is_dir())
    {
        return portable;
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("spark_data"))
}

/// Only plain file names inside the data folder ("notes.md", not "../x").
fn data_file(state: &State, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() < 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !name.starts_with('.');
    if ok {
        Ok(state.data_dir.join(name))
    } else {
        Err(format!("bad file name: {name}"))
    }
}

// ----------------------------------------------------------------- shortcut

fn register_hotkey(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("\"{accelerator}\" isn't a valid shortcut"))?;
    gs.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_bar(app);
        }
    })
    .map_err(|_| format!("\"{accelerator}\" is already used by another app"))
}

// ----------------------------------------------------------------- bar window

fn bar(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("bar")
}

fn place_bar(app: &AppHandle, win: &WebviewWindow) {
    let state = app.state::<State>();
    if let Some(pos) = *state.custom_pos.lock().unwrap() {
        let _ = win.set_position(pos);
        return;
    }
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| win.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let (pos, size) = (m.position(), m.size());
        let x = pos.x + ((size.width as f64 - BAR_WIDTH * scale) / 2.0) as i32;
        let y = pos.y + (size.height as f64 * 0.22) as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Windows refuses to hand keyboard focus to a background app while you are
/// busy in another window. Briefly joining that window's input queue lets the
/// bar take focus, so you can type the moment it appears.
#[cfg(windows)]
fn force_foreground(win: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn AttachThreadInput(from: u32, to: u32, attach: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn BringWindowToTop(hwnd: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let fg = GetForegroundWindow();
        if fg == hwnd {
            return;
        }
        let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(me, fg_thread, 0);
        }
    }
}

#[cfg(not(windows))]
fn force_foreground(_win: &WebviewWindow) {}

fn show_bar(app: &AppHandle, reset: bool) {
    let Some(win) = bar(app) else { return };
    let state = app.state::<State>();
    let was_visible = *state.visible.lock().unwrap();
    if !was_visible {
        place_bar(app, &win);
    }
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    force_foreground(&win);
    let _ = win.set_focus();
    *state.visible.lock().unwrap() = true;
    if reset {
        let notice = state.notice.lock().unwrap().take();
        let _ = win.emit("bar:show", notice);
    }
}

fn hide_bar(app: &AppHandle) {
    if let Some(win) = bar(app) {
        let _ = win.hide();
    }
    *app.state::<State>().visible.lock().unwrap() = false;
}

fn toggle_bar(app: &AppHandle) {
    let visible = *app.state::<State>().visible.lock().unwrap();
    if visible {
        hide_bar(app)
    } else {
        show_bar(app, true)
    }
}

/// Show a message in the bar (opening it if needed).
fn post(app: &AppHandle, text: &str) {
    show_bar(app, false);
    let _ = app.emit_to("bar", "bar:output", text);
}

// ----------------------------------------------------------------- settings window

fn open_settings_window(app: &AppHandle) {
    hide_bar(app);
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Spark Settings")
        .inner_size(520.0, 640.0)
        .min_inner_size(440.0, 480.0)
        .center()
        .focused(true)
        .build();
    if let Ok(win) = built {
        // Closing the window = save and start (the page validates first).
        let handle = win.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.emit("settings:request-save", ());
            }
        });
    }
}

// ----------------------------------------------------------------- system helpers

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn expand_home(target: &str) -> PathBuf {
    if let Some(rest) = target.strip_prefix('~') {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        return PathBuf::from(format!("{home}{rest}"));
    }
    PathBuf::from(target)
}

fn launch_app(name: &str) -> bool {
    if cfg!(windows) {
        // Start-Process finds Start-menu/App Paths names like "notepad" or "chrome",
        // and fails quietly (no popup) when nothing matches.
        hidden(Command::new("powershell").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -FilePath $args[0]",
            name,
        ]))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    } else if cfg!(target_os = "macos") {
        Command::new("open").args(["-a", name]).status().map(|s| s.success()).unwrap_or(false)
    } else {
        let mut parts = name.split_whitespace();
        match parts.next() {
            Some(exe) => Command::new(exe).args(parts).spawn().is_ok(),
            None => false,
        }
    }
}

fn run_output(cmd: &mut Command) -> String {
    hidden(cmd)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

// ----------------------------------------------------------------- commands (called from JS)

#[tauri::command]
fn get_state(app: AppHandle) -> Value {
    let state = app.state::<State>();
    let config = state.config.lock().unwrap().clone();
    json!({
        "config": config,
        "platform": platform_name(),
        "dataDir": state.data_dir.to_string_lossy(),
        "version": app.package_info().version.to_string(),
        "autostart": app.autolaunch().is_enabled().unwrap_or(false),
    })
}

#[tauri::command]
fn save_settings(app: AppHandle, config: Value, autostart: bool) -> Result<(), String> {
    let state = app.state::<State>();
    let old = state.config.lock().unwrap()["hotkey"].as_str().unwrap_or("Ctrl+Shift+Space").to_string();
    let mut next = merge_config(&config);
    if config.get("aliases").is_none() {
        next["aliases"] = Value::Object(Map::new()); // the user removed every link
    }
    let hotkey = next["hotkey"].as_str().unwrap_or_default().to_string();
    if let Err(e) = register_hotkey(&app, &hotkey) {
        let _ = register_hotkey(&app, &old);
        return Err(e);
    }
    fs::write(
        state.data_dir.join("config.json"),
        serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Couldn't save settings: {e}"))?;
    *state.config.lock().unwrap() = next;
    let auto = app.autolaunch();
    let _ = if autostart { auto.enable() } else { auto.disable() };
    let _ = app.emit_to("bar", "config:changed", ());
    Ok(())
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.destroy();
    }
    let hotkey = app.state::<State>().config.lock().unwrap()["hotkey"].as_str().unwrap_or_default().to_string();
    post(&app, &format!("Spark is ready ✻  Press {hotkey} anytime."));
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2600));
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || hide_bar(&h));
    });
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

#[tauri::command]
fn reload_config(app: AppHandle) -> String {
    let state = app.state::<State>();
    let (config, warning) = load_config(&state.data_dir);
    let hotkey = config["hotkey"].as_str().unwrap_or_default().to_string();
    *state.config.lock().unwrap() = config;
    let hk = register_hotkey(&app, &hotkey).err();
    warning.or(hk).unwrap_or_else(|| format!("Settings reloaded. Shortcut: {hotkey}"))
}

#[tauri::command]
fn bar_hide(app: AppHandle) {
    hide_bar(&app);
}

#[tauri::command]
fn bar_post(app: AppHandle, text: String) {
    post(&app, &text);
}

#[tauri::command]
fn bar_resize(app: AppHandle, height: f64) {
    if let Some(win) = bar(&app) {
        let max = win
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| m.size().height as f64 / m.scale_factor() * 0.85)
            .unwrap_or(900.0);
        let _ = win.set_size(LogicalSize::new(BAR_WIDTH, height.clamp(60.0, max)));
    }
}

#[tauri::command]
fn bar_drag_start(app: AppHandle) {
    if let Some(win) = bar(&app) {
        if let Ok(pos) = win.outer_position() {
            let scale = win.scale_factor().unwrap_or(1.0);
            *app.state::<State>().drag_origin.lock().unwrap() = Some((pos, scale));
        }
    }
}

#[tauri::command]
fn bar_drag_move(app: AppHandle, dx: f64, dy: f64) {
    let state = app.state::<State>();
    let origin = *state.drag_origin.lock().unwrap();
    if let (Some((pos, scale)), Some(win)) = (origin, bar(&app)) {
        let next = PhysicalPosition::new(pos.x + (dx * scale) as i32, pos.y + (dy * scale) as i32);
        let _ = win.set_position(next);
        *state.custom_pos.lock().unwrap() = Some(next);
    }
}

#[tauri::command]
fn bar_drag_end(app: AppHandle) {
    *app.state::<State>().drag_origin.lock().unwrap() = None;
}

/// Timers live here, not in the page, so they stay on time even while the
/// bar is hidden (hidden web pages get their timers slowed down).
#[tauri::command]
fn alert_later(app: AppHandle, ms: u64, text: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            post(&h, &text);
            let _ = h.emit_to("bar", "bar:beep", ());
        });
    });
}

#[tauri::command]
fn read_data(app: AppHandle, name: String) -> Result<String, String> {
    let path = data_file(&app.state::<State>(), &name)?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
fn write_data(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let state = app.state::<State>();
    let path = data_file(&state, &name)?;
    let _ = fs::create_dir_all(&state.data_dir);
    fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn append_data(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let state = app.state::<State>();
    let path = data_file(&state, &name)?;
    let _ = fs::create_dir_all(&state.data_dir);
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_plugins(app: AppHandle) -> Vec<Value> {
    let dir = app.state::<State>().data_dir.join("plugins");
    let mut files: Vec<_> = fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().map(|e| e == "js" || e == "mjs").unwrap_or(false));
    files.sort();
    files
        .into_iter()
        .map(|p| {
            json!({
                "file": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "code": fs::read_to_string(&p).unwrap_or_default(),
            })
        })
        .collect()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only web links can be opened this way".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// A file or folder if it exists, otherwise an app by name.
#[tauri::command]
async fn open_target(app: AppHandle, target: String) -> bool {
    let path = expand_home(target.trim());
    if path.exists() {
        return app.opener().open_path(path.to_string_lossy(), None::<&str>).is_ok();
    }
    tauri::async_runtime::spawn_blocking(move || launch_app(&target)).await.unwrap_or(false)
}

#[tauri::command]
fn open_folder(app: AppHandle, kind: String) -> Result<(), String> {
    let p = app.path();
    let state = app.state::<State>();
    let dir = match kind.as_str() {
        "downloads" => p.download_dir(),
        "desktop" => p.desktop_dir(),
        "documents" => p.document_dir(),
        "pictures" => p.picture_dir(),
        "music" => p.audio_dir(),
        "videos" => p.video_dir(),
        "data" => Ok(state.data_dir.clone()),
        "config" => Ok(state.data_dir.join("config.json")),
        _ => return Err(format!("unknown folder: {kind}")),
    }
    .map_err(|e| e.to_string())?;
    let _ = fs::create_dir_all(if kind == "config" { state.data_dir.clone() } else { dir.clone() });
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn clip_history(app: AppHandle) -> Vec<String> {
    app.state::<State>().clips.lock().unwrap().clone()
}

/// HTTP for the commands (Ollama, weather, currency...). Done here instead of
/// in the page so it isn't blocked by browser cross-site rules.
#[tauri::command]
async fn http(method: String, url: String, body: Option<String>) -> Result<Value, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .timeout(Duration::from_secs(180))
            .build();
        let req = agent
            .request(&method, &url)
            .set("User-Agent", "curl/8.0 (Spark)")
            .set("Content-Type", "application/json");
        let res = match body {
            Some(b) => req.send_string(&b),
            None => req.call(),
        };
        match res {
            Ok(r) => {
                let status = r.status();
                Ok(json!({ "status": status, "body": r.into_string().unwrap_or_default() }))
            }
            Err(ureq::Error::Status(status, r)) => {
                Ok(json!({ "status": status, "body": r.into_string().unwrap_or_default() }))
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sys_info(app: AppHandle) -> Value {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| run_output(&mut Command::new("hostname")).trim().to_string());
    json!({
        "os": match platform_name() { "windows" => "Windows", "macos" => "macOS", _ => "Linux" },
        "arch": std::env::consts::ARCH,
        "hostname": hostname,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "version": app.package_info().version.to_string(),
    })
}

#[tauri::command]
fn local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("10.255.255.255:1").map(|_| s)) // no packet is sent
        .and_then(|s| s.local_addr())
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

#[tauri::command]
async fn list_apps() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = if cfg!(windows) {
            run_output(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "Get-Process | Where-Object {$_.MainWindowTitle} | ForEach-Object { $_.ProcessName + ' - ' + $_.MainWindowTitle }",
            ]))
        } else if cfg!(target_os = "macos") {
            run_output(Command::new("osascript").args([
                "-e",
                "tell application \"System Events\" to get name of (processes where background only is false)",
            ]))
            .replace(", ", "\n")
        } else {
            run_output(Command::new("wmctrl").arg("-l"))
                .lines()
                .map(|l| l.splitn(4, char::is_whitespace).nth(3).unwrap_or(l).trim().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let mut list: Vec<String> = out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        list.sort();
        list.dedup();
        list
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn lock_screen() -> bool {
    let status = if cfg!(windows) {
        hidden(Command::new("rundll32.exe").arg("user32.dll,LockWorkStation")).status()
    } else if cfg!(target_os = "macos") {
        Command::new("pmset").arg("displaysleepnow").status()
    } else {
        Command::new("loginctl").arg("lock-session").status()
    };
    status.map(|s| s.success()).unwrap_or(false)
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// ----------------------------------------------------------------- startup

fn watch_clipboard(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = app.clipboard().read_text().unwrap_or_default();
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let Ok(text) = app.clipboard().read_text() else { continue };
            if text.is_empty() || text == last || text.len() > 10_000 {
                continue;
            }
            last = text.clone();
            let state = app.state::<State>();
            let mut clips = state.clips.lock().unwrap();
            clips.retain(|c| c != &text);
            clips.insert(0, text);
            clips.truncate(CLIP_HISTORY);
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Spark", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Spark", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &sep, &quit])?;
    let mut tray = TrayIconBuilder::with_id("spark")
        .tooltip("Spark")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_bar(app, true),
            "settings" => open_settings_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_bar(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let background = std::env::args().any(|a| a == "--background");
    tauri::Builder::default()
        // A second launch just opens the settings of the running Spark.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_settings_window(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon
            let handle = app.handle().clone();
            let data_dir = resolve_data_dir(&handle);
            let (config, warning) = load_config(&data_dir);
            let hotkey = config["hotkey"].as_str().unwrap_or("Ctrl+Shift+Space").to_string();
            app.manage(State {
                data_dir,
                config: Mutex::new(config),
                notice: Mutex::new(warning),
                ..Default::default()
            });
            build_tray(&handle)?;
            watch_clipboard(handle.clone());
            if background {
                if let Err(e) = register_hotkey(&handle, &hotkey) {
                    *handle.state::<State>().notice.lock().unwrap() = Some(e);
                }
            } else {
                open_settings_window(&handle); // the shortcut goes live on Save & Start
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state, save_settings, close_settings, open_settings, reload_config,
            bar_hide, bar_post, bar_resize, bar_drag_start, bar_drag_move, bar_drag_end, alert_later,
            read_data, write_data, append_data, list_plugins, open_url, open_target, open_folder,
            clipboard_read, clipboard_write, clip_history, http, sys_info, local_ip, list_apps,
            lock_screen, quit
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Spark")
        .run(|_app, event| {
            // Stay alive in the tray when windows close.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_old_hotkeys() {
        assert_eq!(migrate_hotkey("<ctrl>+<alt>+<space>"), "Ctrl+Alt+Space");
        assert_eq!(migrate_hotkey("Ctrl+Shift+Space"), "Ctrl+Shift+Space");
    }

    #[test]
    fn merges_user_values_over_defaults() {
        let cfg = merge_config(&json!({ "ollama_model": "x", "aliases": { "me": "https://e.com" } }));
        assert_eq!(cfg["ollama_model"], "x");
        assert_eq!(cfg["hotkey"], "Ctrl+Shift+Space");
        assert_eq!(cfg["aliases"]["me"], "https://e.com");
        assert!(cfg["aliases"].get("github").is_none(), "deleted links must stay deleted");
        let fresh = merge_config(&json!({ "ollama_model": "y" }));
        assert_eq!(fresh["aliases"]["github"], "https://github.com");
    }

    #[test]
    fn broken_config_falls_back() {
        let dir = std::env::temp_dir().join(format!("spark-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("config.json"), "{ not json").unwrap();
        let (cfg, warning) = load_config(&dir);
        assert_eq!(cfg, default_config());
        assert!(warning.unwrap().starts_with("Config error"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_files_stay_inside_the_folder() {
        let state = State { data_dir: PathBuf::from("data"), ..Default::default() };
        assert!(data_file(&state, "notes.md").is_ok());
        assert!(data_file(&state, "../secret").is_err());
        assert!(data_file(&state, "a/b").is_err());
        assert!(data_file(&state, ".hidden").is_err());
    }
}
