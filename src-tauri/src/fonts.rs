//! Native font enumeration and installation.
//!
//! This is the whole reason the desktop port exists. A browser can tell you a
//! font is missing and hand you a zip; it cannot put the font where the OS
//! looks for it. Everything here is the part the web app structurally cannot
//! do.
//!
//! Enumeration goes through `font-kit`, which reads the platform's own font
//! registry — CoreText, DirectWrite, fontconfig. Deliberately not a crate that
//! parses every font file on disk: the development machine has 11,630
//! installed font files and the OS has already indexed them.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use font_kit::handle::Handle;
use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};

/// Case/punctuation-insensitive key, matching `normalizeKey` in the frontend.
fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.chars() {
        let c = if ch == '-' || ch == '_' || ch == ',' {
            ' '
        } else {
            ch
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            for lower in c.to_lowercase() {
                out.push(lower);
            }
            last_space = false;
        }
    }
    out.trim().to_string()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    /// Every installed family name.
    pub families: Vec<String>,
    /// Full and PostScript names, for the families relevant to the request.
    pub faces: Vec<String>,
}

/// Load a handle and collect its face names, ignoring anything unreadable.
///
/// A handful of system fonts fail to load — datafork suitcases, fonts the
/// process has no read permission for. One bad face must not take out the
/// whole inventory, so failures are dropped silently.
fn push_face_names(handle: &Handle, into: &mut BTreeSet<String>) {
    if let Ok(font) = handle.load() {
        into.insert(font.full_name());
        if let Some(ps) = font.postscript_name() {
            into.insert(ps);
        }
    }
}

/// Build an inventory.
///
/// Family enumeration is cheap and returned in full. Face names are **not** —
/// loading all 11k fonts to read their name tables takes seconds. So faces are
/// resolved only for the families the caller actually asked about, which is a
/// handful per deck.
///
/// `wanted` is the raw font names from the deck, e.g. `Helvetica Neue Medium`.
pub fn inventory(wanted: &[String]) -> Result<Inventory, String> {
    let source = SystemSource::new();
    let families = source
        .all_families()
        .map_err(|e| format!("Could not list installed font families: {e}"))?;

    let normalized: Vec<(String, &String)> = families.iter().map(|f| (norm(f), f)).collect();
    let mut faces: BTreeSet<String> = BTreeSet::new();

    for want in wanted {
        let want_key = norm(want);

        // A PostScript name is an exact, indexed lookup — try it first.
        if let Ok(handle) = source.select_by_postscript_name(want) {
            push_face_names(&handle, &mut faces);
        }

        // Then any family whose name is a prefix of what was asked for, which
        // is what `Helvetica Neue Medium` -> `Helvetica Neue` looks like.
        for (key, family) in &normalized {
            let prefix_match = want_key == *key
                || (want_key.starts_with(key.as_str())
                    && want_key.as_bytes().get(key.len()) == Some(&b' '));
            if !prefix_match {
                continue;
            }
            if let Ok(fam) = source.select_family_by_name(family) {
                for handle in fam.fonts() {
                    push_face_names(handle, &mut faces);
                }
            }
        }
    }

    Ok(Inventory {
        families,
        faces: faces.into_iter().collect(),
    })
}

