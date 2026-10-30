#[cfg(windows)]
use anyhow::Context;
use anyhow::Result;
use std::path::{Path, PathBuf};

pub struct ExecutableProtection {
    #[cfg(windows)]
    _no_delete_handle: std::fs::File,
}

pub fn protect_running_executable() -> Result<ExecutableProtection> {
    let executable = std::env::current_exe()?.canonicalize()?;
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
            FILE_SHARE_READ, FILE_SHARE_WRITE, INVALID_FILE_ATTRIBUTES,
        };

        let path: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(std::io::Error::last_os_error())
                .context("Cannot read executable attributes");
        }
        let protected = FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM;
        if attributes & protected != protected
            && unsafe { SetFileAttributesW(path.as_ptr(), attributes | protected) } == 0
        {
            return Err(std::io::Error::last_os_error())
                .context("Cannot mark executable as a system-hidden file");
        }

        // A running image normally permits replacement. Omitting FILE_SHARE_DELETE keeps
        // the installed executable from being deleted or renamed until this process exits.
        let no_delete_handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&executable)
            .context("Cannot lock executable against deletion")?;
        Ok(ExecutableProtection {
            _no_delete_handle: no_delete_handle,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = executable;
        Ok(ExecutableProtection {})
    }
}

#[cfg(windows)]
pub fn mark_system_hidden(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
        INVALID_FILE_ATTRIBUTES,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(std::io::Error::last_os_error()).context("Cannot read executable attributes");
    }
    if unsafe {
        SetFileAttributesW(
            path.as_ptr(),
            attributes | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("Cannot mark installed executable as system-hidden");
    }
    Ok(())
}

pub fn is_runtime_path(path: &Path) -> bool {
    let Some(candidate) = canonical(path) else {
        return false;
    };
    let mut protected = Vec::with_capacity(2);
    if let Ok(executable) = std::env::current_exe().and_then(|path| path.canonicalize()) {
        protected.push(executable);
    }
    if let Some(state) = crate::runtime::state_dir()
        .ok()
        .and_then(|path| path.canonicalize().ok())
    {
        protected.push(state);
    }
    is_under_any(&candidate, &protected)
}

fn canonical(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

fn is_under_any(candidate: &Path, protected: &[PathBuf]) -> bool {
    protected
        .iter()
        .any(|root| candidate == root || candidate.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_roots_cover_their_descendants_only() {
        let root = PathBuf::from("/srv/rust-remote");
        let nested = root.join("nested");
        assert!(is_under_any(&root, std::slice::from_ref(&root)));
        assert!(is_under_any(&nested, std::slice::from_ref(&root)));
        assert!(!is_under_any(Path::new("/srv/rust-remote-other"), &[root]));
    }
}
