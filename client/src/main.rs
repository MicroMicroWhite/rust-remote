#![cfg_attr(windows, windows_subsystem = "windows")]

mod desktop;
mod identity_info;
mod network;
mod operations;
mod output;
mod protection;
mod runtime;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod service_install;
mod update;
mod terminal;

use anyhow::{bail, Context, Result};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch, Semaphore},
    time,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tracing::{debug, error, info, warn};

#[derive(Parser, Debug)]
#[command(version, about = "Authenticated remote administration client")]
struct Args {
    /// Stay in the foreground (Linux defaults to background).
    #[cfg(target_os = "linux")]
    #[arg(long)]
    foreground: bool,
    /// Install and start rust-client using the native Windows service API (administrator required).
    #[cfg(windows)]
    #[arg(long, conflicts_with = "service", requires = "service_account")]
    install_service: bool,
    /// Account used when installing the service.
    #[cfg(windows)]
    #[arg(long, value_enum, requires = "install_service")]
    service_account: Option<service_install::Account>,
    /// Run under the Windows Service Control Manager as rust-client.
    #[cfg(windows)]
    #[arg(long)]
    service: bool,
    /// Controller WebSocket URL.
    #[arg(long, env = "REMOTE_SERVER", default_value = option_env!("REMOTE_DEFAULT_SERVER").filter(|value| !value.is_empty()))]
    server: String,
    /// Device secret; prefer REMOTE_TOKEN.
    #[arg(long, env = "REMOTE_TOKEN", hide_env_values = true, hide_default_value = true,
        default_value = option_env!("REMOTE_DEFAULT_TOKEN").filter(|value| !value.is_empty()))]
    token: String,
    /// Per-device identity file.
    #[arg(long, default_value = ".rust-remote-device-id")]
    identity: PathBuf,
    #[arg(long)]
    name: Option<String>,
    /// File boundary, not a Shell sandbox.
    #[arg(long)]
    root: Option<PathBuf>,
    /// Allow plaintext ws://.
    #[arg(long, env = "REMOTE_ALLOW_INSECURE", default_value = option_env!("REMOTE_DEFAULT_ALLOW_INSECURE").unwrap_or("false"))]
    allow_insecure: bool,
    /// Disable Shell.
    #[arg(long)]
    disable_shell: bool,
}

fn identity(path: &PathBuf) -> Result<String> {
    if path.exists() {
        let id = std::fs::read_to_string(path)?.trim().to_owned();
        uuid::Uuid::parse_str(&id).context("Invalid identity file")?;
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(path)?.write_all(id.as_bytes())?;
    Ok(id)
}

fn main() -> Result<()> {
    if let Some(result) = update::internal_helper() {
        return result;
    }
    runtime::init_logging();
    #[cfg(windows)]
    service_install::load_configuration()?;
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                #[cfg(windows)]
                info!("{error}");
                #[cfg(not(windows))]
                error.print()?;
                return Ok(());
            }
            #[cfg(windows)]
            if std::env::args_os().any(|arg| arg == "--install-service") {
                service_install::show_message(&error.to_string(), true);
            }
            return Err(error.into());
        }
    };
    #[cfg(target_os = "linux")]
    if !args.foreground {
        validate_connection(&args)?;
        return runtime::spawn_background();
    }
    #[cfg(windows)]
    if args.install_service {
        let result = service_install::install(&args);
        match &result {
            Ok(()) => {
                service_install::show_message("rust-client has been installed and started.", false)
            }
            Err(error) => service_install::show_message(&format!("{error:#}"), true),
        }
        return result;
    }
    #[cfg(windows)]
    if args.service {
        return service::dispatch(args);
    }
    run_client(args, None)
}

fn validate_connection(args: &Args) -> Result<()> {
    if !args.server.starts_with("wss://")
        && !(args.allow_insecure && args.server.starts_with("ws://"))
    {
        bail!("Use wss://, or explicitly pass --allow-insecure for a trusted network");
    }
    if args.token.len() < 32 {
        bail!("Device token must contain at least 32 characters");
    }
    Ok(())
}

fn run_client(args: Args, shutdown: Option<watch::Receiver<bool>>) -> Result<()> {
    // Socket/timer work stays on this thread; filesystem, system queries and
    // image encoding already run via spawn_blocking. Do not reserve one async
    // worker per logical CPU on large servers.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(8)
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        tokio::select! {
            result = run(args) => result,
            _ = wait_for_shutdown(shutdown) => Ok(()),
            _ = wait_for_termination() => Ok(()),
        }
    });
    // Screen and system queries may use blocking workers; do not hold SCM shutdown indefinitely.
    runtime.shutdown_timeout(Duration::from_secs(5));
    if let Err(ref error) = result {
        error!(%error, "Client stopped with an error");
    }
    result
}

async fn wait_for_termination() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => { signal.recv().await; return; }
            Err(error) => warn!(%error, "Cannot register termination signal handler"),
        }
    }
    std::future::pending::<()>().await;
}

