//! Explicit, native service installation. No shell or PowerShell is involved.
use anyhow::{bail, Context, Result};
use clap::ValueEnum;
use serde_json::{json, Value};
use std::{
    ffi::OsStr,
    fs,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_SERVICE_ALREADY_RUNNING},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    },
    System::Services::{
        ChangeServiceConfig2W, CloseServiceHandle, CreateServiceW, OpenSCManagerW, OpenServiceW,
        QueryServiceStatus, StartServiceW, SC_ACTION, SC_ACTION_RESTART, SC_HANDLE,
        SC_MANAGER_CONNECT, SC_MANAGER_CREATE_SERVICE, SERVICE_ALL_ACCESS, SERVICE_AUTO_START,
        SERVICE_CONFIG_FAILURE_ACTIONS, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, SERVICE_ERROR_NORMAL,
        SERVICE_FAILURE_ACTIONSW, SERVICE_FAILURE_ACTIONS_FLAG, SERVICE_QUERY_STATUS,
        SERVICE_RUNNING, SERVICE_STATUS, SERVICE_WIN32_OWN_PROCESS,
    },
    UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK},
};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Account {
    LocalService,
    LocalSystem,
}

pub(super) struct ServiceHandle(pub SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}

pub(super) fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

pub fn show_message(message: &str, failed: bool) {
    let title = wide("rust-client service installation");
    let message = wide(message);
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK
                | if failed {
                    MB_ICONERROR
                } else {
                    MB_ICONINFORMATION
                },
        );
    }
}

fn secure_directory(path: &Path, account: Account, writable: bool) -> Result<()> {
    fs::create_dir_all(path)?;
    secure_permissions(path, account, writable)
}

fn secure_permissions(path: &Path, account: Account, writable: bool) -> Result<()> {
    let service_rule = match account {
        Account::LocalService if writable => "(A;OICI;0x1301bf;;;LS)",
        Account::LocalService => "(A;OICI;GRGX;;;LS)",
        Account::LocalSystem => "",
    };
    let sddl = wide(format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){service_rule}"));
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("Cannot prepare service directory ACL");
    }
    let path = wide(path);
    let result = unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    let error = std::io::Error::last_os_error();
    unsafe {
        LocalFree(descriptor);
    }
    if result == 0 {
        return Err(error).context("Cannot secure service directory");
    }
    Ok(())
}

