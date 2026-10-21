//! Native desktop window, sessions, SSH and lazy Python processing backend.
mod hub;
mod profiles;
mod ssh;

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{Color, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl, Window,
    WindowEvent,
};

struct Desktop(Arc<hub::Hub>);
const MAX_TABS: usize = 6;
const CHROME_H: f64 = 36.0;
const CHROME_LABEL: &str = "tabs-chrome";
const WINDOW_LABEL: &str = "main";
const SURFACE: Color = Color(9, 9, 11, 255);
const CHROME_SURFACE: Color = Color(24, 24, 27, 255);

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

fn find_repo_root() -> Result<PathBuf, String> {
    let mut starts = Vec::new();
    if let Ok(root) = std::env::var("NPZVIEW_ROOT") {
        starts.push(PathBuf::from(root));
    }
    // Prefer the executable's portable resources over an unrelated current directory.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for mut dir in starts {
        loop {
            if dir.join("backend/app/main.py").is_file() && dir.join("requirements.txt").is_file() {
                return Ok(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    Err("找不到 backend/app 和 requirements.txt，请完整解压便携 zip 后再运行".into())
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
        let Some(tab) = inner
            .tabs
            .iter_mut()
            .find(|tab| tab.session_id == session_id)
        else {
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

fn attach_title_listener(
    app: &AppHandle,
    session_id: String,
) -> impl Fn(Webview, String) + Send + 'static {
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
        (
            inner.ui_port,
            format!("tab-{}", inner.next_index),
            inner.tabs.is_empty(),
        )
    };
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "missing main window".to_string())?;
    let (width, height) = logical_inner(&window)?;
    let (pos, size) = content_bounds(width, height);
    let desktop = app.state::<Desktop>();
    let config = serde_json::json!({
        "origin": format!("http://127.0.0.1:{port}"), "token": desktop.0.token,
    });
    let handle = app.clone();
    let reveal_id = session_id.clone();
    let builder = WebviewBuilder::new(
        &label,
        WebviewUrl::App(format!("index.html?session={session_id}").into()),
    )
    .initialization_script(format!("window.__NPZVIEW_DESKTOP__ = {config};"))
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
    let _ = port;
    let session_id = app.state::<Desktop>().0.create_session(None);
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
            let next = inner
                .tabs
                .get(index)
                .or_else(|| inner.tabs.get(index.saturating_sub(1)));
            inner.active = next.map(|tab| tab.session_id.clone()).unwrap_or_default();
        }
        (tab.webview_label, inner.ui_port, was_last)
    };
    if let Some(webview) = app.get_webview(&webview_label) {
        let _ = webview.close();
    }
    let _ = port;
    let desktop = app.state::<Desktop>().0.clone();
    let closed_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = desktop.delete_session(&closed_id).await;
    });
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
    let root = find_repo_root()?;
    let hub = hub::Hub::start(root).map_err(|err| format!("{err:#}"))?;
    let port = hub.port;
    app.manage(Desktop(hub));
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
        .add_child(builder, LogicalPosition::new(0.0, 0.0), chrome_size(width))
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Tabs(Mutex::new(TabsInner {
            ui_port: 0,
            next_index: 0,
            tabs: Vec::new(),
            active: String::new(),
        })))
        .invoke_handler(tauri::generate_handler![
            tab_new, tab_close, tab_switch, tab_list
        ])
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
            std::thread::spawn(move || match start_hub(&handle) {
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
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(desktop) = app.try_state::<Desktop>() {
                    desktop.0.shutdown();
                }
            }
        });
}
