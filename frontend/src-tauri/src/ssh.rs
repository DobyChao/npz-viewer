//! Native SSH transport. Remote scripts are shared with the browser's Node hub.
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use russh::{
    client,
    keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use serde::Deserialize;
use serde_json::Value;
use tokio::{io::copy_bidirectional, net::TcpListener};
use tokio_util::sync::CancellationToken;

use crate::profiles::Profile;

pub type Logger = Arc<dyn Fn(&str) + Send + Sync>;
pub type Session = client::Handle<HostKey>;
pub const BOOTSTRAP: &str = include_str!("../../../scripts/remote/bootstrap_sh.sh");
const OWNERSHIP: &str = include_str!("../../../scripts/remote/ownership_py.py");
const HEALTH: &str = include_str!("../../../scripts/remote/health_py.py");
const STOP: &str = include_str!("../../../scripts/remote/stop_sh.sh");
const KILL: &str = include_str!("../../../scripts/remote/kill_ours_py.py");

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    #[serde(default)]
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

pub struct HostKey {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    log: Logger,
}

impl client::Handler for HostKey {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            bail!("暂不支持 SSH 主机证书，请使用普通主机密钥");
        };
        // Respect existing OpenSSH trust, then keep first-use keys with portable state.
        if let Some(home) = std::env::home_dir() {
            if keys::check_known_hosts_path(
                &self.host,
                self.port,
                key,
                home.join(".ssh/known_hosts"),
            )? {
                return Ok(true);
            }
        }
        if !keys::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts)? {
            keys::known_hosts::learn_known_hosts_path(
                &self.host,
                self.port,
                key,
                &self.known_hosts,
            )?;
            (self.log)("首次连接：已记录 SSH 主机密钥；后续连接将检查是否改变");
        }
        Ok(true)
    }
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn prefix(dir: &str, port: u16) -> String {
    format!(
        "PYTHONUNBUFFERED=1 NPZVIEW_DIR={} NPZVIEW_PORT={port}",
        quote(dir)
    )
}

pub async fn login(profile: &Profile, auth: &Auth, root: &Path, log: Logger) -> Result<Session> {
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let handler = HostKey {
        host: profile.host.clone(),
        port: profile.port,
        known_hosts: root.join(".npzview-known-hosts"),
        log,
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(
            Arc::new(config),
            (profile.host.as_str(), profile.port),
            handler,
        ),
    )
    .await
    .context("SSH 连接超时")?
    .context("SSH 连接或主机密钥检查失败")?;
    let success = match auth.auth_method.as_str() {
        "password" => {
            let password = auth
                .password
                .as_deref()
                .filter(|s| !s.is_empty())
                .context("请输入密码")?;
            if session
                .authenticate_password(&profile.user, password)
                .await?
                .success()
            {
                true
            } else {
                let mut response = session
                    .authenticate_keyboard_interactive_start(&profile.user, None::<String>)
                    .await?;
                loop {
                    match response {
                        client::KeyboardInteractiveAuthResponse::Success => break true,
                        client::KeyboardInteractiveAuthResponse::Failure { .. } => break false,
                        client::KeyboardInteractiveAuthResponse::InfoRequest {
                            prompts, ..
                        } => {
                            response = session
                                .authenticate_keyboard_interactive_respond(
                                    prompts.iter().map(|_| password.to_string()).collect(),
                                )
                                .await?;
                        }
                    }
                }
            }
        }
        "key" => {
            let path = auth
                .key_path
                .as_ref()
                .or(profile.key_path.as_ref())
                .context("请填写私钥文件路径")?;
            let path =
                if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
                    std::env::home_dir().context("无法获取用户目录")?.join(rest)
                } else {
                    PathBuf::from(path)
                };
            let key =
                keys::load_secret_key(path, auth.passphrase.as_deref().filter(|s| !s.is_empty()))
                    .context("无法读取私钥，请检查路径及口令")?;
            let hash = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(
                    &profile.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await?
                .success()
        }
        _ => authenticate_agent(&mut session, &profile.user).await?,
    };
    if !success {
        bail!("认证失败（密码或密钥不对，或服务器拒绝）");
    }
    Ok(session)
}