/// The per-user font directory. No administrator rights are needed to write here.
pub fn install_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("Could not locate the home directory.")?;
        Ok(home.join("Library").join("Fonts"))
    }
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir().ok_or("Could not locate LOCALAPPDATA.")?;
        Ok(local.join("Microsoft").join("Windows").join("Fonts"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = dirs::data_dir().ok_or("Could not locate the XDG data directory.")?;
        Ok(data.join("fonts"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
    pub filename: String,
    /// Raw font bytes.
    pub data: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub filename: String,
    /// `installed`, `already-present`, or `failed`.
    pub status: String,
    pub detail: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub dir: String,
    pub installed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub outcomes: Vec<InstallOutcome>,
    /// Set when the platform needs the user to do something for fonts to appear.
    pub note: Option<String>,
}

/// True when the bytes begin with a real sfnt signature.
///
/// This is a guard, not a formality: `install_fonts` writes into the user's
/// font directory, and it must never put something there that is not a font.
/// The frontend can pass anything, including a failed download that came back
/// as an HTML error page.
fn is_sfnt(data: &[u8]) -> bool {
    match data.get(..4) {
        Some([0x00, 0x01, 0x00, 0x00]) => true,
        Some(b"OTTO") | Some(b"true") | Some(b"ttcf") => true,
        _ => false,
    }
}

/// Reject anything that is not a plain filename.
///
/// `filename` arrives from the frontend, which got it from a zip part name or
/// a remote URL. Neither is trustworthy enough to join onto a path unchecked —
/// `../../../.zshrc` must not resolve.
fn safe_filename(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Empty filename.".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("Refusing a filename containing a path: {trimmed}"));
    }
    if Path::new(trimmed).file_name().map(|f| f != trimmed).unwrap_or(true) {
        return Err(format!("Refusing an unusable filename: {trimmed}"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.ends_with(".ttf") || lower.ends_with(".otf") || lower.ends_with(".ttc")) {
        return Err(format!("Not a font file extension: {trimmed}"));
    }
    Ok(trimmed)
}

/// Install font files into the per-user font directory.
///
/// Existing files are **skipped, never overwritten** — replacing a font the
/// user already has is not this tool's business, and on Windows an in-use font
/// file cannot be replaced anyway.
pub fn install_fonts(files: Vec<FontFile>) -> Result<InstallReport, String> {
    let dir = install_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let mut report = InstallReport {
        dir: dir.display().to_string(),
        installed: 0,
        skipped: 0,
        failed: 0,
        outcomes: Vec::new(),
        note: None,
    };

    for file in files {
        let name = match safe_filename(&file.filename) {
            Ok(n) => n.to_string(),
            Err(e) => {
                report.failed += 1;
                report.outcomes.push(InstallOutcome {
                    filename: file.filename.clone(),
                    status: "failed".into(),
                    detail: Some(e),
                    path: None,
                });
                continue;
            }
        };

        if !is_sfnt(&file.data) {
            report.failed += 1;
            report.outcomes.push(InstallOutcome {
                filename: name,
                status: "failed".into(),
                detail: Some(
                    "Not a font file — the data does not start with a TrueType or OpenType \
                     signature. A download probably failed and returned an error page."
                        .into(),
                ),
                path: None,
            });
            continue;
        }

        let target = dir.join(&name);
        if target.exists() {
            report.skipped += 1;
            report.outcomes.push(InstallOutcome {
                filename: name,
                status: "already-present".into(),
                detail: None,
                path: Some(target.display().to_string()),
            });
            continue;
        }

        match fs::write(&target, &file.data) {
            Ok(()) => {
                let registered = register_font(&target, &file.data);
                match registered {
                    Ok(()) => {
                        report.installed += 1;
                        report.outcomes.push(InstallOutcome {
                            filename: name,
                            status: "installed".into(),
                            detail: None,
                            path: Some(target.display().to_string()),
                        });
                    }
                    Err(e) => {
                        // The file is on disk but the OS was not told about it.
                        // Remove it rather than leave a font that half exists.
                        let _ = fs::remove_file(&target);
                        report.failed += 1;
                        report.outcomes.push(InstallOutcome {
                            filename: name,
                            status: "failed".into(),
                            detail: Some(e),
                            path: None,
                        });
                    }
                }
            }
            Err(e) => {
                report.failed += 1;
                report.outcomes.push(InstallOutcome {
                    filename: name,
                    status: "failed".into(),
                    detail: Some(e.to_string()),
                    path: None,
                });
            }
        }
    }

    report.note = post_install_note(&report);
    Ok(report)
}

/// Tell the OS about a newly written font file, where that is a separate step.
#[cfg(target_os = "windows")]
fn register_font(path: &Path, data: &[u8]) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    // Copying the file is not enough on Windows. Applications read the font
    // list out of the registry, and a font with no registry value is installed
    // in the sense that it exists and in no other sense — it never appears in
    // any font menu.
    //
    // The value name is the face name plus a type suffix, matching what the
    // shell's own "Install for all users" writes:  "Poppins Regular (TrueType)"
    let face = face_name_for(path, data);
    let suffix = if path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("otf"))
        .unwrap_or(false)
    {
        " (OpenType)"
    } else {
        " (TrueType)"
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey_with_flags(
            r"Software\Microsoft\Windows NT\CurrentVersion\Fonts",
            KEY_WRITE,
        )
        .map_err(|e| format!("Could not open the user font registry key: {e}"))?;

    // User-scope fonts are recorded by full path.
    key.set_value(format!("{face}{suffix}"), &path.display().to_string())
        .map_err(|e| format!("Could not write the font registry value: {e}"))?;

    // Writing the file and the registry value does not make the font usable in
    // this session — the same gap as the CoreText one on macOS, with a
    // different remedy. `AddFontResourceW` registers it now; the WM_FONTCHANGE
    // broadcast tells every running window to rebuild its font list. Windows'
    // own installer does both, and skipping them leaves a font that only
    // appears after the user logs out.
    add_font_resource_and_notify(path);

    Ok(())
}

/// GDI registration plus the WM_FONTCHANGE broadcast.
///
/// Best effort: the file and the registry value are already in place, so a
/// failure here costs the user a logout rather than the font.
#[cfg(target_os = "windows")]
fn add_font_resource_and_notify(path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const HWND_BROADCAST: isize = 0xffff;
    const WM_FONTCHANGE: u32 = 0x001D;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "gdi32")]
    extern "system" {
        fn AddFontResourceW(lpszFilename: *const u16) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call,
    // and `result` is a valid out-pointer. Both functions are documented as
    // safe to call from any thread.
    unsafe {
        AddFontResourceW(wide.as_ptr());
        let mut result: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_FONTCHANGE,
            0,
            0,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

/// Register a font with CoreText so it is usable *now*.
///
/// Dropping a file into `~/Library/Fonts` does work, but the font server picks
/// it up on its own schedule — measured at around ten seconds on an M-series
/// Mac. That is long enough to be a bug rather than a delay: the app installs a
/// font, immediately re-checks what is installed, and truthfully reports the
/// font it just installed as still missing.
///
/// `CTFontManagerRegisterFontsForURL` with user scope makes it visible
/// synchronously and persistently, which removes the race entirely.
///
/// A failure here is not fatal — the file is on disk and the font server will
/// find it eventually — so the error is swallowed rather than rolling the
/// install back. The one case worth reporting is a font already registered
/// from somewhere else, and that is not an error either.
#[cfg(target_os = "macos")]
fn register_font(path: &Path, _data: &[u8]) -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::error::CFErrorRef;
    use core_foundation::url::{CFURL, CFURLRef};

    #[allow(non_upper_case_globals)]
    const kCTFontManagerScopeUser: u32 = 2;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerRegisterFontsForURL(
            fontURL: CFURLRef,
            scope: u32,
            error: *mut CFErrorRef,
        ) -> bool;
    }

    let url = CFURL::from_path(path, false)
        .ok_or_else(|| format!("Could not form a URL for {}", path.display()))?;

    let mut err: CFErrorRef = std::ptr::null_mut();
    // SAFETY: `url` outlives the call, and `err` is a valid out-pointer. The
    // returned CFError, if any, is deliberately not released — it is only
    // consulted for the boolean result and leaking one CFError on a failed
    // font registration is not worth the unsafe block to avoid.
    let ok = unsafe { CTFontManagerRegisterFontsForURL(url.as_concrete_TypeRef(), kCTFontManagerScopeUser, &mut err) };

    if !ok {
        // Already registered, or a duplicate of a system font. The file is
        // installed either way, so this is not worth failing the install over.
        return Ok(());
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn register_font(_path: &Path, _data: &[u8]) -> Result<(), String> {
    // Linux needs the fontconfig cache rebuilt, which is done once at the end
    // of the batch rather than per file — see post_install_note.
    Ok(())
}

/// Best available face name for a font file, for the Windows registry value.
#[cfg(target_os = "windows")]
fn face_name_for(path: &Path, data: &[u8]) -> String {
    use font_kit::font::Font;
    use std::sync::Arc;

    if let Ok(font) = Font::from_bytes(Arc::new(data.to_vec()), 0) {
        let full = font.full_name();
        if !full.trim().is_empty() {
            return full;
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Font".to_string())
}

/// Anything the user still has to do before the fonts show up.
fn post_install_note(report: &InstallReport) -> Option<String> {
    if report.installed == 0 {
        return None;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Rebuild the fontconfig cache once for the whole batch.
        let dir = &report.dir;
        let ok = std::process::Command::new("fc-cache")
            .arg("-f")
            .arg(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return Some(
                "Fonts were installed, but the fontconfig cache could not be rebuilt \
                 (fc-cache not found). Log out and back in to pick them up."
                    .into(),
            );
        }
    }

    Some(
        "Applications that are already open may need restarting before they see the new fonts."
            .into(),
    )
}

/// Read an installed font's file, so it can go into a bundle.
///
/// Returns the bytes and the path. Only reads files that font-kit reported as
/// installed — the frontend cannot ask for an arbitrary path.
pub fn read_installed_font(family: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let source = SystemSource::new();
    let fam = source
        .select_family_by_name(family)
        .map_err(|e| format!("{family} is not installed: {e}"))?;

    let mut out = Vec::new();
    for handle in fam.fonts() {
        match handle {
            Handle::Path { path, .. } => {
                let name = path
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("{family}.ttf"));
                if let Ok(data) = fs::read(path) {
                    out.push((name, data));
                }
            }
            Handle::Memory { bytes, .. } => {
                out.push((format!("{family}.ttf"), bytes.as_ref().clone()));
            }
        }
    }

    if out.is_empty() {
        return Err(format!("No readable font files found for {family}."));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_matches_the_frontend_key() {
        assert_eq!(norm("Helvetica-Neue"), "helvetica neue");
        assert_eq!(norm("  Gill   Sans  "), "gill sans");
        assert_eq!(norm("Times_New_Roman"), "times new roman");
    }

    #[test]
    fn sfnt_guard_accepts_real_signatures() {
        assert!(is_sfnt(&[0x00, 0x01, 0x00, 0x00]));
        assert!(is_sfnt(b"OTTO"));
        assert!(is_sfnt(b"true"));
        assert!(is_sfnt(b"ttcf"));
    }

    #[test]
    fn sfnt_guard_rejects_an_html_error_page() {
        assert!(!is_sfnt(b"<!DOCTYPE html>"));
        assert!(!is_sfnt(b"404:"));
        assert!(!is_sfnt(&[]));
    }

    #[test]
    fn filenames_cannot_escape_the_font_directory() {
        assert!(safe_filename("../../.zshrc").is_err());
        assert!(safe_filename("a/b.ttf").is_err());
        assert!(safe_filename("..\\evil.ttf").is_err());
        assert!(safe_filename("").is_err());
    }

    #[test]
    fn filenames_must_look_like_fonts() {
        assert!(safe_filename("Poppins-Regular.ttf").is_ok());
        assert!(safe_filename("Font.OTF").is_ok());
        assert!(safe_filename("payload.sh").is_err());
        assert!(safe_filename("Poppins-Regular").is_err());
    }

    #[test]
    fn install_dir_is_under_the_home_directory() {
        let dir = install_dir().expect("an install dir on this platform");
        let home = dirs::home_dir().expect("a home directory");
        assert!(dir.starts_with(&home), "{dir:?} should be under {home:?}");
    }
}
