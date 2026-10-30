use anyhow::{bail, Context as _, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    System, MINIMUM_CPU_UPDATE_INTERVAL,
};
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_ENVIRONMENT_VARIABLES: usize = 2000;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct Context {
    pub root: Option<PathBuf>,
    pub disable_shell: bool,
}

impl Context {
    fn path(&self, value: &str, create: bool) -> Result<PathBuf> {
        if value.is_empty() || value.contains('\0') {
            bail!("Invalid path");
        }
        let candidate = match &self.root {
            Some(root) if !Path::new(value).is_absolute() => root.join(value),
            _ => PathBuf::from(value),
        };
        let resolved = if create && !candidate.exists() {
            let parent = candidate
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let name = candidate.file_name().context("Path has no file name")?;
            if name == ".." || name == "." {
                bail!("Invalid file name");
            }
            parent.canonicalize()?.join(name)
        } else {
            candidate.canonicalize()?
        };
        if let Some(root) = &self.root {
            if !resolved.starts_with(root) {
                bail!("Path is outside the configured filesystem root");
            }
        }
        Ok(resolved)
    }
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params[key]
        .as_str()
        .with_context(|| format!("Missing string parameter: {key}"))
}

pub async fn execute(action: &str, params: Value, context: Arc<Context>) -> Result<Value> {
    if action == "shell.exec" {
        if context.disable_shell {
            bail!("Shell execution is disabled on this device");
        }
        let command = string(&params, "command")?;
        let seconds = params["timeout"].as_u64().unwrap_or(30).clamp(1, 30);
        #[cfg(windows)]
        let mut process = {
            let mut p = tokio::process::Command::new("cmd.exe");
            p.args(["/D", "/A", "/S", "/C", command]);
            p
        };
        #[cfg(not(windows))]
        let mut process = {
            let mut p = tokio::process::Command::new("/bin/sh");
            p.args(["-c", command]);
            p
        };
        if let Some(root) = &context.root {
            process.current_dir(root);
        }
        return run_process(process, seconds).await;
    }
    if action == "ports.list" {
        #[cfg(windows)]
        let mut process = {
            let mut p = tokio::process::Command::new("netstat.exe");
            p.args(["-ano"]);
            p
        };
        #[cfg(not(windows))]
        let mut process = {
            let mut p = tokio::process::Command::new("ss");
            p.args(["-tunap"]);
            p
        };
        process.stdin(Stdio::null());
        return run_process(process, 10)
            .await
            .context("Cannot inspect ports (Linux requires iproute2/ss)");
    }
    let action = action.to_owned();
    tokio::task::spawn_blocking(move || execute_blocking(&action, params, &context)).await?
}

