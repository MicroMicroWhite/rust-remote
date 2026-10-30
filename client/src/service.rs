//! Visible, SCM-managed Windows service. Installation is an explicit administrator action.
use anyhow::{bail, Context, Result};
use std::{
    ffi::c_void,
    sync::{Mutex, OnceLock},
};
use tokio::sync::watch;
use windows_sys::Win32::{
    Foundation::{ERROR_CALL_NOT_IMPLEMENTED, ERROR_SERVICE_SPECIFIC_ERROR, NO_ERROR},
    System::Services::{
        RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW,
        SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP, SERVICE_CONTROL_INTERROGATE,
        SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_START_PENDING,
        SERVICE_STATUS, SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_TABLE_ENTRYW,
        SERVICE_WIN32_OWN_PROCESS,
    },
};

const NAME: &str = "rust-client";
static ARGS: Mutex<Option<crate::Args>> = Mutex::new(None);
static RESULT: Mutex<Option<Result<()>>> = Mutex::new(None);
static STATE: OnceLock<ServiceState> = OnceLock::new();

struct ServiceState {
    // SCM owns this handle until service_main returns. Store its address so the shared
    // reporter is Send + Sync; access is serialized by the status mutex.
    handle: usize,
    status: Mutex<SERVICE_STATUS>,
    shutdown: watch::Sender<bool>,
}

impl ServiceState {
    fn report(&self, next: u32, failed: bool) -> Result<()> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| anyhow::anyhow!("Service status poisoned"))?;
        // A stop received while initialization finishes must not be overwritten by Running.
        if status.dwCurrentState == SERVICE_STOP_PENDING && next == SERVICE_RUNNING {
            return Ok(());
        }
        status.dwCurrentState = next;
        status.dwControlsAccepted = if next == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        };
        status.dwWin32ExitCode = if failed {
            ERROR_SERVICE_SPECIFIC_ERROR
        } else {
            NO_ERROR
        };
        status.dwServiceSpecificExitCode = u32::from(failed);
        let pending = next == SERVICE_START_PENDING || next == SERVICE_STOP_PENDING;
        status.dwCheckPoint = u32::from(pending);
        status.dwWaitHint = if pending { 30_000 } else { 0 };
        // SAFETY: SCM issued the handle and the status is valid for the duration of this call.
        if unsafe { SetServiceStatus(self.handle as _, &*status) } == 0 {
            return Err(std::io::Error::last_os_error()).context("Cannot report service status");
        }
        Ok(())
    }

    fn interrogate(&self) {
        if let Ok(status) = self.status.lock() {
            // SAFETY: the registered handle and guarded status remain valid during callbacks.
            unsafe { SetServiceStatus(self.handle as _, &*status) };
        }
    }
}

pub fn is_service() -> bool {
    STATE.get().is_some()
}

pub fn data_dir() -> Result<std::path::PathBuf> {
    Ok(
        std::path::PathBuf::from(
            std::env::var_os("ProgramData").context("ProgramData is missing")?,
        )
        .join("RustRemote")
        .join(NAME),
    )
}

pub fn dispatch(args: crate::Args) -> Result<()> {
    *ARGS
        .lock()
        .map_err(|_| anyhow::anyhow!("Service arguments poisoned"))? = Some(args);
    let mut name: Vec<u16> = NAME.encode_utf16().chain(Some(0)).collect();
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: std::ptr::null_mut(),
            lpServiceProc: None,
        },
    ];
    // SAFETY: the null-terminated service table and UTF-16 name outlive the blocking dispatcher.
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("--service must be started by the Windows service manager as rust-client");
    }
    RESULT
        .lock()
        .map_err(|_| anyhow::anyhow!("Service result poisoned"))?
        .take()
        .context("Service entry point was not called")?
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
    // Never unwind through the Windows callback boundary.
    let result = std::panic::catch_unwind(start)
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Service panicked")));
    if let Some(state) = STATE.get() {
        let stopped = state.report(SERVICE_STOPPED, result.is_err());
        if let Ok(mut slot) = RESULT.lock() {
            *slot = Some(result.and(stopped));
        }
    } else if let Ok(mut slot) = RESULT.lock() {
        *slot = Some(result);
    }
}

fn start() -> Result<()> {
    let name: Vec<u16> = NAME.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the name is NUL-terminated and the callback has the required system ABI.
    let handle = unsafe {
        RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(control_handler), std::ptr::null())
    };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error()).context("Cannot register rust-client service");
    }
    let (shutdown, receiver) = watch::channel(false);
    if STATE
        .set(ServiceState {
            handle: handle as usize,
            status: Mutex::new(SERVICE_STATUS {
                dwServiceType: SERVICE_WIN32_OWN_PROCESS,
                dwCurrentState: SERVICE_START_PENDING,
                dwControlsAccepted: 0,
                dwWin32ExitCode: NO_ERROR,
                dwServiceSpecificExitCode: 0,
                dwCheckPoint: 0,
                dwWaitHint: 0,
            }),
            shutdown,
        })
        .is_err()
    {
        bail!("Service is already registered in this process");
    }
    STATE
        .get()
        .context("Service state missing")?
        .report(SERVICE_START_PENDING, false)?;
    let args = ARGS
        .lock()
        .map_err(|_| anyhow::anyhow!("Service arguments poisoned"))?
        .take()
        .context("Missing service arguments")?;
    crate::run_client(args, Some(receiver))
}

pub fn running() -> Result<()> {
    STATE
        .get()
        .context("Service state missing")?
        .report(SERVICE_RUNNING, false)
}

unsafe extern "system" fn control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *mut c_void,
    _context: *mut c_void,
) -> u32 {
    let Some(state) = STATE.get() else {
        return ERROR_CALL_NOT_IMPLEMENTED;
    };
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            let _ = state.report(SERVICE_STOP_PENDING, false);
            state.shutdown.send_replace(true);
            NO_ERROR
        }
        SERVICE_CONTROL_INTERROGATE => {
            state.interrogate();
            NO_ERROR
        }
        _ => ERROR_CALL_NOT_IMPLEMENTED,
    }
}
