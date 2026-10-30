//! Chunked, verified self-update. A separate copy waits for the instance lock,
//! replaces the executable and rolls back if the new client cannot authenticate.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "linux"))]
use std::process::Stdio;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_SIZE: u64 = 128 * 1024 * 1024;
static TRANSFER: Mutex<Option<Transfer>> = Mutex::new(None);
static RESTART: OnceLock<Restart> = OnceLock::new();

struct Restart {
    server: String,
    token: String,
    args: Vec<std::ffi::OsString>,
}
struct Transfer {
    id: String,
    directory: PathBuf,
    file: Option<File>,
    cleanup: bool,
    size: u64,
    received: u64,
    sha256: String,
    version: String,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        drop(self.file.take());
        if self.cleanup {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

pub fn init(args: &crate::Args) -> Result<()> {
    let mut restart_args = vec![
        "--identity".into(),
        args.identity.canonicalize()?.into_os_string(),
    ];
    // The update helper must track the actual client process for authentication
    // timeout/rollback, rather than a launcher that exits after spawning it.
    #[cfg(target_os = "linux")]
    restart_args.push("--foreground".into());
    if let Some(name) = &args.name {
        restart_args.extend(["--name".into(), name.into()]);
    }
    if let Some(root) = &args.root {
        restart_args.extend(["--root".into(), root.canonicalize()?.into_os_string()]);
    }
    if args.allow_insecure {
        restart_args.push("--allow-insecure".into());
    }
    if args.disable_shell {
        restart_args.push("--disable-shell".into());
    }
    RESTART
        .set(Restart {
            server: args.server.clone(),
            token: args.token.clone(),
            args: restart_args,
        })
        .map_err(|_| anyhow::anyhow!("Update restart configuration already initialized"))?;
    Ok(())
}

pub fn executable_sha256() -> Result<String> {
    let mut executable = File::open(std::env::current_exe()?)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = executable.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn version(value: &str) -> Result<[u64; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|p| {
            p.is_empty()
                || (p.len() > 1 && p.starts_with('0'))
                || !p.bytes().all(|b| b.is_ascii_digit())
        })
    {
        bail!("Version must be major.minor.patch");
    }
    Ok([parts[0].parse()?, parts[1].parse()?, parts[2].parse()?])
}

fn validate_target_version(target: &str, reinstall: bool) -> Result<()> {
    let current = version(env!("CARGO_PKG_VERSION"))?;
    let requested = version(target)?;
    if requested < current || (requested == current && !reinstall) {
        bail!("Refusing downgrade or same version without explicit reinstall");
    }
    Ok(())
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params[key]
        .as_str()
        .with_context(|| format!("Missing {key}"))
}

fn executable_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn execute(action: &str, params: Value) -> Result<Value> {
    if crate::runtime::is_service() {
        bail!("Online updates are unavailable in Windows service mode; stop the service and replace the executable manually");
    }
    let mut state = TRANSFER
        .lock()
        .map_err(|_| anyhow::anyhow!("Update state poisoned"))?;
    let id = text(&params, "id")?;
    uuid::Uuid::parse_str(id)?;
    if action == "agent.update.begin" {
        let target = text(&params, "version")?;
        validate_target_version(target, params["reinstall"].as_bool().unwrap_or(false))?;
        if params["platform"] != std::env::consts::OS
            || params["arch"] != std::env::consts::ARCH
            || params["update_protocol"] != 1
        {
            bail!("Release platform, architecture or protocol mismatch");
        }
        let size = params["size"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= MAX_SIZE)
            .context("Invalid release size")?;
        let hash = text(&params, "sha256")?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Invalid SHA-256");
        }
        // Drop abandoned transfers before creating a new private staging directory.
        *state = None;
        let exe = std::env::current_exe()?.canonicalize()?;
        let directory = exe
            .parent()
            .context("Executable has no parent")?
            .join(format!(".remote-update-{}", uuid::Uuid::new_v4()));
        let builder = {
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            }
            #[cfg(not(unix))]
            {
                builder
            }
        };
        builder.create(&directory).context(
            "Cannot create update staging directory; executable directory must be writable",
        )?;
        let file = match OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(directory.join("payload"))
        {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                return Err(error.into());
            }
        };
        *state = Some(Transfer {
            id: id.into(),
            directory,
            file: Some(file),
            cleanup: true,
            size,
            received: 0,
            sha256: hash.to_lowercase(),
            version: target.into(),
        });
        return Ok(json!({"ready": true}));
    }
    let transfer = state.as_mut().context("No update transfer")?;
    if transfer.id != id {
        bail!("Update transfer ID mismatch");
    }
    match action {
        "agent.update.chunk" => {
            if params["offset"].as_u64() != Some(transfer.received) {
                bail!("Unexpected update offset");
            }
            let encoded = text(&params, "data")?;
            if encoded.len() > 350_000 {
                bail!("Update chunk too large");
            }
            let data = STANDARD.decode(encoded)?;
            if data.is_empty() || transfer.received + data.len() as u64 > transfer.size {
                bail!("Invalid chunk length");
            }
            transfer
                .file
                .as_mut()
                .context("Transfer closed")?
                .write_all(&data)?;
            transfer.received += data.len() as u64;
            Ok(json!({"received": transfer.received}))
        }
        "agent.update.abort" => {
            *state = None;
            Ok(json!({"aborted":true}))
        }
        "agent.update.commit" => {
            if transfer.received != transfer.size {
                bail!("Incomplete update transfer");
            }
            transfer
                .file
                .as_mut()
                .context("Transfer closed")?
                .sync_all()?;
            let payload = transfer.directory.join("payload");
            let mut reader = File::open(&payload)?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            if format!("{:x}", hasher.finalize()) != transfer.sha256 {
                bail!("Update SHA-256 mismatch");
            }
            let helper = transfer.directory.join(if cfg!(windows) {
                "helper.exe"
            } else {
                "helper"
            });
            fs::copy(&payload, &helper)?;
            executable_permissions(&helper)?;
            executable_permissions(&payload)?;
            let restart = RESTART.get().context("Missing restart configuration")?;
            let original = std::env::current_exe()?.canonicalize()?;
            let mut probe = Command::new(&helper);
            probe
                .arg("--internal-verify-release")
                .arg(&transfer.version);
            quiet(&mut probe)?;
            let mut child = probe
                .spawn()
                .context("New executable cannot run on this device")?;
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(status) = child.try_wait()? {
                    if !status.success() {
                        bail!("New executable version does not match the release manifest");
                    }
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!("New executable verification timed out");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let mut command = Command::new(helper);
            command
                .arg("--internal-apply-update")
                .arg(&original)
                .arg(&transfer.directory)
                .args(&restart.args)
                .env("REMOTE_SERVER", &restart.server)
                .env("REMOTE_TOKEN", &restart.token)
                .env("REMOTE_ALLOW_INSECURE", "false");
            quiet(&mut command)?;
            command.spawn().context("Cannot start update helper")?;
            // The helper now owns the staging files. The old process exits only after sending its response.
            let result = json!({"restarting":true, "version":transfer.version});
            transfer.cleanup = false;
            drop(state.take());
            Ok(result)
        }
        _ => bail!("Unsupported update operation"),
    }
}

