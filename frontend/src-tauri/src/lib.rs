//! Desktop window around the existing Node hub.
//!
//! Dev (`tauri dev`): Vite already has ssh2 via hubPlugin; native tabs load
//! `http://127.0.0.1:5273/?session=…`.
//! Release: pick a free UI port, spawn `scripts/npz-view.mjs`, wait until
//! /__hub is up, then open one WebView per tab on that origin.
//! Portable zip: Node and Python live under `runtime/` next to the exe.

use std::error::Error;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::{Color, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl, Window,
    WindowEvent,
};
use url::Url;

struct HubShell(Mutex<Option<Child>>);

const DEV_UI_PORT: u16 = 5273;
const MAX_TABS: usize = 6;
const CHROME_H: f64 = 36.0;
const CHROME_LABEL: &str = "tabs-chrome";
const WINDOW_LABEL: &str = "main";
/// zinc-950 — WebView2 defaults to white and flashes without this.
const SURFACE: Color = Color(9, 9, 11, 255);
const CHROME_SURFACE: Color = Color(24, 24, 27, 255);

type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Clone)]
struct Tab {
    session_id: String,
    webview_label: String,
    title: String,
    ready: bool,
}

struct TabsInner {
    ui_port: u16,
    next_index: u32,
    tabs: Vec<Tab>,
    active: String,
}

struct Tabs(Mutex<TabsInner>);

impl Tabs {
    fn lock(&self) -> std::sync::MutexGuard<'_, TabsInner> {
        self.0.lock().expect("tabs lock")
    }
}

#[derive(Clone, Serialize)]
struct TabInfo {
    id: String,
    title: String,
    active: bool,
}

