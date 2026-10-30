use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
};

pub fn is_service() -> bool {
    #[cfg(windows)]
    {
        crate::service::is_service()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn state_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        if is_service() {
            return crate::service::data_dir();
        }
        Ok(
            PathBuf::from(std::env::var_os("LOCALAPPDATA").context("LOCALAPPDATA is missing")?)
                .join("RustRemote"),
        )
    }
    #[cfg(not(windows))]
    {
        let base = match std::env::var_os("XDG_STATE_HOME") {
            Some(path) if Path::new(&path).is_absolute() => PathBuf::from(path),
            _ => PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?)
                .join(".local/state"),
        };
        Ok(base.join("rust-remote"))
    }
}

pub fn init_logging() {
    // The client is intentionally silent. Diagnostics must never create a
    // log file or leak operational details on the controlled machine.
}

#[cfg(target_os = "linux")]
pub fn spawn_background() -> Result<()> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .args(std::env::args_os().skip(1))
        .arg("--foreground");
    configure_background(&mut command)?;
    command.spawn().context("Cannot start background client")?;
    Ok(())
}

/// Detach from the launching terminal while retaining the working directory and
/// desktop environment. Used for both normal startup and online update restarts.
#[cfg(target_os = "linux")]
pub fn configure_background(command: &mut std::process::Command) -> Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe; no allocations or locks are used in
    // the post-fork callback. Command propagates failure back to the launcher.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

pub fn acquire_instance() -> Result<Option<File>> {
    let directory = state_dir()?;
    std::fs::create_dir_all(&directory)?;
    acquire_lock(&directory.join("client.lock"))
}

fn acquire_lock(path: &Path) -> Result<Option<File>> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_lock_releases_on_exit() {
        let path = std::env::temp_dir().join(format!("remote-{}.lock", uuid::Uuid::new_v4()));
        let first = acquire_lock(&path).unwrap().unwrap();
        assert!(acquire_lock(&path).unwrap().is_none());
        drop(first);
        let next = acquire_lock(&path).unwrap().unwrap();
        drop(next);
        std::fs::remove_file(path).unwrap();
    }
}