fn configure_recovery(service: SC_HANDLE) -> Result<()> {
    let mut actions = [
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 5_000,
        },
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 15_000,
        },
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 60_000,
        },
    ];
    let failure_actions = SERVICE_FAILURE_ACTIONSW {
        dwResetPeriod: 24 * 60 * 60,
        lpRebootMsg: ptr::null_mut(),
        lpCommand: ptr::null_mut(),
        cActions: actions.len() as u32,
        lpsaActions: actions.as_mut_ptr(),
    };
    if unsafe {
        ChangeServiceConfig2W(
            service,
            SERVICE_CONFIG_FAILURE_ACTIONS,
            &failure_actions as *const _ as *const std::ffi::c_void,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("Cannot configure automatic service recovery");
    }
    let non_crash_failures = SERVICE_FAILURE_ACTIONS_FLAG {
        fFailureActionsOnNonCrashFailures: 1,
    };
    if unsafe {
        ChangeServiceConfig2W(
            service,
            SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
            &non_crash_failures as *const _ as *const std::ffi::c_void,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("Cannot enable recovery for non-crash service failures");
    }
    Ok(())
}

/// Load the installation's protected connection settings only for the SCM invocation.
pub fn load_configuration() -> Result<()> {
    if std::env::args_os()
        .nth(1)
        .is_none_or(|arg| arg != "--service")
    {
        return Ok(());
    }
    let path = crate::service::data_dir()?.join("connection.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("Cannot read service connection settings"),
    };
    let config: Value =
        serde_json::from_slice(&bytes).context("Invalid service connection settings")?;
    let server = config["server"]
        .as_str()
        .context("Missing service server")?;
    let token = config["token"].as_str().context("Missing service token")?;
    let allow_insecure = config["allow_insecure"]
        .as_bool()
        .context("Missing service protocol setting")?;
    std::env::set_var("REMOTE_SERVER", server);
    std::env::set_var("REMOTE_TOKEN", token);
    std::env::set_var(
        "REMOTE_ALLOW_INSECURE",
        if allow_insecure { "true" } else { "false" },
    );
    Ok(())
}

// Quote a complete Windows command-line argument, including embedded quotes and trailing slashes.
pub(super) fn quote(value: &OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in value.encode_wide() {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        result.push(unit);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}

pub fn install(args: &crate::Args) -> Result<()> {
    let selected_account = args
        .service_account
        .context("Choose --service-account local-service or local-system")?;
    if !args.server.starts_with("wss://")
        && !(args.allow_insecure && args.server.starts_with("ws://"))
    {
        bail!("Use wss://, or explicitly allow ws:// for a trusted network");
    }
    if args.token.len() < 32 {
        bail!("Device token must contain at least 32 characters");
    }
    let root = args.root.as_ref().map(fs::canonicalize).transpose()?;
    let identity = if args.identity == Path::new(".rust-remote-device-id") {
        crate::service::data_dir()?.join("device-id")
    } else if args.identity.is_absolute() {
        args.identity.clone()
    } else {
        bail!("A custom service identity path must be absolute");
    };
    // Opening SCM first checks elevation before changing any files.
    let manager = unsafe {
        OpenSCManagerW(
            ptr::null(),
            ptr::null(),
            SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE,
        )
    };
    if manager.is_null() {
        return Err(std::io::Error::last_os_error()).context("Run this installer as administrator");
    }
    let manager = ServiceHandle(manager);
    let name = wide("rust-client");
    let existing = unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_QUERY_STATUS) };
    if !existing.is_null() {
        drop(ServiceHandle(existing));
        bail!("rust-client is already installed; the installer does not replace a running service");
    }
    let directory = std::path::PathBuf::from(
        std::env::var_os("ProgramFiles").context("ProgramFiles is missing")?,
    )
    .join("RustRemote");
    let destination = directory.join("rust-remote-client.exe");
    let source = std::env::current_exe()?.canonicalize()?;
    if destination.exists() {
        bail!(
            "The installation destination already exists: {}",
            destination.display()
        );
    }
    let state = crate::service::data_dir()?;
    secure_directory(&directory, selected_account, false)?;
    secure_directory(&state, selected_account, true)?;
    let config_path = state.join("connection.json");
    let old_config = match fs::read(&config_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error).context("Cannot back up existing service connection settings")
        }
    };
    fs::write(
        &config_path,
        serde_json::to_vec(&json!({
            "server": args.server, "token": args.token, "allow_insecure": args.allow_insecure,
        }))?,
    )?;
    let mut command_line = quote(destination.as_os_str());
    for argument in [
        Some(OsStr::new("--service")),
        Some(OsStr::new("--identity")),
        Some(identity.as_os_str()),
        args.name.as_ref().map(|_| OsStr::new("--name")),
        args.name.as_deref().map(OsStr::new),
        root.as_ref().map(|_| OsStr::new("--root")),
        root.as_ref().map(|path| path.as_os_str()),
        args.disable_shell.then_some(OsStr::new("--disable-shell")),
    ]
    .into_iter()
    .flatten()
    {
        command_line.push(b' ' as u16);
        command_line.extend(quote(argument));
    }
    command_line.push(0);
    let account = wide(match selected_account {
        Account::LocalService => "NT AUTHORITY\\LocalService",
        Account::LocalSystem => "LocalSystem",
    });
    let mut copied = false;
    let created = (|| -> Result<ServiceHandle> {
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .context("Cannot create the service executable")?;
        copied = true;
        std::io::copy(&mut fs::File::open(&source)?, &mut target)?;
        target.sync_all()?;
        drop(target);
        crate::protection::mark_system_hidden(&destination)?;
        secure_permissions(&destination, selected_account, false)?;
        let handle = unsafe {
            CreateServiceW(
                manager.0,
                name.as_ptr(),
                name.as_ptr(),
                SERVICE_ALL_ACCESS,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                command_line.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                account.as_ptr(),
                ptr::null(),
            )
        };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error())
                .context("Cannot create rust-client service");
        }
        Ok(ServiceHandle(handle))
    })();
    let service = match created {
        Ok(service) => service,
        Err(error) => {
            if copied {
                let _ = fs::remove_file(&destination);
            }
            if let Some(bytes) = old_config {
                let _ = fs::write(config_path, bytes);
            } else {
                let _ = fs::remove_file(config_path);
            }
            return Err(error);
        }
    };
    configure_recovery(service.0)?;
    if unsafe { StartServiceW(service.0, 0, ptr::null()) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_SERVICE_ALREADY_RUNNING as i32) {
            return Err(error).context(
                "Service is installed, but starting failed; check its connection settings",
            );
        }
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
            return Err(std::io::Error::last_os_error())
                .context("Cannot query the installed service");
        }
        if status.dwCurrentState == SERVICE_RUNNING {
            return Ok(());
        }
        if status.dwCurrentState == windows_sys::Win32::System::Services::SERVICE_STOPPED {
            bail!("Service is installed but stopped during startup (Windows code {}, service code {})",
                status.dwWin32ExitCode, status.dwServiceSpecificExitCode);
        }
        if Instant::now() >= deadline {
            bail!("Service is installed but did not report Running within 30 seconds");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