fn find_repo_root() -> Result<PathBuf, BoxError> {
    let mut starts = Vec::new();
    if let Ok(root) = std::env::var("NPZVIEW_ROOT") {
        starts.push(PathBuf::from(root));
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    for start in starts {
        let mut dir = start;
        loop {
            if dir.join("scripts").join("npz-view.mjs").is_file() {
                return Ok(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    Err(
        "找不到客户端目录（缺少 scripts/npz-view.mjs）。请把便携 zip 解压到普通文件夹后再运行，不要放到 Program Files。"
            .into(),
    )
}

fn bundled_node(root: &Path) -> Option<PathBuf> {
    let win = root.join("runtime").join("node").join("node.exe");
    if win.is_file() {
        return Some(win);
    }
    let posix = root.join("runtime").join("node").join("bin").join("node");
    if posix.is_file() {
        return Some(posix);
    }
    None
}

fn node_bin(root: &Path) -> PathBuf {
    bundled_node(root).unwrap_or_else(|| {
        PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
    })
}

fn prepend_runtime_path(root: &Path, cmd: &mut Command) {
    let mut extras: Vec<PathBuf> = Vec::new();
    let node_dir = root.join("runtime").join("node");
    if node_dir.join("node.exe").is_file() || node_dir.join("bin").join("node").is_file() {
        extras.push(node_dir.clone());
        extras.push(node_dir.join("bin"));
    }
    let py_dir = root.join("runtime").join("python");
    if py_dir.is_dir() {
        extras.push(py_dir.clone());
        extras.push(py_dir.join("Scripts"));
        extras.push(py_dir.join("bin"));
    }
    if extras.is_empty() {
        return;
    }
    let old = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = extras
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    parts.push(old);
    cmd.env("PATH", parts.join(sep));
}

fn pick_free_port() -> Result<u16, BoxError> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn spawn_hub(root: &Path, ui_port: u16) -> Result<Child, BoxError> {
    let script = root.join("scripts").join("npz-view.mjs");
    let node = node_bin(root);
    let portable = bundled_node(root).is_some();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .current_dir(root)
        .stdin(Stdio::null())
        .env("NPZVIEW_ROOT", root)
        .env("NPZVIEW_UI_PORT", ui_port.to_string());
    if portable {
        cmd.env("NPZVIEW_PORTABLE", "1");
    }
    prepend_runtime_path(root, &mut cmd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let log_path = root.join("npz-view-hub.log");
        let log = std::fs::File::create(&log_path).map_err(|err| {
            format!("无法写入 {log_path:?}: {err}")
        })?;
        let log_err = log.try_clone()?;
        cmd.stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    Ok(cmd
        .spawn()
        .map_err(|err| format!("启动 Node 客户端壳失败 ({node:?} {script:?}): {err}"))?)
}

fn wait_http(port: u16, path: &str, timeout: Duration) -> Result<(), BoxError> {
    let deadline = Instant::now() + timeout;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut body = String::new();
                let _ = stream.read_to_string(&mut body);
                if body.starts_with("HTTP/1.1 200") || body.starts_with("HTTP/1.0 200") {
                    return Ok(());
                }
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "等待 http://127.0.0.1:{port}{path} 超时。看同目录 npz-view-hub.log。便携版请确认 zip 解压完整；源码运行请确认已 npm install / npm run build，且本机有 Python。"
    )
    .into())
}

fn json_from_http(raw: &str) -> String {
    let rest = raw.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or(raw);
    let headers = raw.split_once("\r\n\r\n").map(|(h, _)| h).unwrap_or("");
    let chunked = headers.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let payload = if chunked {
        decode_chunked(rest)
    } else {
        rest.to_string()
    };
    let start = payload.find('{').unwrap_or(0);
    let end = payload.rfind('}').map(|i| i + 1).unwrap_or(payload.len());
    payload.get(start..end).unwrap_or(&payload).trim().to_string()
}

fn decode_chunked(mut rest: &str) -> String {
    let mut out = String::new();
    loop {
        let Some((size_line, after)) = rest.split_once("\r\n") else {
            break;
        };
        let hex = size_line.trim().split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(hex, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        if after.len() < size {
            out.push_str(after);
            break;
        }
        out.push_str(&after[..size]);
        rest = after.get(size..).unwrap_or("");
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            rest = stripped;
        }
    }
    out
}

fn hub_http(port: u16, method: &str, path: &str, body: Option<&str>) -> Result<String, BoxError> {
    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    stream.set_write_timeout(Some(Duration::from_secs(8)))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    let status_ok = raw.starts_with("HTTP/1.1 200") || raw.starts_with("HTTP/1.0 200");
    if !status_ok {
        return Err(format!("hub {method} {path} 失败: {}", raw.lines().next().unwrap_or("no status")).into());
    }
    Ok(json_from_http(&raw))
}

fn hub_create_session(port: u16) -> Result<String, BoxError> {
    let body = hub_http(port, "POST", "/__hub/sessions", Some("{}"))?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|err| {
        format!("hub session JSON 无法解析 ({err}): {}", body.chars().take(120).collect::<String>())
    })?;
    value
        .get("id")
        .and_then(|id| id.as_str())
        .map(str::to_string)
        .ok_or_else(|| "hub 未返回 session id".into())
}

fn hub_delete_session(port: u16, id: &str) {
    let path = format!("/__hub/sessions/{id}");
    let _ = hub_http(port, "DELETE", &path, None);
}

fn kill_shell(shell: &HubShell) {
    if let Ok(mut guard) = shell.0.lock() {
        if let Some(mut child) = guard.take() {
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &child.id().to_string()])
                    .status();
                thread::sleep(Duration::from_millis(600));
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn snapshot(inner: &TabsInner) -> Vec<TabInfo> {
    inner
        .tabs
        .iter()
        .map(|tab| TabInfo {
            id: tab.session_id.clone(),
            title: tab.title.clone(),
            active: tab.session_id == inner.active,
        })
        .collect()
}

fn emit_tabs(app: &AppHandle) {
    let payload = {
        let tabs = app.state::<Tabs>();
        let inner = tabs.lock();
        snapshot(&inner)
    };
    let _ = app.emit("tabs-changed", payload);
}

fn logical_inner(window: &Window) -> Result<(f64, f64), String> {
    let size = window.inner_size().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let logical = size.to_logical::<f64>(scale);
    Ok((logical.width, logical.height))
}

fn chrome_size(width: f64) -> LogicalSize<f64> {
    LogicalSize::new(width, CHROME_H)
}

fn content_bounds(width: f64, height: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(0.0, CHROME_H),
        LogicalSize::new(width, (height - CHROME_H).max(0.0)),
    )
}

fn visible_content_label(inner: &TabsInner) -> Option<String> {
    if let Some(tab) = inner.tabs.iter().find(|tab| tab.session_id == inner.active) {
        if tab.ready {
            return Some(tab.webview_label.clone());
        }
    }
    inner
        .tabs
        .iter()
        .rev()
        .find(|tab| tab.ready)
        .map(|tab| tab.webview_label.clone())
}

fn layout_webviews(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "missing main window".to_string())?;
    let (width, height) = logical_inner(&window)?;
    if let Some(chrome) = app.get_webview(CHROME_LABEL) {
        chrome
            .set_position(LogicalPosition::new(0.0, 0.0))
            .map_err(|err| err.to_string())?;
        chrome
            .set_size(chrome_size(width))
            .map_err(|err| err.to_string())?;
    }
    let (pos, size) = content_bounds(width, height);
    let (tabs, shown) = {
        let tabs = app.state::<Tabs>();
        let inner = tabs.lock();
        (inner.tabs.clone(), visible_content_label(&inner))
    };
    for tab in tabs {
        let Some(webview) = app.get_webview(&tab.webview_label) else {
            continue;
        };
        webview.set_position(pos).map_err(|err| err.to_string())?;
        webview.set_size(size).map_err(|err| err.to_string())?;
        if shown.as_deref() == Some(tab.webview_label.as_str()) {
            webview.show().map_err(|err| err.to_string())?;
        } else {
            webview.hide().map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn focus_active(app: &AppHandle) {
    let label = {
        let tabs = app.state::<Tabs>();
        let inner = tabs.lock();
        visible_content_label(&inner)
    };
    if let Some(label) = label {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.show();
            let _ = webview.set_focus();
        }
    }
}

fn reveal_tab(app: &AppHandle, session_id: &str) {
    {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        let Some(tab) = inner.tabs.iter_mut().find(|tab| tab.session_id == session_id) else {
            return;
        };
        if tab.ready {
            return;
        }
        tab.ready = true;
    }
    let _ = layout_webviews(app);
    focus_active(app);
}

fn attach_title_listener(app: &AppHandle, session_id: String) -> impl Fn(Webview, String) + Send + 'static {
    let handle = app.clone();
    move |_webview, title| {
        let trimmed = title.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        {
            let tabs = handle.state::<Tabs>();
            let mut inner = tabs.lock();
            let Some(tab) = inner
                .tabs
                .iter_mut()
                .find(|tab| tab.session_id == session_id)
            else {
                return;
            };
            if tab.title == trimmed {
                return;
            }
            tab.title = trimmed;
        }
        emit_tabs(&handle);
    }
}

fn add_content_webview(app: &AppHandle, session_id: String, title: String) -> Result<Tab, String> {
    let (port, label, is_first) = {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        if inner.tabs.len() >= MAX_TABS {
            return Err(format!("最多 {MAX_TABS} 个标签"));
        }
        inner.next_index += 1;
        (inner.ui_port, format!("tab-{}", inner.next_index), inner.tabs.is_empty())
    };
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "missing main window".to_string())?;
    let (width, height) = logical_inner(&window)?;
    let (pos, size) = content_bounds(width, height);
    let url = Url::parse(&format!("http://127.0.0.1:{port}/?session={session_id}"))
        .map_err(|err| err.to_string())?;
    let handle = app.clone();
    let reveal_id = session_id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .focused(is_first)
        .background_color(SURFACE)
        .disable_drag_drop_handler()
        .on_document_title_changed(attach_title_listener(app, session_id.clone()))
        .on_page_load(move |_webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            reveal_tab(&handle, &reveal_id);
        });
    let webview = window
        .add_child(builder, pos, size)
        .map_err(|err| err.to_string())?;
    if !is_first {
        let _ = webview.hide();
    }
    let tab = Tab {
        session_id: session_id.clone(),
        webview_label: label,
        title,
        ready: is_first,
    };
    {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        inner.active = session_id.clone();
        inner.tabs.push(tab.clone());
    }
    if !is_first {
        let fallback = app.clone();
        let fallback_id = session_id;
        std::thread::spawn(move || {
            thread::sleep(Duration::from_millis(1200));
            let posted = fallback.clone();
            let _ = fallback.run_on_main_thread(move || reveal_tab(&posted, &fallback_id));
        });
    }
    let _ = layout_webviews(app);
    if is_first {
        focus_active(app);
    }
    emit_tabs(app);
    Ok(tab)
}

fn create_tab(app: &AppHandle) -> Result<Vec<TabInfo>, String> {
    let port = {
        let tabs = app.state::<Tabs>();
        let inner = tabs.lock();
        if inner.tabs.len() >= MAX_TABS {
            return Err(format!("最多 {MAX_TABS} 个标签"));
        }
        inner.ui_port
    };
    let session_id = hub_create_session(port).map_err(|err| err.to_string())?;
    add_content_webview(app, session_id, "本机".into())?;
    let tabs = app.state::<Tabs>();
    let inner = tabs.lock();
    Ok(snapshot(&inner))
}

/// WebView2 deadlocks if `add_child` runs on the IPC worker while the UI
/// thread is waiting on that same command (especially with zero content views).
fn run_on_webview_thread<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv().map_err(|err| err.to_string())?
}

