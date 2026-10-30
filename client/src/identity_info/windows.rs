use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{io, mem, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::ConvertSidToStringSidW, GetSidSubAuthority, GetSidSubAuthorityCount,
        GetTokenInformation, LookupAccountSidW, TokenElevation, TokenGroups, TokenIntegrityLevel,
        TokenUser, PSID, TOKEN_ELEVATION, TOKEN_GROUPS, TOKEN_INFORMATION_CLASS,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn token_data(token: &Token, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, class, ptr::null_mut(), 0, &mut size);
    }
    if size == 0 || size > 1024 * 1024 {
        return Err(io::Error::last_os_error()).context("Cannot size process token information");
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token.0, class, buffer.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(io::Error::last_os_error()).context("Cannot read process token information");
    }
    Ok(buffer)
}

unsafe fn sid_text(sid: PSID) -> Result<String> {
    let mut text = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        return Err(io::Error::last_os_error()).context("Cannot read account SID");
    }
    let mut length = 0;
    while *text.add(length) != 0 {
        length += 1;
    }
    let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
    LocalFree(text.cast());
    Ok(value)
}

unsafe fn account_name(sid: PSID) -> Option<String> {
    let (mut name_len, mut domain_len, mut kind) = (0, 0, 0);
    LookupAccountSidW(
        ptr::null(),
        sid,
        ptr::null_mut(),
        &mut name_len,
        ptr::null_mut(),
        &mut domain_len,
        &mut kind,
    );
    if name_len == 0 || name_len > 32768 || domain_len > 32768 {
        return None;
    }
    let mut name = vec![0u16; name_len as usize];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    if LookupAccountSidW(
        ptr::null(),
        sid,
        name.as_mut_ptr(),
        &mut name_len,
        domain.as_mut_ptr(),
        &mut domain_len,
        &mut kind,
    ) == 0
    {
        return None;
    }
    let name = String::from_utf16_lossy(&name[..name_len as usize]);
    let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
    Some(if domain.is_empty() {
        name
    } else {
        format!("{domain}\\{name}")
    })
}

pub fn current() -> Result<Value> {
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error()).context("Cannot open process token");
    }
    let token = Token(handle);
    let user_data = token_data(&token, TokenUser)?;
    let elevation_data = token_data(&token, TokenElevation)?;
    let group_data = token_data(&token, TokenGroups)?;
    let integrity_data = token_data(&token, TokenIntegrityLevel)?;
    unsafe {
        let user = &*user_data.as_ptr().cast::<TOKEN_USER>();
        let account_id = sid_text(user.User.Sid)?;
        let elevated = (*elevation_data.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated != 0;
        let token_groups = &*group_data.as_ptr().cast::<TOKEN_GROUPS>();
        let count = token_groups.GroupCount as usize;
        let offset = mem::offset_of!(TOKEN_GROUPS, Groups);
        if offset + count * mem::size_of_val(&token_groups.Groups[0])
            > group_data.len() * mem::size_of::<usize>()
        {
            bail!("Invalid process token group data");
        }
        let mut groups = Vec::with_capacity(count);
        for group in std::slice::from_raw_parts(token_groups.Groups.as_ptr(), count) {
            groups.push(json!({
                "id": sid_text(group.Sid)?, "name": account_name(group.Sid),
                "state": if group.Attributes & 0x10 != 0 { "deny_only" } else if group.Attributes & 0x4 != 0 { "enabled" } else { "disabled" }
            }));
        }
        let label = &*integrity_data.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        let authorities = *GetSidSubAuthorityCount(label.Label.Sid);
        if authorities == 0 {
            bail!("Invalid token integrity SID");
        }
        let integrity_rid = *GetSidSubAuthority(label.Label.Sid, u32::from(authorities - 1));
        let integrity = match integrity_rid {
            0..0x1000 => "untrusted",
            0x1000..0x2000 => "low",
            0x2000..0x3000 => "medium",
            0x3000..0x4000 => "high",
            0x4000..0x5000 => "system",
            _ => "protected",
        };
        Ok(json!({
            "account": account_name(user.User.Sid), "account_id": account_id,
            "privilege_level": if account_id == "S-1-5-18" { "system" } else if elevated { "elevated" } else { "standard" },
            "elevated": elevated, "integrity": integrity, "integrity_rid": integrity_rid,
            "groups": groups
        }))
    }
}
