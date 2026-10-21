use super::*;
use russh::{
    keys::{Algorithm, PrivateKey, PublicKey},
    server, Channel, ChannelId,
};
use russh_sftp::protocol::{Attrs, FileAttributes, Handle, OpenFlags, Status, StatusCode};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::copy_bidirectional;

type Files = Arc<Mutex<HashMap<String, (FileAttributes, Vec<u8>)>>>;

struct MemorySftp(Files);
fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: "en".into(),
    }
}
impl russh_sftp::server::Handler for MemorySftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn stat(&mut self, id: u32, path: String) -> std::result::Result<Attrs, StatusCode> {
        let files = self.0.lock().unwrap();
        Ok(Attrs {
            id,
            attrs: files.get(&path).ok_or(StatusCode::NoSuchFile)?.0.clone(),
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        mut attrs: FileAttributes,
    ) -> std::result::Result<Status, StatusCode> {
        attrs.set_dir(true);
        self.0.lock().unwrap().insert(path, (attrs, vec![]));
        Ok(status(id))
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        _: OpenFlags,
        attrs: FileAttributes,
    ) -> std::result::Result<Handle, StatusCode> {
        self.0.lock().unwrap().insert(path.clone(), (attrs, vec![]));
        Ok(Handle { id, handle: path })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> std::result::Result<Status, StatusCode> {
        let mut files = self.0.lock().unwrap();
        let (attrs, contents) = files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        contents.resize(contents.len().max(offset as usize + data.len()), 0);
        contents[offset as usize..offset as usize + data.len()].copy_from_slice(&data);
        attrs.size = Some(contents.len() as u64);
        Ok(status(id))
    }
    async fn close(&mut self, id: u32, _: String) -> std::result::Result<Status, StatusCode> {
        Ok(status(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> std::result::Result<Status, StatusCode> {
        let mut files = self.0.lock().unwrap();
        let (existing, _) = files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        existing.mtime = attrs.mtime;
        existing.atime = attrs.atime;
        Ok(status(id))
    }
}

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("npzview-native-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
struct FakeSsh {
    input: HashMap<ChannelId, Vec<u8>>,
    commands: HashMap<ChannelId, String>,
    execs: Arc<AtomicUsize>,
    sftps: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    slow_auth: bool,
    owner: u64,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<server::Msg>>>>,
    files: Files,
}

impl server::Server for FakeSsh {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        let mut client = self.clone();
        client.channels = Arc::new(Mutex::new(HashMap::new()));
        client
    }
}

impl server::Handler for FakeSsh {
    type Error = anyhow::Error;
    async fn auth_password(&mut self, _: &str, password: &str) -> Result<server::Auth> {
        if self.slow_auth {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        Ok(if password == "test-password" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(&mut self, _: &str, _: &PublicKey) -> Result<server::Auth> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<()> {
        self.channels.lock().unwrap().insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<()> {
        self.execs.fetch_add(1, Ordering::SeqCst);
        self.commands
            .insert(channel, String::from_utf8_lossy(command).to_string());
        session.channel_success(channel)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        session: &mut server::Session,
    ) -> Result<()> {
        self.sftps.fetch_add(1, Ordering::SeqCst);
        let stream = self
            .channels
            .lock()
            .unwrap()
            .remove(&channel)
            .unwrap()
            .into_stream();
        session.channel_success(channel)?;
        let handler = MemorySftp(self.files.clone());
        tokio::spawn(async move {
            russh_sftp::server::run(stream, handler).await;
        });
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _: &mut server::Session,
    ) -> Result<()> {
        self.input
            .entry(channel)
            .or_default()
            .extend_from_slice(data);
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<()> {
        let input = String::from_utf8_lossy(
            self.input
                .get(&channel)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        let command = self
            .commands
            .get(&channel)
            .map(String::as_str)
            .unwrap_or("");
        let output = if command.contains("printf") {
            "/home/test".to_string()
        } else if input.contains("uids = []") {
            json!({ "me": 1000, "uids": [self.owner] }).to_string()
        } else if input.contains("urllib.request") {
            json!({ "kind": "http", "status": 200, "body": "{\"ok\":true,\"version\":\"test\"}" })
                .to_string()
        } else {
            if input.contains("backend stop requested") || input.contains("SIGTERM") {
                self.stops.fetch_add(1, Ordering::SeqCst);
            }
            "ok".to_string()
        };
        session.data(channel, output.into_bytes())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<()> {
        let mut tcp = tokio::net::TcpStream::connect((host, port as u16)).await?;
        reply.accept().await;
        tokio::spawn(async move {
            let _ = copy_bidirectional(&mut tcp, &mut channel.into_stream()).await;
        });
        Ok(())
    }
}

struct Fixture {
    temp: Temp,
    hub: Arc<Hub>,
    ssh_port: u16,
    backend_port: u16,
    execs: Arc<AtomicUsize>,
    sftps: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    files: Files,
}

impl Fixture {
    async fn new(slow_auth: bool, owner: u64) -> Self {
        use russh::server::Server;
        let temp = Temp::new();
        let hub = Hub::start(temp.0.clone()).unwrap();
        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_port = backend.local_addr().unwrap().port();
        let backend_task = tokio::spawn(async move {
            let app = Router::new().fallback(any(|request: Request| async move {
                if request.uri().path() == "/api/health" { Json(json!({ "ok": true, "version": "test" })) }
                else { Json(json!({ "path": request.uri().to_string(), "method": request.method().as_str() })) }
            }));
            axum::serve(backend, app).await.unwrap();
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ssh_port = listener.local_addr().unwrap().port();
        let execs = Arc::new(AtomicUsize::new(0));
        let sftps = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let files = Arc::new(Mutex::new(HashMap::new()));
        let mut server = FakeSsh {
            input: HashMap::new(),
            commands: HashMap::new(),
            execs: execs.clone(),
            sftps: sftps.clone(),
            stops: stops.clone(),
            slow_auth,
            owner,
            channels: Arc::new(Mutex::new(HashMap::new())),
            files: files.clone(),
        };
        let config = Arc::new(server::Config {
            keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let ssh_task = tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        Self {
            temp,
            hub,
            ssh_port,
            backend_port,
            execs,
            sftps,
            stops,
            tasks: vec![backend_task, ssh_task],
            files,
        }
    }
    fn add(&self, id: &str) {
        let value = json!({ "host": "127.0.0.1", "user": "test", "port": self.ssh_port,
            "remotePort": self.backend_port, "remoteDir": "~/.npz-viewer-backend", "name": id });
        let profile = Profile::from_value(value, id.into()).unwrap();
        self.hub.inner.lock().unwrap().profiles.push(profile);
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Value,
        token: bool,
    ) -> (axum::http::StatusCode, Value) {
        let request = self
            .hub
            .client
            .request(method, format!("http://127.0.0.1:{}{path}", self.hub.port));
        let request = if token {
            request.header("x-npzview-token", &self.hub.token)
        } else {
            request
        };
        let response = request
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        let status = response.status();
        (
            status,
            serde_json::from_str(&response.text().await.unwrap()).unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.hub.shutdown();
        for task in &self.tasks {
            task.abort();
        }
    }
}

fn password() -> Auth {
    Auth {
        auth_method: "password".into(),
        password: Some("test-password".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn bridge_auth_and_window_start_do_not_require_python_or_node() {
    let fixture = Fixture::new(false, 1000).await;
    assert!(fixture.hub.local.lock().unwrap().is_none());
    let (status, _) = fixture
        .request(Method::GET, "/__hub/state", json!({}), false)
        .await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    let (_, value) = fixture
        .request(Method::POST, "/__hub/sessions", json!({}), true)
        .await;
    assert!(value["id"].as_str().unwrap().starts_with("s_"));
    assert!(fixture.hub.local.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_ssh_reuses_healthy_backend_and_preserves_sessions_and_image_versions() {
    let fixture = Fixture::new(false, 1000).await;
    fixture.add("remote");
    let first = fixture.hub.create_session(None);
    let second = fixture.hub.create_session(None);
    fixture
        .hub
        .connect("remote", password(), &first)
        .await
        .unwrap();
    let state = fixture.hub.state(&first);
    assert_eq!(state["servers"][0]["reused"], true);
    assert_eq!(state["servers"][0]["startedByUs"], false);
    assert_eq!(fixture.sftps.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.execs.load(Ordering::SeqCst), 3); // home, ownership, health
    assert_eq!(fixture.hub.state(&second)["active"], "local");
    fixture.hub.set_active(&second, "remote").unwrap();
    let path = format!("/api/npz/render?path=%2Fdata%2Fframe.npz&v=123_456&npzview_session={first}&npzview_token={}", fixture.hub.token);
    let (_, response) = fixture.request(Method::GET, &path, json!({}), false).await;
    assert_eq!(
        response["path"],
        "/api/npz/render?path=%2Fdata%2Fframe.npz&v=123_456"
    );
    fixture.hub.delete_session(&first).await.unwrap();
    assert_eq!(fixture.hub.state(&second)["active"], "remote");
    assert_eq!(fixture.hub.state(&second)["servers"][0]["state"], "active");
    fixture.hub.delete_session(&second).await.unwrap();
    assert_eq!(fixture.stops.load(Ordering::SeqCst), 0); // reused remote is never stopped
    let saved = std::fs::read_to_string(fixture.temp.0.join("servers.json")).unwrap();
    assert!(!saved.contains("test-password"));
    assert!(!saved.contains("passphrase"));
    assert!(fixture.hub.local.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_ssh_supports_encrypted_private_keys() {
    let fixture = Fixture::new(false, 1000).await;
    fixture.add("key");
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .unwrap()
        .encrypt(&mut rand::rng(), "test-passphrase")
        .unwrap();
    let path = fixture.temp.0.join("encrypted-key");
    std::fs::write(
        &path,
        key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let sid = fixture.hub.create_session(None);
    fixture
        .hub
        .connect(
            "key",
            Auth {
                auth_method: "key".into(),
                key_path: Some(path.to_string_lossy().into_owned()),
                passphrase: Some("test-passphrase".into()),
                ..Default::default()
            },
            &sid,
        )
        .await
        .unwrap();
    assert_eq!(fixture.hub.state(&sid)["active"], "key");
    assert!(
        !std::fs::read_to_string(fixture.temp.0.join("servers.json"))
            .unwrap()
            .contains("test-passphrase")
    );
}

#[tokio::test]
async fn closing_a_tab_cancels_authentication_without_deploying_or_resurrecting_session() {
    let fixture = Fixture::new(true, 1000).await;
    fixture.add("slow");
    let sid = fixture.hub.create_session(None);
    let hub = fixture.hub.clone();
    let connecting_sid = sid.clone();
    let connect =
        tokio::spawn(async move { hub.connect("slow", password(), &connecting_sid).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    fixture.hub.delete_session(&sid).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), connect)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!fixture
        .hub
        .inner
        .lock()
        .unwrap()
        .sessions
        .contains_key(&sid));
    fixture.hub.state(&sid);
    assert!(!fixture
        .hub
        .inner
        .lock()
        .unwrap()
        .sessions
        .contains_key(&sid));
    assert_eq!(fixture.execs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.sftps.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn another_users_backend_is_rejected_before_sftp_or_start() {
    let fixture = Fixture::new(false, 2000).await;
    fixture.add("other");
    let sid = fixture.hub.create_session(None);
    let error = fixture
        .hub
        .connect("other", password(), &sid)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("其他用户"));
    assert_eq!(fixture.sftps.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.hub.state(&sid)["active"], "local");
}

#[test]
fn probing_only_deploys_when_idle_is_proven() {
    let ownership = json!({ "uids": [], "me": 1000 });
    assert_eq!(
        ssh::classify_probe(&ownership, &json!({ "kind": "refused" })).unwrap(),
        ssh::PortKind::Idle
    );
    assert!(ssh::classify_probe(
        &ownership,
        &json!({ "kind": "blocked", "detail": "timeout" })
    )
    .is_err());
    assert!(ssh::classify_probe(&ownership, &json!({ "kind": "http", "status": 200 })).is_err());
    assert!(ssh::classify_probe(
        &json!({ "uids": [1000], "me": 1000 }),
        &json!({ "kind": "refused" })
    )
    .is_err());
    assert_eq!(ssh::quote("/home/a'b/$x`cmd`"), "'/home/a'\"'\"'b/$x`cmd`'");
}

#[tokio::test]
async fn sftp_deployment_is_incremental_and_never_removes_remote_state() {
    let fixture = Fixture::new(false, 1000).await;
    fixture.add("sync");
    std::fs::create_dir_all(fixture.temp.0.join("backend/app/__pycache__")).unwrap();
    std::fs::write(fixture.temp.0.join("requirements.txt"), "numpy\n").unwrap();
    std::fs::write(
        fixture.temp.0.join("backend/app/main.py"),
        "print('test')\n",
    )
    .unwrap();
    std::fs::write(
        fixture.temp.0.join("backend/app/__pycache__/skip.pyc"),
        "ignored",
    )
    .unwrap();
    let log: Logger = Arc::new(|_| {});
    let session = ssh::login(
        &fixture.hub.profile("sync").unwrap(),
        &password(),
        &fixture.temp.0,
        log.clone(),
    )
    .await
    .unwrap();
    fixture.files.lock().unwrap().insert(
        "/remote/roots.json".into(),
        (FileAttributes::default(), b"keep".to_vec()),
    );
    ssh::sync(&session, &fixture.temp.0, "/remote", &log)
        .await
        .unwrap();
    assert_eq!(
        fixture.files.lock().unwrap()["/remote/backend/app/main.py"].1,
        b"print('test')\n"
    );
    fixture
        .files
        .lock()
        .unwrap()
        .get_mut("/remote/backend/app/main.py")
        .unwrap()
        .1 = b"sentinel".to_vec();
    ssh::sync(&session, &fixture.temp.0, "/remote", &log)
        .await
        .unwrap();
    assert_eq!(
        fixture.files.lock().unwrap()["/remote/backend/app/main.py"].1,
        b"sentinel"
    );
    assert_eq!(
        fixture.files.lock().unwrap()["/remote/roots.json"].1,
        b"keep"
    );
    assert!(!fixture
        .files
        .lock()
        .unwrap()
        .keys()
        .any(|path| path.contains("__pycache__")));
    ssh::close(&session).await;
}
