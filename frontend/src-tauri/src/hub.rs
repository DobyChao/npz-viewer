//! Desktop control plane and streaming data bridge. No Node or static HTTP server.
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;

use crate::{
    profiles::{self, Profile},
    ssh::{self, Auth, Logger, Session},
};

struct Conn {
    state: &'static str,
    error: Option<String>,
    log: Vec<String>,
    reused: bool,
    started: bool,
    generation: u64,
    cancel: CancellationToken,
    session: Option<Arc<Session>>,
    port: Option<u16>,
    remote_dir: Option<String>,
    owner_session: Option<String>,
}

impl Default for Conn {
    fn default() -> Self {
        Self {
            state: "idle",
            error: None,
            log: vec![],
            reused: false,
            started: false,
            generation: 0,
            cancel: CancellationToken::new(),
            session: None,
            port: None,
            remote_dir: None,
            owner_session: None,
        }
    }
}

struct Inner {
    profiles: Vec<Profile>,
    sessions: HashMap<String, String>,
    connections: HashMap<String, Conn>,
}

pub struct Hub {
    pub root: PathBuf,
    pub token: String,
    pub port: u16,
    client: reqwest::Client,
    inner: Mutex<Inner>,
    local: Mutex<Option<Child>>,
    local_gate: tokio::sync::Mutex<()>,
    shutdown: CancellationToken,
}

