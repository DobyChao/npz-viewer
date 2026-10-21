//! Opt-in validation harness: run the native control/data plane without a window.
//! Not included in portable packages.
mod hub;
mod profiles;
mod ssh;

fn main() -> anyhow::Result<()> {
    tauri::async_runtime::block_on(async {
        let root = std::env::args_os()
            .nth(1)
            .map(std::path::PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let hub = hub::Hub::start(root)?;
        println!(
            "{}",
            serde_json::json!({ "origin": format!("http://127.0.0.1:{}", hub.port), "token": hub.token })
        );
        tokio::signal::ctrl_c().await?;
        hub.shutdown();
        Ok(())
    })
}
