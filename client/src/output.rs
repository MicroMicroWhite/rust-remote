pub fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_owned();
    }
    #[cfg(windows)]
    {
        let code_page = unsafe { GetConsoleOutputCP() };
        let code_page = if code_page == 0 {
            unsafe { GetOEMCP() }
        } else {
            code_page
        };
        if let Some(text) = decode_code_page(bytes, code_page) {
            return text;
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetOEMCP() -> u32;
    fn GetConsoleOutputCP() -> u32;
    fn MultiByteToWideChar(
        code_page: u32,
        flags: u32,
        input: *const u8,
        input_len: i32,
        output: *mut u16,
        output_len: i32,
    ) -> i32;
}

#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    let length = i32::try_from(bytes.len()).ok()?;
    let mut wide = vec![0u16; bytes.len()];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            length,
            wide.as_mut_ptr(),
            length,
        )
    };
    (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_command_output() {
        let text = "本地地址 外部地址 状态 PID\r\n卷的序列号是 C073-F4F3";
        assert_eq!(decode(text.as_bytes()), text);
        assert_eq!(decode(format!("\u{feff}{text}").as_bytes()), text);
        for little_endian in [true, false] {
            let mut bytes = if little_endian {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in text.encode_utf16() {
                bytes.extend(if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            assert_eq!(decode(&bytes), text);
        }
        assert_eq!(decode(b""), "");
    }

    #[cfg(windows)]
    #[test]
    fn chinese_windows_output() {
        assert_eq!(
            decode_code_page(b"\xb1\xbe\xb5\xd8\xb5\xd8\xd6\xb7", 936).unwrap(),
            "本地地址"
        );
        assert_eq!(
            decode_code_page(b"\xbe\xed\xb5\xc4\xd0\xf2\xc1\xd0\xba\xc5", 936).unwrap(),
            "卷的序列号"
        );
    }
}