fn quit_after_last_tab(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // Let `tab_close` finish and reply to the chrome webview first.
        thread::sleep(Duration::from_millis(50));
        let posted = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(window) = posted.get_window(WINDOW_LABEL) {
                let _ = window.close();
            }
            posted.exit(0);
        });
    });
}

fn close_tab(app: &AppHandle, session_id: &str) -> Result<Vec<TabInfo>, String> {
    let (webview_label, port, was_last) = {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        let index = inner
            .tabs
            .iter()
            .position(|tab| tab.session_id == session_id)
            .ok_or_else(|| "标签不存在".to_string())?;
        let tab = inner.tabs.remove(index);
        let was_last = inner.tabs.is_empty();
        if inner.active == session_id && !was_last {
            let next = inner.tabs.get(index).or_else(|| inner.tabs.get(index.saturating_sub(1)));
            inner.active = next.map(|tab| tab.session_id.clone()).unwrap_or_default();
        }
        (tab.webview_label, inner.ui_port, was_last)
    };
    if let Some(webview) = app.get_webview(&webview_label) {
        let _ = webview.close();
    }
    hub_delete_session(port, session_id);
    if was_last {
        quit_after_last_tab(app);
        return Ok(Vec::new());
    }
    let _ = layout_webviews(app);
    focus_active(app);
    emit_tabs(app);
    let tabs = app.state::<Tabs>();
    let inner = tabs.lock();
    Ok(snapshot(&inner))
}

