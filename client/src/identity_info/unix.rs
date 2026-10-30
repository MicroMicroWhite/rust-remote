use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{ffi::CStr, io, ptr};

fn user_name(id: libc::uid_t) -> Option<String> {
    let mut buffer = vec![0u8; 65536];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found = ptr::null_mut();
    unsafe {
        if libc::getpwuid_r(
            id,
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        ) != 0
            || found.is_null()
        {
            return None;
        }
        Some(
            CStr::from_ptr((*found).pw_name)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

fn group_name(id: libc::gid_t) -> Option<String> {
    let mut buffer = vec![0u8; 65536];
    let mut entry = std::mem::MaybeUninit::<libc::group>::uninit();
    let mut found = ptr::null_mut();
    unsafe {
        if libc::getgrgid_r(
            id,
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        ) != 0
            || found.is_null()
        {
            return None;
        }
        Some(
            CStr::from_ptr((*found).gr_name)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

pub fn current() -> Result<Value> {
    let (uid, euid, gid, egid) = unsafe {
        (
            libc::getuid(),
            libc::geteuid(),
            libc::getgid(),
            libc::getegid(),
        )
    };
    let count = unsafe { libc::getgroups(0, ptr::null_mut()) };
    if count < 0 {
        return Err(io::Error::last_os_error()).context("Cannot read process groups");
    }
    let mut groups = vec![0; count as usize];
    let actual = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
    if actual < 0 {
        return Err(io::Error::last_os_error()).context("Cannot read process groups");
    }
    groups.truncate(actual as usize);
    groups.push(egid);
    groups.sort_unstable();
    groups.dedup();
    let groups: Vec<Value> = groups
        .into_iter()
        .map(|id| {
            json!({
                "id": id.to_string(), "name": group_name(id), "primary": id == egid,
                "state": "enabled"
            })
        })
        .collect();
    let capabilities = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("CapEff:")
                    .map(|value| value.trim().to_owned())
            })
        });
    Ok(json!({
        "account": user_name(euid), "account_id": euid.to_string(),
        "privilege_level": if euid == 0 { "root" } else { "user" },
        "uid": uid, "euid": euid, "gid": gid, "egid": egid,
        "groups": groups, "effective_capabilities": capabilities
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn id(argument: &str) -> String {
        let output = Command::new("id").arg(argument).output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn matches_os_identity_and_groups() {
        let info = current().unwrap();
        assert_eq!(info["account_id"], id("-u"));
        assert_eq!(info["account"], id("-un"));
        assert_eq!(info["egid"].to_string(), id("-g"));
        let mut expected: Vec<String> = id("-G").split_whitespace().map(str::to_owned).collect();
        expected.sort();
        expected.dedup();
        let mut actual: Vec<String> = info["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["id"].as_str().unwrap().to_owned())
            .collect();
        actual.sort();
        assert_eq!(actual, expected);
        assert_eq!(info["privilege_level"] == "root", id("-u") == "0");
        assert!(info["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["primary"] == true && g["id"] == id("-g")));
    }
}