impl Hub {
    pub fn start(root: PathBuf) -> Result<Arc<Self>> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let profiles = profiles::read(&profiles::path(&root))?;
        let hub = Arc::new(Self {
            root,
            port,
            token: uuid::Uuid::new_v4().simple().to_string(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()?,
            inner: Mutex::new(Inner {
                profiles,
                sessions: HashMap::from([("default".into(), "local".into())]),
                connections: HashMap::new(),
            }),
            local: Mutex::new(None),
            local_gate: tokio::sync::Mutex::new(()),
            shutdown: CancellationToken::new(),
        });
        let serve_hub = hub.clone();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("loopback listener");
            let cors = CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("http://tauri.localhost"),
                    HeaderValue::from_static("https://tauri.localhost"),
                    HeaderValue::from_static("tauri://localhost"),
                    HeaderValue::from_static("http://127.0.0.1:5273"),
                ])
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any)
                .expose_headers(tower_http::cors::Any);
            let router = Router::new()
                .fallback(any(handle))
                .layer(cors)
                .with_state(serve_hub.clone());
            let cancel = serve_hub.shutdown.clone();
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(cancel.cancelled_owned())
                .await
            {
                eprintln!("desktop data bridge: {error}");
            }
        });
        Ok(hub)
    }

    pub fn create_session(&self, id: Option<&str>) -> String {
        let id = id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("s_{}", uuid::Uuid::new_v4().simple()));
        self.inner
            .lock()
            .unwrap()
            .sessions
            .entry(id.clone())
            .or_insert_with(|| "local".into());
        id
    }

    pub fn state(&self, sid: &str) -> Value {
        let inner = self.inner.lock().unwrap();
        // Reading state must not recreate a tab closed during an async request.
        let active = inner
            .sessions
            .get(sid)
            .cloned()
            .unwrap_or_else(|| "local".into());
        let servers: Vec<Value> = inner
            .profiles
            .iter()
            .map(|profile| {
                let mut value = serde_json::to_value(profile).unwrap();
                let conn = inner.connections.get(&profile.id);
                let alive = conn.is_none_or(|c| c.session.as_ref().is_none_or(|s| !s.is_closed()));
                value["state"] = json!(if alive {
                    conn.map(|c| c.state).unwrap_or("idle")
                } else {
                    "error"
                });
                value["error"] = if alive {
                    json!(conn.and_then(|c| c.error.as_ref()))
                } else {
                    json!("SSH 连接已断开")
                };
                value["active"] = json!(active == profile.id);
                value["reused"] = json!(conn.is_some_and(|c| c.reused));
                value["startedByUs"] = json!(conn.is_some_and(|c| c.started));
                value["log"] = json!(conn.map(|c| &c.log).cloned().unwrap_or_default());
                value
            })
            .collect();
        json!({ "active": active, "localActive": active == "local", "servers": servers, "sessionId": sid, "sessions": inner.sessions })
    }

    fn set_active(&self, sid: &str, target: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.sessions.contains_key(sid) {
            bail!("标签页已关闭");
        }
        if target != "local"
            && !inner.connections.get(target).is_some_and(|c| {
                c.state == "active" && c.session.as_ref().is_some_and(|s| !s.is_closed())
            })
        {
            bail!("该服务器未连接");
        }
        inner.sessions.insert(sid.into(), target.into());
        Ok(())
    }

    fn profile(&self, id: &str) -> Result<Profile> {
        self.inner
            .lock()
            .unwrap()
            .profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .context("服务器不存在")
    }

    fn save_profile(&self, id: Option<&str>, value: Value) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| format!("server-{}", uuid::Uuid::new_v4().simple()));
        if inner
            .connections
            .get(&id)
            .is_some_and(|c| ["active", "connecting"].contains(&c.state))
        {
            bail!("请先断开再改配置");
        }
        let mut profiles = inner.profiles.clone();
        if let Some(index) = profiles.iter().position(|p| p.id == id) {
            let mut merged = serde_json::to_value(&profiles[index])?;
            for (key, value) in value.as_object().context("配置必须是对象")? {
                merged[key] = value.clone();
            }
            profiles[index] = Profile::from_value(merged, id)?;
        } else {
            profiles.push(Profile::from_value(value, id)?);
        }
        profiles::write(&profiles::path(&self.root), &profiles)?;
        inner.profiles = profiles;
        Ok(())
    }

    fn logger(self: &Arc<Self>, id: &str, generation: u64) -> Logger {
        let weak = Arc::downgrade(self);
        let id = id.to_string();
        Arc::new(move |line| {
            if let Some(hub) = weak.upgrade() {
                if let Some(conn) = hub.inner.lock().unwrap().connections.get_mut(&id) {
                    if conn.generation != generation {
                        return;
                    }
                    for line in line.lines().filter(|s| !s.trim().is_empty()) {
                        conn.log.push(line.to_string());
                    }
                    if conn.log.len() > 200 {
                        conn.log.drain(..conn.log.len() - 200);
                    }
                }
            }
        })
    }

    async fn healthy(&self, port: u16) -> bool {
        let request = self
            .client
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let Ok(response) = request else {
            return false;
        };
        if response.status() != 200 {
            return false;
        }
        response
            .text()
            .await
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|v| v["ok"] == true && v["version"].is_string())
    }

    async fn wait_health(&self, port: u16) -> Result<()> {
        let wait = async {
            loop {
                if self.healthy(port).await {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        };
        tokio::select! {
            _ = self.shutdown.cancelled() => bail!("客户端正在退出"),
            result = tokio::time::timeout(Duration::from_secs(25), wait) => result.context("后端健康检查超时")?,
        }
        Ok(())
    }

    async fn ensure_local(&self) -> Result<u16> {
        let _gate = self.local_gate.lock().await;
        if self.shutdown.is_cancelled() {
            bail!("客户端正在退出");
        }
        let port = std::env::var("NPZVIEW_BACKEND_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(8756);
        if self
            .local
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|child| child.try_wait().ok() == Some(None))
        {
            return Ok(port);
        }
        let bundled = self.root.join("runtime/python/python.exe");
        let bundled_posix = self.root.join("runtime/python/bin/python3");
        let portable = bundled.exists() || bundled_posix.exists();
        if !portable && self.healthy(port).await {
            return Ok(port);
        }
        if std::env::var("NPZVIEW_NO_LOCAL_BACKEND").as_deref() == Ok("1") {
            bail!("本机后端未运行，且已禁用自动启动");
        }
        // Portable distributions never silently attach to someone else's process.
        let probe = std::net::TcpListener::bind(("127.0.0.1", port)).with_context(|| {
            format!("本机端口 {port} 已被占用，请关闭其他后端或设置 NPZVIEW_BACKEND_PORT")
        })?;
        drop(probe);
        let local_venv = self.root.join(if cfg!(windows) {
            ".venv/Scripts/python.exe"
        } else {
            ".venv/bin/python"
        });
        let python = std::env::var_os("NPZVIEW_PYTHON")
            .map(PathBuf::from)
            .or_else(|| {
                [bundled, bundled_posix, local_venv]
                    .into_iter()
                    .find(|p| p.exists())
            })
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }));
        let log = std::fs::File::create(self.root.join("npz-view-backend.log"))?;
        let mut command = Command::new(&python);
        command
            .args([
                "-m",
                "app.main",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .current_dir(self.root.join("backend"))
            .env("PYTHONUTF8", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stderr(log.try_clone()?)
            .stdout(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        *self.local.lock().unwrap() = Some(
            command
                .spawn()
                .with_context(|| format!("无法启动 Python {python:?}"))?,
        );
        if let Err(error) = self.wait_health(port).await {
            if let Some(mut child) = self.local.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error.context("本机后端启动失败，请查看 npz-view-backend.log"));
        }
        Ok(port)
    }

    async fn connect(self: &Arc<Self>, id: &str, auth: Auth, sid: &str) -> Result<()> {
        let profile = self.profile(id)?;
        let (generation, cancel) = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.sessions.contains_key(sid) {
                bail!("标签页已关闭");
            }
            let conn = inner.connections.entry(id.into()).or_default();
            if conn.state == "connecting" {
                bail!("正在连接");
            }
            if conn.state == "active" && conn.session.as_ref().is_some_and(|s| !s.is_closed()) {
                inner.sessions.insert(sid.into(), id.into());
                return Ok(());
            }
            conn.cancel.cancel();
            conn.generation += 1;
            conn.cancel = self.shutdown.child_token();
            conn.state = "connecting";
            conn.error = None;
            conn.log.clear();
            conn.started = false;
            conn.reused = false;
            conn.port = None;
            conn.session = None;
            conn.owner_session = Some(sid.into());
            (conn.generation, conn.cancel.clone())
        };
        let log = self.logger(id, generation);
        log(&format!(
            "SSH {}@{}:{}（{}）",
            profile.user, profile.host, profile.port, auth.auth_method
        ));
        let work = async {
            let session = Arc::new(
                tokio::time::timeout(
                    Duration::from_secs(30),
                    ssh::login(&profile, &auth, &self.root, log.clone()),
                )
                .await
                .context("SSH 认证超时")??,
            );
            {
                let mut inner = self.inner.lock().unwrap();
                let conn = inner.connections.get_mut(id).context("连接已取消")?;
                if conn.generation != generation || cancel.is_cancelled() {
                    bail!("连接已取消");
                }
                conn.session = Some(session.clone());
            }
            let dir = ssh::remote_dir(&session, &profile.remote_dir).await?;
            let kind = ssh::probe(&session, &dir, profile.remote_port, &log).await?;
            let reused = kind == ssh::PortKind::Ours;
            if reused {
                log("复用已有健康后端，跳过 SFTP 和 pip");
            } else {
                ssh::sync(&session, &self.root, &dir, &log).await?;
                ssh::start(&session, &dir, profile.remote_port, &log).await?;
            }
            let port = ssh::tunnel(session.clone(), profile.remote_port, cancel.clone()).await?;
            self.wait_health(port).await?;
            {
                let mut inner = self.inner.lock().unwrap();
                if !inner.sessions.contains_key(sid) {
                    bail!("标签页已关闭");
                }
                let conn = inner.connections.get_mut(id).context("连接已取消")?;
                if conn.generation != generation || cancel.is_cancelled() {
                    bail!("连接已取消");
                }
                conn.port = Some(port);
                conn.remote_dir = Some(dir);
                conn.reused = reused;
                conn.started = !reused;
                conn.state = "active";
                conn.owner_session = None;
                inner.sessions.insert(sid.into(), id.into());
                // Only non-secret authentication preferences are persisted.
                let mut profiles = inner.profiles.clone();
                if let Some(saved) = profiles.iter_mut().find(|p| p.id == id) {
                    saved.auth_method = auth.auth_method.clone();
                    if auth.auth_method == "key" {
                        saved.key_path = auth.key_path.clone().or(saved.key_path.clone());
                    }
                }
                profiles::write(&profiles::path(&self.root), &profiles)?;
                inner.profiles = profiles;
            }
            log("连接就绪");
            Ok::<_, anyhow::Error>(())
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = work => result,
        };
        if let Err(error) = &result {
            cancel.cancel();
            let session = {
                let mut inner = self.inner.lock().unwrap();
                if let Some(conn) = inner
                    .connections
                    .get_mut(id)
                    .filter(|c| c.generation == generation)
                {
                    conn.state = "error";
                    conn.error = Some(format!("{error:#}"));
                    conn.port = None;
                    conn.session.take()
                } else {
                    None
                }
            };
            if let Some(session) = session {
                ssh::close(&session).await;
            }
        }
        result
    }

    async fn disconnect(&self, id: &str, sid: Option<&str>, force: bool) -> Result<()> {
        let (session, dir, started, profile) = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(sid) = sid {
                if inner.sessions.get(sid).is_some_and(|s| s == id) {
                    inner.sessions.insert(sid.into(), "local".into());
                }
            }
            let connecting = inner
                .connections
                .get(id)
                .is_some_and(|c| c.state == "connecting");
            if !force && !connecting && inner.sessions.values().any(|target| target == id) {
                return Ok(());
            }
            let profile = inner.profiles.iter().find(|p| p.id == id).cloned();
            let conn = inner.connections.entry(id.into()).or_default();
            conn.cancel.cancel();
            conn.generation += 1;
            let result = (
                conn.session.take(),
                conn.remote_dir.take(),
                conn.started,
                profile,
            );
            conn.state = "idle";
            conn.error = None;
            conn.started = false;
            conn.reused = false;
            conn.port = None;
            for target in inner.sessions.values_mut() {
                if target == id {
                    *target = "local".into();
                }
            }
            result
        };
        if let Some(session) = session {
            if started {
                if let (Some(dir), Some(profile)) = (dir, profile) {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(8),
                        ssh::stop(&session, &dir, profile.remote_port),
                    )
                    .await;
                }
            }
            ssh::close(&session).await;
        }
        Ok(())
    }

    pub async fn delete_session(&self, sid: &str) -> Result<()> {
        if sid == "default" {
            return Ok(());
        }
        let target = self.inner.lock().unwrap().sessions.remove(sid);
        if let Some(target) = target.filter(|s| s != "local") {
            self.disconnect(&target, None, false).await?;
        }
        let connecting: Vec<String> = self
            .inner
            .lock()
            .unwrap()
            .connections
            .iter()
            .filter(|(_, c)| c.state == "connecting" && c.owner_session.as_deref() == Some(sid))
            .map(|(id, _)| id.clone())
            .collect();
        for id in connecting {
            self.disconnect(&id, None, false).await?;
        }
        Ok(())
    }

    async fn control(
        self: &Arc<Self>,
        method: &Method,
        path: &str,
        sid: &str,
        value: Value,
    ) -> Result<Value> {
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        match (method.as_str(), parts.as_slice()) {
            ("GET", ["state"]) => {}
            ("POST", ["sessions"]) => {
                let id = self.create_session(value["id"].as_str());
                return Ok(json!({ "id": id, "state": self.state(&id) }));
            }
            ("DELETE", ["sessions", id]) => {
                self.delete_session(id).await?;
                return Ok(json!({ "ok": true }));
            }
            ("POST", ["sessions", id, "active"]) => {
                self.set_active(id, value["target"].as_str().unwrap_or("local"))?;
            }
            ("POST", ["active"]) => {
                self.set_active(sid, value["target"].as_str().unwrap_or("local"))?;
            }
            ("POST", ["servers"]) => {
                self.save_profile(None, value)?;
            }
            ("PATCH", ["servers", id]) => {
                self.profile(id)?;
                self.save_profile(Some(id), value)?;
            }
            ("DELETE", ["servers", id]) => {
                self.disconnect(id, None, true).await?;
                let mut inner = self.inner.lock().unwrap();
                let profiles: Vec<Profile> = inner
                    .profiles
                    .iter()
                    .filter(|p| p.id != *id)
                    .cloned()
                    .collect();
                profiles::write(&profiles::path(&self.root), &profiles)?;
                inner.profiles = profiles;
                inner.connections.remove(*id);
            }
            ("POST", ["servers", id, "connect"]) => {
                self.connect(id, serde_json::from_value(value)?, sid)
                    .await?;
            }
            ("POST", ["servers", id, "disconnect"]) => {
                self.disconnect(id, Some(sid), false).await?;
            }
            ("POST", ["servers", id, "restart"]) => {
                self.restart(id).await?;
            }
            _ => bail!("未知的桌面管理请求"),
        }
        Ok(self.state(sid))
    }

    async fn restart(self: &Arc<Self>, id: &str) -> Result<()> {
        let profile = self.profile(id)?;
        let (session, dir, cancel, generation) = {
            let mut inner = self.inner.lock().unwrap();
            let conn = inner.connections.get_mut(id).context("该服务器未连接")?;
            if conn.state != "active" {
                bail!("该服务器未连接");
            }
            conn.state = "connecting";
            (
                conn.session.clone().context("SSH 已断开")?,
                conn.remote_dir.clone().context("远端目录未知")?,
                conn.cancel.clone(),
                conn.generation,
            )
        };
        let log = self.logger(id, generation);
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = async {
                ssh::sync(&session, &self.root, &dir, &log).await?;
                ssh::stop(&session, &dir, profile.remote_port).await?;
                tokio::time::sleep(Duration::from_millis(400)).await;
                ssh::start(&session, &dir, profile.remote_port, &log).await?;
                let port = { self.inner.lock().unwrap().connections[id].port.context("隧道已断开")? };
                self.wait_health(port).await
            } => result,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(conn) = inner
                .connections
                .get_mut(id)
                .filter(|c| c.generation == generation)
            {
                conn.state = if result.is_ok() { "active" } else { "error" };
                conn.error = result.as_ref().err().map(|e| format!("{e:#}"));
                conn.started = true;
                conn.reused = false;
            }
        }
        result
    }

    async fn target(&self, sid: &str) -> Result<u16> {
        let remote = {
            let inner = self.inner.lock().unwrap();
            let target = inner.sessions.get(sid).context("标签页会话不存在")?;
            if target == "local" {
                None
            } else {
                let conn = inner.connections.get(target).context("远端未连接")?;
                if conn.state != "active" || conn.session.as_ref().is_none_or(|s| s.is_closed()) {
                    bail!("SSH 未连接");
                }
                Some(conn.port.context("远端隧道未就绪")?)
            }
        };
        match remote {
            Some(port) => Ok(port),
            None => self.ensure_local().await,
        }
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
        for conn in self.inner.lock().unwrap().connections.values_mut() {
            conn.cancel.cancel();
            conn.session.take();
        }
        if let Some(mut child) = self.local.lock().unwrap().take() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn query_parts(raw: &str) -> (Option<String>, Option<String>, String) {
    let mut token = None;
    let mut sid = None;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "npzview_token" => token = Some(value.into_owned()),
            "npzview_session" => sid = Some(value.into_owned()),
            _ => {
                query.append_pair(&key, &value);
            }
        }
    }
    (token, sid, query.finish())
}