fn switch_tab(app: &AppHandle, session_id: &str) -> Result<Vec<TabInfo>, String> {
    {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        if !inner.tabs.iter().any(|tab| tab.session_id == session_id) {
            return Err("标签不存在".into());
        }
        inner.active = session_id.to_string();
    }
    let _ = layout_webviews(app);
    focus_active(app);
    emit_tabs(app);
    let tabs = app.state::<Tabs>();
    let inner = tabs.lock();
    Ok(snapshot(&inner))
}

#[tauri::command]
async fn tab_new(app: AppHandle) -> Result<Vec<TabInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || run_on_webview_thread(move || create_tab(&app)))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn tab_close(app: AppHandle, id: String) -> Result<Vec<TabInfo>, String> {
    close_tab(&app, &id)
}

#[tauri::command]
async fn tab_switch(app: AppHandle, id: String) -> Result<Vec<TabInfo>, String> {
    switch_tab(&app, &id)
}

#[tauri::command]
fn tab_list(tabs: State<'_, Tabs>) -> Vec<TabInfo> {
    let inner = tabs.lock();
    snapshot(&inner)
}

fn boot_log(message: &str) {
    eprintln!("{message}");
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("npz-view-boot.log"))
            {
                let _ = writeln!(file, "{message}");
            }
        }
    }
}