fn execute_blocking(action: &str, params: Value, context: &Context) -> Result<Value> {
    if matches!(action, "fs.delete" | "fs.rename" | "fs.edit") {
        let value = string(&params, "path")?;
        let candidate = match &context.root {
            Some(root) if !Path::new(value).is_absolute() => root.join(value),
            _ => PathBuf::from(value),
        };
        if candidate.symlink_metadata()?.file_type().is_symlink() {
            bail!("Mutating symbolic links is not supported");
        }
    }
    match action {
        "system.info" => {
            let mut system = System::new();
            system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
            // Keep the CPU list between samples so sysinfo can calculate a delta.
            system.refresh_cpu_list(CpuRefreshKind::nothing().with_cpu_usage());
            std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
            system.refresh_cpu_usage();
            let cpu_usage = if system.cpus().is_empty() {
                0.0
            } else {
                system.cpus().iter().map(|cpu| cpu.cpu_usage()).sum::<f32>()
                    / system.cpus().len() as f32
            };
            let networks = Networks::new_with_refreshed_list();
            let (network_received, network_transmitted) = networks.iter().fold(
                (0_u64, 0_u64),
                |(received, transmitted), (_, data)| {
                    (received + data.total_received(), transmitted + data.total_transmitted())
                },
            );
            let disks = Disks::new_with_refreshed_list();
            let (disk_read, disk_written) = disks.iter().fold(
                (0_u64, 0_u64),
                |(read, written), disk| {
                    let usage = disk.usage();
                    (read + usage.total_read_bytes, written + usage.total_written_bytes)
                },
            );
            Ok(
                json!({"hostname": System::host_name(), "os": System::long_os_version(),
                "distribution_id": System::distribution_id(), "kernel_version": System::kernel_version(),
                "arch": std::env::consts::ARCH, "cpu_count": system.cpus().len(), "cpu_usage": cpu_usage,
                "memory_total": system.total_memory(), "memory_used": system.used_memory(),
                "network_received": network_received, "network_transmitted": network_transmitted,
                "disk_read": disk_read, "disk_written": disk_written,
                "uptime": System::uptime(), "default_path": context.root.clone().unwrap_or(std::env::current_dir()?).to_string_lossy(),
                "shell_enabled": !context.disable_shell,
                "runtime_identity": crate::identity_info::current(),
                // Public IP lookup uses an external service and must not block the
                // interactive system.info request. The controller keeps the last
                // reported value and falls back to the connection source address.
                "local_addresses": crate::network::local_addresses()}),
            )
        }
        "system.environment" => {
            let mut variables: Vec<_> = std::env::vars_os()
                .map(|(name, value)| {
                    json!({
                        "name": name.to_string_lossy(),
                        "value": value.to_string_lossy(),
                    })
                })
                .collect();
            variables.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            let truncated = variables.len() > MAX_ENVIRONMENT_VARIABLES;
            variables.truncate(MAX_ENVIRONMENT_VARIABLES);
            Ok(json!({"variables": variables, "truncated": truncated}))
        }
        "screen.capture" => {
            crate::desktop::capture(&params)
        }
        "screen.input" => crate::desktop::input(&params),
        "fs.list" => {
            let path = context.path(string(&params, "path")?, false)?;
            let mut entries = Vec::new();
            let mut truncated = false;
            for entry in std::fs::read_dir(&path)? {
                if entries.len() >= 5000 {
                    truncated = true;
                    break;
                }
                let entry = entry?;
                let metadata = entry.path().symlink_metadata()?;
                entries.push(json!({"name": entry.file_name().to_string_lossy(), "path": entry.path().to_string_lossy(),
                    "is_dir": metadata.is_dir(), "is_symlink": metadata.file_type().is_symlink(), "size": metadata.len(),
                    "modified": metadata.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs())}));
            }
            entries.sort_by(|a, b| {
                b["is_dir"]
                    .as_bool()
                    .cmp(&a["is_dir"].as_bool())
                    .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
            });
            let parent = path
                .parent()
                .filter(|p| context.root.as_ref().is_none_or(|root| p.starts_with(root)));
            Ok(
                json!({"path": path.to_string_lossy(), "parent": parent.map(|p|p.to_string_lossy()), "entries": entries, "truncated": truncated}),
            )
        }
        "fs.mkdir" => {
            let path = context.path(string(&params, "path")?, true)?;
            std::fs::create_dir(&path)?;
            Ok(json!({"path":path.to_string_lossy()}))
        }
        "fs.delete" => {
            let path = context.path(string(&params, "path")?, false)?;
            if path.parent().is_none() || context.root.as_ref() == Some(&path) {
                bail!("Cannot delete a filesystem root");
            }
            if crate::protection::is_runtime_path(&path) {
                bail!("Cannot delete the running client or its protected state");
            }
            if path.is_dir() {
                std::fs::remove_dir(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
            Ok(json!({"deleted": true}))
        }
        "fs.rename" => {
            let from = context.path(string(&params, "path")?, false)?;
            let to = context.path(string(&params, "destination")?, true)?;
            if from.parent().is_none() || context.root.as_ref() == Some(&from) {
                bail!("Cannot rename a filesystem root");
            }
            if crate::protection::is_runtime_path(&from) {
                bail!("Cannot rename the running client or its protected state");
            }
            if to.exists() {
                bail!("Destination already exists");
            }
            std::fs::rename(from, to)?;
            Ok(json!({"renamed": true}))
        }
        "fs.text" => {
            let path = context.path(string(&params, "path")?, false)?;
            let file = std::fs::File::open(path)?;
            if !file.metadata()?.is_file() {
                bail!("Only regular files can be edited");
            }
            let mut bytes = Vec::new();
            file.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 256 * 1024 {
                bail!("Text editor limit is 256 KiB");
            }
            let content = String::from_utf8(bytes).context("File is not UTF-8 text")?;
            if content.contains('\0') {
                bail!("Binary files cannot be edited as text");
            }
            Ok(json!({"content": content}))
        }
        "fs.edit" => {
            let path = context.path(string(&params, "path")?, false)?;
            let content = string(&params, "content")?;
            if content.len() > 256 * 1024 {
                bail!("Text editor limit is 256 KiB");
            }
            if !path.is_file() {
                bail!("Only regular files can be edited");
            }
            let temporary = path.with_file_name(format!(".remote-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<()> {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.set_permissions(std::fs::metadata(&path)?.permissions())?;
                file.write_all(content.as_bytes())?;
                file.sync_all()?;
                std::fs::rename(&temporary, &path)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            result?;
            Ok(json!({"bytes":content.len()}))
        }
        "fs.read" => {
            let path = context.path(string(&params, "path")?, false)?;
            let file = std::fs::File::open(path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                bail!("Only regular files can be downloaded");
            }
            if metadata.len() > MAX_FILE {
                bail!("File exceeds the 8 MiB limit");
            }
            // The wire protocol stays Base64/JSON, but no full raw-file buffer
            // is needed alongside the encoded response. Still limit the reader
            // in case the file grows after the metadata check.
            let mut encoded = Vec::with_capacity((metadata.len() as usize).div_ceil(3) * 4);
            let count = {
                let mut encoder = base64::write::EncoderWriter::new(&mut encoded, &STANDARD);
                let count = std::io::copy(&mut file.take(MAX_FILE + 1), &mut encoder)?;
                encoder.finish()?;
                count
            };
            if count > MAX_FILE {
                bail!("File exceeds the 8 MiB limit");
            }
            let mut result = json!({});
            result["data"] = String::from_utf8(encoded)?.into();
            Ok(result)
        }
        "fs.write" => {
            let path = context.path(string(&params, "path")?, true)?;
            let encoded = string(&params, "data")?;
            if encoded.len() > (MAX_FILE as usize).div_ceil(3) * 4 {
                bail!("File exceeds the 8 MiB limit");
            }
            let bytes = STANDARD.decode(encoded)?;
            if bytes.len() as u64 > MAX_FILE {
                bail!("File exceeds the 8 MiB limit");
            }
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            file.write_all(&bytes)?;
            Ok(json!({"bytes": bytes.len()}))
        }
        "process.list" => {
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            let mut processes: Vec<_> = system.processes().iter().filter(|(_, p)| p.thread_kind().is_none()).map(|(pid, p)| json!({
                "pid":pid.as_u32(), "name":p.name().to_string_lossy(), "memory":p.memory(), "status":p.status().to_string(),
                "start_time":p.start_time(), "can_kill":pid.as_u32() > 1 && pid.as_u32() != std::process::id()
            })).collect();
            processes.sort_by_key(|p| p["pid"].as_u64());
            let truncated = processes.len() > 10000;
            processes.truncate(10000);
            Ok(json!({"processes":processes, "truncated": truncated}))
        }
        "process.kill" => {
            let pid = params["pid"].as_u64().filter(|p| *p > 1 && *p <= u32::MAX as u64)
                .context("Invalid PID")? as u32;
            if pid == std::process::id() { bail!("Cannot terminate the remote client itself"); }
            let start = params["start_time"].as_u64().context("Missing process start time; refresh the process list")?;
            let mut system = System::new();
            let target = sysinfo::Pid::from_u32(pid);
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[target]),
                true,
                ProcessRefreshKind::nothing(),
            );
            let process = system.process(target).context("Process no longer exists")?;
            if process.thread_kind().is_some() { bail!("Select a process, not a thread"); }
            if process.start_time() != start { bail!("PID was reused; refresh the process list before retrying"); }
            if !process.kill() { bail!("Cannot terminate process; check account permissions"); }
            Ok(json!({"terminated":true,"pid":pid}))
        }
        _ => bail!("Unsupported operation: {action}"),
    }
}

async fn bounded_output<R: AsyncRead + Unpin>(mut reader: R) -> Result<(String, bool)> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_OUTPUT.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok((crate::output::decode(&output), truncated))
}