fn hop_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "x-npzview-token"
            | "x-npzview-session"
            | "origin"
    )
}

async fn handle(State(hub): State<Arc<Hub>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let (token, query_sid, query) = query_parts(parts.uri.query().unwrap_or(""));
    let header_token = parts
        .headers
        .get("x-npzview-token")
        .and_then(|v| v.to_str().ok());
    if header_token.or(token.as_deref()) != Some(hub.token.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "无效的桌面连接令牌" })),
        )
            .into_response();
    }
    let sid = parts
        .headers
        .get("x-npzview-session")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or(query_sid)
        .unwrap_or_else(|| "default".into());
    let path = parts.uri.path();
    if let Some(path) = path.strip_prefix("/__hub/") {
        let result = async {
            let bytes = to_bytes(body, 1024 * 1024).await?;
            let value = if bytes.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&bytes)?
            };
            hub.control(&parts.method, path, &sid, value).await
        }
        .await;
        return match result {
            Ok(value) => Json(value).into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("{error:#}"), "state": hub.state(&sid) })),
            )
                .into_response(),
        };
    }
    if !path.starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = async {
        let port = hub.target(&sid).await?;
        let url = format!(
            "http://127.0.0.1:{port}{path}{}",
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        );
        let headers: HeaderMap = parts
            .headers
            .iter()
            .filter(|(name, _)| !hop_header(name.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let bytes = to_bytes(body, 16 * 1024 * 1024).await?;
        let response = hub
            .client
            .request(parts.method, url)
            .headers(headers)
            .body(bytes)
            .send()
            .await?;
        let mut builder = Response::builder().status(response.status());
        for (name, value) in response.headers() {
            if !hop_header(name.as_str()) {
                builder = builder.header(name, value);
            }
        }
        Ok::<_, anyhow::Error>(builder.body(Body::from_stream(response.bytes_stream()))?)
    }
    .await;
    match result {
        Ok(response) => response,
        Err(error) => (StatusCode::BAD_GATEWAY, Json(json!({ "detail": { "code": "BACKEND_UNREACHABLE", "message": format!("后端不可达：{error:#}"), "hint": "请检查服务器连接或 npz-view-backend.log" } }))).into_response(),
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