async fn authenticate_agent(session: &mut Session, user: &str) -> Result<bool> {
    #[cfg(windows)]
    let mut agent = keys::agent::client::AgentClient::connect_named_pipe(
        std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".into()),
    )
    .await
    .context("无法连接 Windows ssh-agent，请启动服务或改用密码/私钥")?;
    #[cfg(unix)]
    let mut agent = keys::agent::client::AgentClient::connect_env()
        .await
        .context("没有可用的 ssh-agent，请改用密码/私钥")?;
    let hash = session.best_supported_rsa_hash().await?.flatten();
    for identity in agent.request_identities().await? {
        if session
            .authenticate_publickey_with(user, identity.public_key().into_owned(), hash, &mut agent)
            .await?
            .success()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub struct Output {
    pub code: u32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn exec(
    session: &Session,
    command: &str,
    input: &str,
    log: Option<&Logger>,
) -> Result<Output> {
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, command).await?;
    if !input.is_empty() {
        channel.data(input.as_bytes()).await?;
    }
    channel.eof().await?;
    let mut output = Output {
        code: 255,
        stdout: String::new(),
        stderr: String::new(),
    };
    let mut pending = String::new();
    while let Some(message) = channel.wait().await {
        let text = match message {
            ChannelMsg::Data { data } => {
                let text = String::from_utf8_lossy(&data).into_owned();
                output.stdout.push_str(&text);
                text
            }
            ChannelMsg::ExtendedData { data, .. } => {
                let text = String::from_utf8_lossy(&data).into_owned();
                output.stderr.push_str(&text);
                text
            }
            ChannelMsg::ExitStatus { exit_status } => {
                output.code = exit_status;
                continue;
            }
            _ => continue,
        };
        if let Some(log) = log {
            pending.push_str(&text);
            while let Some(index) = pending.find('\n') {
                log(pending[..index].trim_end());
                pending.drain(..=index);
            }
        }
    }
    if let Some(log) = log {
        if !pending.trim().is_empty() {
            log(pending.trim());
        }
    }
    Ok(output)
}

fn last_json(output: Output) -> Result<Value> {
    if output.code != 0 {
        bail!("远端探测失败：{}", output.stderr.trim());
    }
    serde_json::from_str(output.stdout.trim().lines().last().unwrap_or(""))
        .context("远端探测未返回有效 JSON")
}

pub async fn remote_dir(session: &Session, dir: &str) -> Result<String> {
    if dir == "~" || dir.starts_with("~/") {
        let home = exec(session, "printf %s \"$HOME\"", "", None).await?;
        if home.code != 0 || home.stdout.is_empty() {
            bail!("无法获取远端 home 目录");
        }
        Ok(format!("{}{}", home.stdout, &dir[1..]))
    } else {
        Ok(dir.to_string())
    }
}

#[derive(Debug, PartialEq)]
pub enum PortKind {
    Idle,
    Ours,
}

pub async fn probe(session: &Session, dir: &str, port: u16, log: &Logger) -> Result<PortKind> {
    log(&format!("探测远端 127.0.0.1:{port}（health + 监听用户）"));
    let command = format!("{} python3 -", prefix(dir, port));
    let ownership = last_json(exec(session, &command, OWNERSHIP, None).await?)?;
    let health = last_json(exec(session, &command, HEALTH, None).await?)?;
    classify_probe(&ownership, &health)
}

pub fn classify_probe(ownership: &Value, health: &Value) -> Result<PortKind> {
    let uids = ownership["uids"]
        .as_array()
        .context("无法确认远端端口占用")?;
    let me = ownership["me"].as_u64().context("无法确认远端用户")?;
    let healthy = health["kind"] == "http"
        && health["status"] == 200
        && health["body"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["ok"] == true && v["version"].is_string());
    if !uids.is_empty() {
        if uids.iter().any(|uid| uid.as_u64() != Some(me)) {
            bail!("远端端口被其他用户占用，请更换后端端口");
        }
        if healthy {
            return Ok(PortKind::Ours);
        }
        bail!("远端端口被其他程序占用或后端不健康，请检查后更换端口");
    }
    if health["kind"] == "http" {
        bail!("远端 localhost 已有服务响应，请更换后端端口");
    }
    if health["kind"] != "refused" {
        bail!("无法确认远端端口空闲，请检查远端网络后重试");
    }
    Ok(PortKind::Idle)
}

pub async fn start(session: &Session, dir: &str, port: u16, log: &Logger) -> Result<()> {
    let output = exec(
        session,
        &format!("{} bash -s", prefix(dir, port)),
        BOOTSTRAP,
        Some(log),
    )
    .await?;
    match output.code {
        0 => Ok(()),
        4 => bail!("远端缺少可用 venv，请按连接日志在远端创建 {dir}/.venv 后重试"),
        5 => bail!("远端安装依赖失败，请检查 PyPI 网络；已有依赖可导入时会跳过 pip"),
        _ => bail!("远端启动失败：{}", output.stderr.trim()),
    }
}

pub async fn stop(session: &Session, dir: &str, port: u16) -> Result<()> {
    // Keep ownership checks before stopping anything at the configured port.
    let ownership = last_json(
        exec(
            session,
            &format!("{} python3 -", prefix(dir, port)),
            OWNERSHIP,
            None,
        )
        .await?,
    )?;
    if ownership["uids"]
        .as_array()
        .is_some_and(|uids| uids.iter().any(|uid| *uid != ownership["me"]))
    {
        bail!("远端端口已属于其他用户，拒绝停止");
    }
    exec(
        session,
        &format!("{} bash -s", prefix(dir, port)),
        STOP,
        None,
    )
    .await?;
    exec(
        session,
        &format!("{} python3 -", prefix(dir, port)),
        KILL,
        None,
    )
    .await?;
    Ok(())
}

pub async fn tunnel(session: Arc<Session>, port: u16, cancel: CancellationToken) -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                _ = cancel.cancelled() => break,
                incoming = listener.accept() => match incoming { Ok(value) => value, Err(_) => break },
            };
            let session = session.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let forward = async {
                    if let Ok(channel) = session
                        .channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0)
                        .await
                    {
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut socket, &mut stream).await;
                    }
                };
                tokio::select! { _ = cancel.cancelled() => {}, _ = forward => {} }
            });
        }
    });
    Ok(local_port)
}

