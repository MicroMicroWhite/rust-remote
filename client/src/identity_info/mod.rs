use serde_json::{json, Value};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub fn current() -> Value {
    #[cfg(unix)]
    let result = unix::current();
    #[cfg(windows)]
    let result = windows::current();
    result.unwrap_or_else(|error| json!({"error": error.to_string()}))
}
