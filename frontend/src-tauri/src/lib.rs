//! Desktop window around the existing Node hub.
//!
//! Dev (`tauri dev`): Vite already has ssh2 via hubPlugin; the webview just
//! opens http://127.0.0.1:5273.
//! Release: spawn `scripts/npz-view.mjs` (Python backend + UI/hub), wait until
//! /__hub is up, then point the webview at the same URL.
//! Portable zip: Node and Python live under `runtime/` next to the exe.

use std::error::Error;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use url::Url;

struct HubShell(Mutex<Option<Child>>);

const UI_PORT: u16 = 5273;

type BoxError = Box<dyn Error>;

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

fn spawn_hub(root: &Path) -> Result<Child, BoxError> {
    let script = root.join("scripts").join("npz-view.mjs");
    let node = node_bin(root);
    let portable = bundled_node(root).is_some();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .current_dir(root)
        .stdin(Stdio::null())
        .env("NPZVIEW_ROOT", root);
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

fn kill_shell(shell: &HubShell) {
    if let Ok(mut guard) = shell.0.lock() {
        if let Some(mut child) = guard.take() {
            // SIGTERM so npz-view.mjs can stop Python / hub; then force-kill.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(HubShell(Mutex::new(None)))
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("missing main window")?;

            if cfg!(debug_assertions) {
                window.show()?;
                return Ok(());
            }

            let root = find_repo_root()?;
            let child = spawn_hub(&root)?;
            if let Ok(mut guard) = app.state::<HubShell>().0.lock() {
                *guard = Some(child);
            }
            wait_http(UI_PORT, "/__hub/state", Duration::from_secs(90))?;
            let url = Url::parse(&format!("http://127.0.0.1:{UI_PORT}/"))?;
            window.navigate(url)?;
            window.show()?;
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