fn deploy_files(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    fn walk(base: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "__pycache__" || name.ends_with(".pyc") {
                continue;
            }
            if entry.file_type()?.is_symlink() {
                continue;
            }
            if entry.file_type()?.is_dir() {
                walk(base, &entry.path(), files)?;
            } else {
                files.push((
                    entry
                        .path()
                        .strip_prefix(base)?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    entry.path(),
                ));
            }
        }
        Ok(())
    }
    let mut files = vec![("requirements.txt".into(), root.join("requirements.txt"))];
    walk(root, &root.join("backend/app"), &mut files)?;
    Ok(files)
}

async fn mkdirs(sftp: &SftpSession, dir: &str) -> Result<()> {
    let mut current = String::new();
    if dir.starts_with('/') {
        current.push('/');
    }
    for part in dir.split('/').filter(|part| !part.is_empty()) {
        if !current.ends_with('/') && !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        if sftp.metadata(&current).await.is_err() {
            if let Err(error) = sftp.create_dir(&current).await {
                if !sftp.metadata(&current).await?.is_dir() {
                    return Err(error.into());
                }
            }
        }
    }
    Ok(())
}

pub async fn sync(session: &Session, root: &Path, dir: &str, log: &Logger) -> Result<()> {
    log(&format!("SFTP 增量同步 → {dir}"));
    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    let mut uploaded = 0;
    let mut skipped = 0;
    for (relative, local) in deploy_files(root)? {
        let remote = format!("{dir}/{relative}");
        let metadata = std::fs::metadata(&local)?;
        let mtime = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_secs() as u32;
        if sftp
            .metadata(&remote)
            .await
            .is_ok_and(|attrs| attrs.size == Some(metadata.len()) && attrs.mtime == Some(mtime))
        {
            skipped += 1;
            continue;
        }
        mkdirs(&sftp, remote.rsplit_once('/').unwrap().0).await?;
        sftp.write(&remote, &tokio::fs::read(local).await?).await?;
        sftp.set_metadata(
            &remote,
            FileAttributes {
                atime: Some(mtime),
                mtime: Some(mtime),
                ..Default::default()
            },
        )
        .await?;
        uploaded += 1;
        log(&format!("上传 {relative}"));
    }
    sftp.close().await?;
    log(&format!("同步完成：上传 {uploaded}，跳过 {skipped}"));
    Ok(())
}

pub async fn close(session: &Session) {
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;
}
