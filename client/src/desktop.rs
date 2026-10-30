use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};
use std::sync::Mutex;

// Each input is atomic, including modifiers. Dropping Enigo releases held keys
// even on errors, so a lost browser/device connection cannot leave keys held.
static INPUT_LOCK: Mutex<()> = Mutex::new(());
// Bound raw-frame memory even when two observers request screenshots together.
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

fn primary() -> Result<screenshots::Screen> {
    let screens = screenshots::Screen::all().context("No accessible desktop session")?;
    screens.iter().find(|s| s.display_info.is_primary).or(screens.first())
        .copied().context("No display found; an active desktop session is required")
}

pub fn available() -> bool {
    primary().is_ok()
}

pub fn capture(params: &Value) -> Result<Value> {
    let _guard = CAPTURE_LOCK.lock().map_err(|_| anyhow::anyhow!("Screen capture lock unavailable"))?;
    let pixels = primary()?.capture().context("Screen capture failed; check desktop permissions")?;
    let limit = params["max_width"].as_u64().unwrap_or(1920).clamp(640, 1920) as u32;
    let quality = params["quality"].as_u64().unwrap_or(75).clamp(30, 90) as u8;
    encode_frame(pixels, limit, quality)
}

fn encode_frame(pixels: image::RgbaImage, limit: u32, quality: u8) -> Result<Value> {
    let (width, height) = pixels.dimensions();
    if width == 0 || height == 0 {
        bail!("Screen capture returned an empty image");
    }
    let ratio = (f64::from(limit) / f64::from(width))
        .min(f64::from(limit * 9 / 16) / f64::from(height));
    let width = (f64::from(width) * ratio).round().max(1.0) as u32;
    let height = (f64::from(height) * ratio).round().max(1.0) as u32;
    let pixels = if pixels.dimensions() == (width, height) {
        pixels
    } else {
        let resized = image::imageops::resize(&pixels, width, height, image::imageops::FilterType::Triangle);
        drop(pixels);
        resized
    };
    // Encode RGBA directly: JPEG ignores alpha. Using the concrete encoder also
    // lets the linker discard unused image formats and pixel-type conversions.
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality).encode_image(&pixels)?;
    drop(pixels);
    let mut result = json!({"mime":"image/jpeg","width":width,"height":height});
    result["data"] = STANDARD.encode(bytes).into();
    Ok(result)
}

pub fn key(value: &str) -> Result<Key> {
    Ok(match value {
        "Enter" => Key::Return, "Escape" => Key::Escape, "Backspace" => Key::Backspace,
        "Tab" => Key::Tab, "Delete" => Key::Delete, "Insert" => Key::Insert,
        "Home" => Key::Home, "End" => Key::End, "PageUp" => Key::PageUp, "PageDown" => Key::PageDown,
        "ArrowUp" => Key::UpArrow, "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow, "ArrowRight" => Key::RightArrow,
        "F1" => Key::F1, "F2" => Key::F2, "F3" => Key::F3, "F4" => Key::F4,
        "F5" => Key::F5, "F6" => Key::F6, "F7" => Key::F7, "F8" => Key::F8,
        "F9" => Key::F9, "F10" => Key::F10, "F11" => Key::F11, "F12" => Key::F12,
        "CapsLock" => Key::CapsLock,
        _ if value.chars().count() == 1 && !value.chars().next().unwrap().is_control() => Key::Unicode(value.chars().next().unwrap()),
        _ => bail!("Unsupported keyboard key"),
    })
}

fn coordinate(params: &Value, name: &str, origin: i32, size: u32) -> Result<i32> {
    let value = params[name].as_f64().filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
        .context("Invalid normalized screen coordinates")?;
    Ok(origin + (value * size.saturating_sub(1) as f64).round() as i32)
}