fn quiet(command: &mut Command) -> Result<()> {
    #[cfg(target_os = "linux")]
    crate::runtime::configure_background(command)?;
    #[cfg(not(target_os = "linux"))]
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000200); // No console, independent process group.
    }
    Ok(())
}

pub fn internal_helper() -> Option<Result<()>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|v| v == "--internal-verify-release")
    {
        return Some(
            if args.get(2).is_some_and(|v| v == env!("CARGO_PKG_VERSION")) {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Release version mismatch"))
            },
        );
    }
    if args.get(1).is_none_or(|v| v != "--internal-apply-update") {
        return None;
    }
    Some((|| {
        let original = PathBuf::from(args.get(2).context("Missing original executable")?);
        let directory = PathBuf::from(args.get(3).context("Missing update directory")?);
        apply(&original, &directory, &args[4..])
    })())
}

fn apply(original: &Path, directory: &Path, args: &[std::ffi::OsString]) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let lock = loop {
        if let Some(lock) = crate::runtime::acquire_instance()? {
            break lock;
        }
        if Instant::now() >= deadline {
            bail!("Old client did not exit");
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let backup = directory.join("previous");
    // Windows may release the instance lock slightly before releasing its image handle.
    loop {
        match fs::rename(original, &backup) {
            Ok(()) => break,
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(error.into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    if let Err(error) = fs::rename(directory.join("payload"), original) {
        fs::rename(&backup, original).context("Cannot restore previous executable")?;
        drop(lock);
        let mut command = Command::new(original);
        command.args(args);
        quiet(&mut command)?;
        command.spawn()?;
        return Err(error.into());
    }
    drop(lock);
    let ready = directory.join("ready");
    let mut command = Command::new(original);
    command.args(args).env("REMOTE_UPDATE_READY", &ready);
    // Older clients did not include --foreground in their restart arguments.
    // This helper comes from the new release, so the candidate supports it;
    // leave the original arguments intact for a possible rollback to an old release.
    #[cfg(target_os = "linux")]
    if !args.iter().any(|arg| arg == "--foreground") {
        command.arg("--foreground");
    }
    quiet(&mut command)?;
    let child = command.spawn();
    if let Ok(mut child) = child {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if ready.exists() {
                let _ = fs::remove_file(&backup);
                // Windows retains the running helper image until this process exits.
                let _ = fs::remove_dir_all(directory);
                return Ok(());
            }
            if child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    // Failed to start or authenticate: restore and restart the previous client.
    fs::remove_file(original)?;
    fs::rename(&backup, original)?;
    let mut command = Command::new(original);
    command.args(args).env_remove("REMOTE_UPDATE_READY");
    quiet(&mut command)?;
    command.spawn()?;
    let _ = fs::remove_dir_all(directory);
    Ok(())
}

pub fn authenticated() {
    if let Some(path) = std::env::var_os("REMOTE_UPDATE_READY") {
        let _ = fs::write(path, b"ready");
        std::env::remove_var("REMOTE_UPDATE_READY");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_compare_numerically_and_reject_ambiguous_values() {
        assert!(version("0.10.0").unwrap() > version("0.2.9").unwrap());
        for value in ["1.0", "01.2.3", "1.2.3-beta", "1.2.-1"] {
            assert!(version(value).is_err());
        }
    }
    #[test]
    fn same_version_requires_reinstall_and_downgrades_remain_rejected() {
        let current = env!("CARGO_PKG_VERSION");
        assert!(validate_target_version(current, false).is_err());
        assert!(validate_target_version(current, true).is_ok());
        assert!(validate_target_version("0.0.1", true).is_err());
        assert!(validate_target_version("99.0.0", false).is_ok());
    }
    #[test]
    fn transfer_rejects_wrong_platform_and_downgrades() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(execute("agent.update.begin", json!({"id":id,"version":"0.1.0"})).is_err());
        assert!(execute(
            "agent.update.begin",
            json!({"id":id,"version":"99.0.0","platform":"invalid"})
        )
        .is_err());
    }
    #[test]
    fn transfer_checks_offsets_size_hash_and_abort_cleanup() {
        let id = uuid::Uuid::new_v4().to_string();
        let manifest = json!({"id": id, "version": "99.0.0", "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "update_protocol": 1, "size": 3, "sha256": "0".repeat(64)});
        execute("agent.update.begin", manifest).unwrap();
        let directory = TRANSFER.lock().unwrap().as_ref().unwrap().directory.clone();
        assert!(execute("agent.update.commit", json!({"id":id})).is_err());
        assert!(execute(
            "agent.update.chunk",
            json!({"id":id,"offset":1,"data":"YWJj"})
        )
        .is_err());
        assert!(execute(
            "agent.update.chunk",
            json!({"id":id,"offset":0,"data":"YWJjZA=="})
        )
        .is_err());
        execute(
            "agent.update.chunk",
            json!({"id":id,"offset":0,"data":"YWJj"}),
        )
        .unwrap();
        assert!(execute(
            "agent.update.chunk",
            json!({"id":id,"offset":0,"data":"YWJj"})
        )
        .is_err());
        assert!(execute("agent.update.commit", json!({"id":id}))
            .unwrap_err()
            .to_string()
            .contains("SHA-256"));
        assert!(execute(
            "agent.update.abort",
            json!({"id": uuid::Uuid::new_v4().to_string()})
        )
        .is_err());
        execute("agent.update.abort", json!({"id":id})).unwrap();
        assert!(!directory.exists());
    }
}
