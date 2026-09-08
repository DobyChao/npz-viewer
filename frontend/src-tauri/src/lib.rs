//! Desktop window around the existing Node hub.
//!
//! Dev (`tauri dev`): Vite already has ssh2 via hubPlugin; the webview just
//! opens http://127.0.0.1:5273.
//! Release: spawn `scripts/npz-view.mjs` (Python backend + vite preview + hub),
//! wait until /__hub is up, then point the webview at the same URL.

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
    Err("找不到仓库根目录（缺少 scripts/npz-view.mjs）。请从克隆下来的仓库运行客户端。".into())
}

fn node_bin() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn spawn_hub(root: &Path) -> Result<Child, BoxError> {
    let script = root.join("scripts").join("npz-view.mjs");
    let mut cmd = Command::new(node_bin());
    cmd.arg(&script)
        .current_dir(root)
        .stdin(Stdio::null());

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
        .map_err(|err| format!("启动 Node 客户端壳失败 ({script:?}): {err}"))?)
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
        "等待 http://127.0.0.1:{port}{path} 超时。确认已 npm install / npm run build，且本机有 Python。"
    )
    .into())
}

fn kill_shell(shell: &HubShell) {
    if let Ok(mut guard) = shell.0.lock() {
        if let Some(mut child) = guard.take() {
            // SIGTERM so npz-view.mjs can stop Python / vite; then force-kill.
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