pub fn input(params: &Value) -> Result<Value> {
    let kind = params["kind"].as_str().context("Missing input kind")?;
    // Validate before connecting to the desktop or performing any input.
    let keyboard = if kind == "key" { Some(key(params["key"].as_str().context("Missing key")?)?) } else { None };
    if !matches!(kind, "click" | "scroll" | "key" | "text") { bail!("Unsupported input kind"); }
    let text = params["text"].as_str().unwrap_or("");
    if kind == "text" && (text.is_empty() || text.len() > 4096 || text.contains('\0')) { bail!("Invalid input text"); }
    let modifiers = params["modifiers"].as_array();
    if let Some(modifiers) = modifiers {
        if modifiers.len() > 4 || modifiers.iter().any(|m| !matches!(m.as_str(), Some("Control" | "Alt" | "Shift" | "Meta"))) {
            bail!("Invalid keyboard modifiers");
        }
    }
    let _guard = INPUT_LOCK.lock().map_err(|_| anyhow::anyhow!("Input lock unavailable"))?;
    let mut enigo = Enigo::new(&Settings { linux_delay: 0, ..Settings::default() })
        .context("Cannot control desktop; check desktop session and input permissions")?;
    let keys: Vec<Key> = modifiers.into_iter().flatten().map(|m| match m.as_str().unwrap() {
        "Control" => Key::Control, "Alt" => Key::Alt, "Shift" => Key::Shift, _ => Key::Meta,
    }).collect();
    if matches!(kind, "click" | "scroll") {
        let display = primary()?.display_info;
        let x = coordinate(params, "x", display.x, display.width)?;
        let y = coordinate(params, "y", display.y, display.height)?;
        enigo.move_mouse(x, y, Coordinate::Abs)?;
    }
    for modifier in &keys { enigo.key(*modifier, Direction::Press)?; }
    match kind {
        "click" => {
            let button = match params["button"].as_str().unwrap_or("left") {
                "left" => Button::Left, "right" => Button::Right, "middle" => Button::Middle,
                _ => bail!("Invalid mouse button"),
            };
            enigo.button(button, Direction::Click)?;
        }
        "scroll" => {
            let amount = params["amount"].as_i64().filter(|n| (-20..=20).contains(n)).context("Invalid scroll amount")?;
            enigo.scroll(amount as i32, Axis::Vertical)?;
        }
        "key" => enigo.key(keyboard.unwrap(), Direction::Click)?,
        "text" => enigo.text(text)?,
        _ => unreachable!(),
    }
    for modifier in keys.iter().rev() { enigo.key(*modifier, Direction::Release)?; }
    Ok(json!({"sent":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_matches_previous_encoder_for_landscape_portrait_and_unchanged_size() {
        for (width, height, limit) in [(96, 54, 64), (54, 96, 64), (64, 36, 64), (17, 13, 32), (1, 80, 16)] {
            let pixels = image::RgbaImage::from_fn(width, height, |x, y| {
                image::Rgba([(x * 13) as u8, (y * 17) as u8, (x + y) as u8, 255])
            });
            let reference = image::DynamicImage::ImageRgba8(pixels.clone())
                .resize(limit, limit * 9 / 16, image::imageops::FilterType::Triangle).to_rgb8();
            let mut expected = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(reference.clone())
                .write_to(&mut expected, image::ImageOutputFormat::Jpeg(65)).unwrap();
            let actual = encode_frame(pixels, limit, 65).unwrap();
            assert_eq!(actual["width"], reference.width());
            assert_eq!(actual["height"], reference.height());
            assert_eq!(STANDARD.decode(actual["data"].as_str().unwrap()).unwrap(), expected.into_inner());
        }
        assert!(encode_frame(image::RgbaImage::new(0, 0), 1280, 65).is_err());
    }

    #[test]
    fn normalized_coordinates_and_keys() {
        assert_eq!(coordinate(&json!({"x":1.0}), "x", -1920, 1920).unwrap(), -1);
        assert_eq!(coordinate(&json!({"x":0.0}), "x", 100, 1920).unwrap(), 100);
        assert!(coordinate(&json!({"x":1.1}), "x", 0, 1920).is_err());
        for value in ["Enter", "ArrowLeft", "F12", "a", "中", " "] { assert!(key(value).is_ok()); }
        for value in ["Control", "Unidentified", "\0", "ab"] { assert!(key(value).is_err()); }
    }
}