fn start_hub(app: &AppHandle) -> Result<u16, String> {
    if cfg!(debug_assertions) {
        wait_http(DEV_UI_PORT, "/__hub/state", Duration::from_secs(90)).map_err(|err| err.to_string())?;
        return Ok(DEV_UI_PORT);
    }
    let root = find_repo_root().map_err(|err| err.to_string())?;
    let port = pick_free_port().map_err(|err| err.to_string())?;
    let child = spawn_hub(&root, port).map_err(|err| err.to_string())?;
    if let Ok(mut guard) = app.state::<HubShell>().0.lock() {
        *guard = Some(child);
    }
    wait_http(port, "/__hub/state", Duration::from_secs(90)).map_err(|err| err.to_string())?;
    Ok(port)
}

fn open_ui(app: &AppHandle, ui_port: u16) -> Result<(), String> {
    {
        let tabs = app.state::<Tabs>();
        let mut inner = tabs.lock();
        inner.ui_port = ui_port;
    }
    add_chrome(app)?;
    create_tab(app)?;
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "missing main window".to_string())?;
    window.show().map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

fn add_chrome(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "missing main window".to_string())?;
    let (width, _) = logical_inner(&window)?;
    let builder = WebviewBuilder::new(CHROME_LABEL, WebviewUrl::App("tabs.html".into()))
        .focused(false)
        .background_color(CHROME_SURFACE)
        .disable_drag_drop_handler();
    window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            chrome_size(width),
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(HubShell(Mutex::new(None)))
        .manage(Tabs(Mutex::new(TabsInner {
            ui_port: DEV_UI_PORT,
            next_index: 0,
            tabs: Vec::new(),
            active: String::new(),
        })))
        .invoke_handler(tauri::generate_handler![tab_new, tab_close, tab_switch, tab_list])
        .setup(|app| {
            // Create the window on the UI thread *before* the event loop runs.
            // An empty `windows` list plus a background-thread builder lets Tauri
            // see zero windows and exit immediately (portable zip flash-quit).
            let window = WindowBuilder::new(app, WINDOW_LABEL)
                .title("npz 浏览器")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .background_color(SURFACE)
                .visible(false)
                .build()?;
            let layout_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
                ) {
                    let _ = layout_webviews(&layout_handle);
                }
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match start_hub(&handle) {
                    Ok(port) => {
                        let ui = handle.clone();
                        let posted = handle.run_on_main_thread(move || {
                            if let Err(err) = open_ui(&ui, port) {
                                boot_log(&format!("npz-view 打开界面失败: {err}"));
                                ui.exit(1);
                            }
                        });
                        if let Err(err) = posted {
                            boot_log(&format!("npz-view 无法回到主线程: {err}"));
                            handle.exit(1);
                        }
                    }
                    Err(err) => {
                        boot_log(&format!("npz-view 启动失败: {err}"));
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_shell(app.state::<HubShell>().inner());
            }
        });
}
