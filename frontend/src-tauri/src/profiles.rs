use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub remote_dir: String,
    pub remote_port: u16,
    pub auth_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

impl Profile {
    pub fn from_value(mut value: Value, id: String) -> Result<Self> {
        value["id"] = json!(id);
        for (key, default) in [
            ("port", json!(22)),
            ("remotePort", json!(8756)),
            ("remoteDir", json!("~/.npz-viewer-backend")),
            ("authMethod", json!("agent")),
            ("user", json!("")),
            ("name", value["host"].clone()),
        ] {
            if value
                .get(key)
                .is_none_or(|v| v.is_null() || v.as_str() == Some(""))
            {
                value[key] = default;
            }
        }
        let mut profile: Self = serde_json::from_value(value).context("服务器配置无效")?;
        profile.host = profile.host.trim().to_string();
        profile.user = profile.user.trim().to_string();
        profile.name = profile.name.trim().to_string();
        profile.remote_dir = profile.remote_dir.trim().to_string();
        if profile.host.is_empty() || profile.port == 0 || profile.remote_port == 0 {
            bail!("主机和端口不能为空");
        }
        if !["agent", "password", "key"].contains(&profile.auth_method.as_str()) {
            profile.auth_method = "agent".into();
        }
        Ok(profile)
    }
}

pub fn path(root: &Path) -> PathBuf {
    std::env::var_os("NPZVIEW_SERVERS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("servers.json"))
}

pub fn read(path: &Path) -> Result<Vec<Profile>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path)?)
        .context("servers.json 无法解析，请检查文件")?;
    let mut profiles = Vec::new();
    for value in value["servers"].as_array().into_iter().flatten() {
        let id = value["id"].as_str().context("服务器缺少 id")?.to_string();
        profiles.push(Profile::from_value(value.clone(), id)?);
    }
    Ok(profiles)
}

pub fn write(path: &Path, profiles: &[Profile]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Serialize only the profile schema; authentication secrets never enter this file.
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&json!({ "servers": profiles }))?,
    )?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}