async fn wait_for_shutdown(shutdown: Option<watch::Receiver<bool>>) {
    let Some(mut receiver) = shutdown else {
        return std::future::pending().await;
    };
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

async fn run(mut args: Args) -> Result<()> {
    let _instance = match runtime::acquire_instance()? {
        Some(lock) => lock,
        None => {
            info!("Client is already running; exiting");
            if runtime::is_service() {
                bail!("Another rust-client service instance is already running");
            }
            return Ok(());
        }
    };
    let _executable_protection = match protection::protect_running_executable() {
        Ok(protection) => Some(protection),
        Err(err) => {
            warn!(error = %err, "Executable protection is unavailable");
            None
        }
    };
    if runtime::is_service() {
        if args.identity == std::path::Path::new(".rust-remote-device-id") {
            args.identity = runtime::state_dir()?.join("device-id");
        }
        if !args.identity.is_absolute()
            || args.root.as_ref().is_some_and(|root| !root.is_absolute())
        {
            bail!("Service identity and root paths must be absolute");
        }
    }
    validate_connection(&args)?;
    let id = identity(&args.identity)?;
    if !runtime::is_service() {
        update::init(&args)?;
    }
    let root = args.root.as_ref().map(std::fs::canonicalize).transpose()?;
    let context = Arc::new(operations::Context {
        root,
        disable_shell: args.disable_shell,
    });
    let mut capabilities = vec!["process-kill-v1"];
    #[cfg(not(windows))]
    capabilities.push("terminal-v1");
    let screen_available = desktop::available();
    if screen_available {
        capabilities.push("screen-v1");
    }
    if !runtime::is_service() {
        if screen_available {
            capabilities.push("screen-input-v1");
        }
        capabilities.extend(["self-update-v1", "self-reinstall-v1"]);
    }
    let hello = json!({"type":"hello", "id": id,
        "name": args.name.clone().unwrap_or_else(|| hostname::get().unwrap_or_default().to_string_lossy().into_owned()),
        "platform": std::env::consts::OS, "arch": std::env::consts::ARCH, "version": env!("CARGO_PKG_VERSION"),
        "os": sysinfo::System::long_os_version(), "distribution_id": sysinfo::System::distribution_id(),
        "kernel_version": sysinfo::System::kernel_version(),
        "capabilities": capabilities, "binary_sha256": update::executable_sha256()?});
    #[cfg(windows)]
    if args.service {
        service::running()?;
    }
    info!(device_id = %id, shell_enabled = !args.disable_shell, "Remote administration client started");
    let mut delay = Duration::from_secs(1);
    loop {
        let start = time::Instant::now();
        let authenticated = Arc::new(AtomicBool::new(false));
        tokio::select! {
            result = run_connection(&args, &hello, context.clone(), authenticated.clone()) => {
                if let Err(err) = result { warn!(error = %err, "Connection ended"); }
            }
            _ = tokio::signal::ctrl_c(), if !runtime::is_service() => { info!("Client stopped"); break; }
        }
        if authenticated.load(Ordering::Relaxed) || start.elapsed() > Duration::from_secs(60) {
            delay = Duration::from_secs(1);
        }
        let retry_in = jittered_delay(delay, uuid::Uuid::new_v4().as_u128());
        info!(
            delay_ms = retry_in.as_millis(),
            "Controller unavailable; scheduling reconnect"
        );
        tokio::select! {
            _ = time::sleep(retry_in) => {},
            _ = tokio::signal::ctrl_c(), if !runtime::is_service() => break,
        }
        delay = (delay * 2).min(Duration::from_secs(60));
    }
    Ok(())
}

fn jittered_delay(delay: Duration, entropy: u128) -> Duration {
    let minimum = delay / 2;
    let spread_ms = (delay - minimum).as_millis() as u64;
    minimum + Duration::from_millis((entropy % u128::from(spread_ms + 1)) as u64)
}

async fn run_connection(
    args: &Args,
    hello: &Value,
    context: Arc<operations::Context>,
    authenticated: Arc<AtomicBool>,
) -> Result<()> {
    let mut request = args.server.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {}", args.token).parse()?);
    let (socket, _) = time::timeout(Duration::from_secs(15), connect_async(request)).await??;
    let (mut sink, mut stream) = socket.split();
    sink.send(Message::Text(hello.to_string().into())).await?;
    info!("Connected to controller");
    // Keep the operation permit until its response has actually been sent.
    // A slow connection must not accumulate another batch of large responses.
    let (tx, mut rx) = mpsc::channel::<(Value, bool, tokio::sync::OwnedSemaphorePermit)>(1);
    let permits = Arc::new(Semaphore::new(4));
    let mut heartbeat = time::interval(Duration::from_secs(20));
    let mut last_seen = time::Instant::now();
    let mut jobs = tokio::task::JoinSet::new();
    let (terminal_tx, mut terminal_rx) = mpsc::channel(16);
    let mut terminals = terminal::Terminals::new(terminal_tx, context.clone());
    loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_seen = time::Instant::now();
                    let mut value: Value = serde_json::from_str(&text)?;
                    drop(text);
                    if value["type"] == "welcome" {
                        authenticated.store(true, Ordering::Relaxed);
                        update::authenticated();
                    }
                    if value["type"] == "terminal" {
                        if let Err(error) = terminals.handle(&value) {
                            if let Some(id) = value["session"].as_str().filter(|id| id.len() <= 64) {
                                terminals.finished(id);
                                sink.send(Message::Text(json!({"type":"terminal", "session":id, "event":"error", "detail":error.to_string()}).to_string().into())).await?;
                            }
                        }
                        continue;
                    }
                    if value["type"] != "request" { continue; }
                    let id = value["id"].as_str().context("Missing request ID")?.to_owned();
                    let trace_id = value["trace_id"].as_str().unwrap_or("").to_owned();
                    let action = value["action"].as_str().context("Missing action")?.to_owned();
                    let params = value["params"].take();
                    let permit = match permits.clone().try_acquire_owned() {
                        Ok(permit) => permit,
                        Err(_) => {
                            sink.send(Message::Text(json!({"type":"response","id":id,"ok":false,"error":"Device is busy"}).to_string().into())).await?;
                            continue;
                        }
                    };
                    let tx = tx.clone();
                    let context = context.clone();
                    jobs.spawn(async move {
                        if action == "screen.capture" { debug!(%trace_id, %action, request_id = %id, "Operation started"); }
                        else { info!(%trace_id, %action, request_id = %id, "Operation started"); }
                        let result = if action.starts_with("agent.update.") {
                            let action = action.clone();
                            tokio::task::spawn_blocking(move || update::execute(&action, params)).await
                                .map_err(anyhow::Error::from).and_then(|result| result)
                        } else { operations::execute(&action, params, context).await };
                        let restart = action == "agent.update.commit" && result.is_ok();
                        let response = match result {
                            Ok(result) => {
                                if action == "screen.capture" { debug!(%trace_id, %action, "Operation completed"); }
                                else { info!(%trace_id, %action, "Operation completed"); }
                                let mut response = json!({"type":"response","id":id,"trace_id":trace_id,"ok":true});
                                response["result"] = result;
                                response
                            },
                            Err(err) => { error!(%trace_id, %action, error = %err, "Operation failed"); json!({"type":"response","id":id,"trace_id":trace_id,"ok":false,"error":err.to_string()}) },
                        };
                        let _ = tx.send((response, restart, permit)).await;
                    });
                }
                Some(Ok(Message::Ping(data))) => { last_seen = time::Instant::now(); sink.send(Message::Pong(data)).await?; },
                Some(Ok(Message::Pong(_))) => { last_seen = time::Instant::now(); },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(err)) => return Err(err.into()),
                _ => {}
            },
            Some((response, restart, _permit)) = rx.recv() => {
                sink.send(Message::Text(response.to_string().into())).await?;
                if restart { terminals.clear(); std::process::exit(0); }
            },
            Some(event) = terminal_rx.recv() => {
                if matches!(event["event"].as_str(), Some("exit" | "error")) {
                    if let Some(id) = event["session"].as_str() { terminals.finished(id); }
                }
                time::timeout(Duration::from_secs(10), sink.send(Message::Text(event.to_string().into()))).await??;
            },
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(65) { bail!("Controller heartbeat expired"); }
                sink.send(Message::Text(json!({"type":"heartbeat"}).to_string().into())).await?;
            },
            Some(_) = jobs.join_next(), if !jobs.is_empty() => {},
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_handles_a_stop_received_before_the_waiter_starts() {
        let (sender, receiver) = watch::channel(false);
        sender.send_replace(true);
        time::timeout(Duration::from_secs(1), wait_for_shutdown(Some(receiver)))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_handles_a_stop_after_waiting_and_a_closed_sender() {
        let (sender, receiver) = watch::channel(false);
        let waiter = wait_for_shutdown(Some(receiver));
        tokio::pin!(waiter);
        tokio::select! {
            biased;
            _ = &mut waiter => panic!("Shutdown completed without a stop request"),
            _ = std::future::ready(()) => {},
        }
        sender.send_replace(true);
        time::timeout(Duration::from_secs(1), &mut waiter)
            .await
            .unwrap();

        let (sender, receiver) = watch::channel(false);
        drop(sender);
        time::timeout(Duration::from_secs(1), wait_for_shutdown(Some(receiver)))
            .await
            .unwrap();
    }

    #[test]
    fn reconnect_jitter_stays_within_each_exponential_window() {
        for delay in [
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
        ] {
            for entropy in [0, u128::MAX] {
                let retry = jittered_delay(delay, entropy);
                assert!(retry >= delay / 2);
                assert!(retry <= delay);
            }
        }
    }

    #[test]
    fn reconnect_ceiling_doubles_and_caps_at_one_minute() {
        let mut delay = Duration::from_secs(1);
        let mut delays = Vec::new();
        for _ in 0..8 {
            delays.push(delay.as_secs());
            delay = (delay * 2).min(Duration::from_secs(60));
        }
        assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60]);
    }
}