// Kill descendants on cancellation.
struct ProcessTree {
    pid: Option<u32>,
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill.exe")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output();
            }
        }
    }
}

async fn run_process(mut process: tokio::process::Command, seconds: u64) -> Result<Value> {
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    #[cfg(windows)]
    process.creation_flags(CREATE_NO_WINDOW);
    let mut child = process.spawn()?;
    let mut tree = ProcessTree { pid: child.id() };
    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;
    let operation = async {
        let (status, out, err) = tokio::try_join!(
            async { Ok::<_, anyhow::Error>(child.wait().await?) },
            bounded_output(stdout),
            bounded_output(stderr)
        )?;
        Ok::<_, anyhow::Error>(
            json!({"exit_code":status.code(), "stdout":out.0, "stderr":err.0, "truncated":out.1 || err.1}),
        )
    };
    match tokio::time::timeout(Duration::from_secs(seconds), operation).await {
        Ok(result) => {
            if result.is_ok() {
                tree.pid = None;
            }
            result
        }
        Err(_) => {
            drop(tree);
            let _ = child.kill().await;
            bail!("Command timed out after {seconds} seconds; process tree terminated");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox() -> (PathBuf, Context) {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path).unwrap();
        let root = path.canonicalize().unwrap();
        (
            path,
            Context {
                root: Some(root),
                disable_shell: true,
            },
        )
    }

    #[test]
    fn file_round_trip_and_boundary() {
        let (path, ctx) = sandbox();
        execute_blocking(
            "fs.write",
            json!({"path":"hello.txt","data":STANDARD.encode(b"hello")}),
            &ctx,
        )
        .unwrap();
        assert!(execute_blocking("fs.write", json!({"path":"hello.txt","data":""}), &ctx).is_err());
        let content = execute_blocking("fs.read", json!({"path":"hello.txt"}), &ctx).unwrap();
        assert_eq!(content["data"], STANDARD.encode(b"hello"));
        execute_blocking(
            "fs.edit",
            json!({"path":"hello.txt","content":"updated"}),
            &ctx,
        )
        .unwrap();
        assert_eq!(
            execute_blocking("fs.text", json!({"path":"hello.txt"}), &ctx).unwrap()["content"],
            "updated"
        );
        assert!(ctx.path("../outside", true).is_err());
        assert!(execute_blocking("fs.delete", json!({"path":"."}), &ctx).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn streamed_file_download_preserves_padding_and_size_limit() {
        let (path, ctx) = sandbox();
        for size in [0, 1, 2, 3, 8191, 8192, 8193, MAX_FILE as usize] {
            let bytes: Vec<u8> = (0..size).map(|i| i as u8).collect();
            std::fs::write(path.join("download.bin"), &bytes).unwrap();
            let result = execute_blocking("fs.read", json!({"path":"download.bin"}), &ctx).unwrap();
            assert_eq!(result["data"], STANDARD.encode(&bytes));
        }
        std::fs::File::create(path.join("too-large.bin")).unwrap().set_len(MAX_FILE + 1).unwrap();
        assert!(execute_blocking("fs.read", json!({"path":"too-large.bin"}), &ctx).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_escape_root() {
        let (path, ctx) = sandbox();
        std::os::unix::fs::symlink("/", path.join("escape")).unwrap();
        assert!(ctx.path("escape/etc/passwd", false).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn disabled_shell_is_rejected() {
        let ctx = Arc::new(Context {
            root: None,
            disable_shell: true,
        });
        assert!(execute("shell.exec", json!({"command":"echo hello"}), ctx)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_output_and_timeout() {
        let ctx = Arc::new(Context {
            root: None,
            disable_shell: false,
        });
        let result = execute("shell.exec", json!({"command":"printf hello"}), ctx.clone())
            .await
            .unwrap();
        assert_eq!(result["stdout"], "hello");
        assert!(execute(
            "shell.exec",
            json!({"command":"sleep 10", "timeout":1}),
            ctx
        )
        .await
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn terminate_only_selected_process() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let (_, ctx) = sandbox();
        let pid = child.id();
        let system = System::new_all();
        let start = system.process(sysinfo::Pid::from_u32(pid)).unwrap().start_time();
        assert!(execute_blocking("process.kill", json!({"pid":pid,"start_time":start + 1}), &ctx).is_err());
        assert!(child.try_wait().unwrap().is_none());
        assert!(execute_blocking("process.kill", json!({"pid":std::process::id(),"start_time":start}), &ctx).is_err());
        assert!(execute_blocking("process.kill", json!({"pid":1,"start_time":start}), &ctx).is_err());
        assert_eq!(execute_blocking("process.kill", json!({"pid":pid,"start_time":start}), &ctx).unwrap()["terminated"], true);
        assert!(!child.wait().unwrap().success());
        std::fs::remove_dir_all(ctx.root.unwrap()).unwrap();
    }
}
