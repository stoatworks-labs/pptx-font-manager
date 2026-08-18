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

/// Where one installed face's file actually lives.
///
/// Reported so the frontend can tell an OS-bundled font from one Creative
/// Cloud syncs into its own directory. That distinction is the whole reason
/// this exists: an Adobe-synced face registers with the OS like any other, so
/// "installed" on the authoring machine says nothing about the venue. The rule
/// that reads these paths lives in `src/platform/adobe-sync.ts` — this side
/// reports the fact and does not interpret it, so there is only ever one
/// definition of what a synced path looks like.
#[derive(Serialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct FamilyFile {
    pub family: String,
    pub path: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    /// Every installed family name.
    pub families: Vec<String>,
    /// Full and PostScript names, for the families relevant to the request.
    pub faces: Vec<String>,
    /// Where those families' files are — plus everything Creative Cloud has
    /// synced onto this machine, asked about or not.
    ///
    /// Scoped to the request for the same reason faces are: this machine has
    /// 11,630 font files and the deck asked about five of them. The sync store
    /// is included whole because it is small and because it is the one place
    /// whose contents are interesting regardless of what the deck says.
    pub family_files: Vec<FamilyFile>,
}

/// Load a handle and collect its face names, ignoring anything unreadable.
///
/// A handful of system fonts fail to load — datafork suitcases, fonts the
/// process has no read permission for. One bad face must not take out the
/// whole inventory, so failures are dropped silently.
///
/// Returns the family name read from the file, for the one caller that has a
/// handle without knowing which family produced it.
fn push_face_names(handle: &Handle, into: &mut BTreeSet<String>) -> Option<String> {
    let font = handle.load().ok()?;
    into.insert(font.full_name());
    if let Some(ps) = font.postscript_name() {
        into.insert(ps);
    }
    Some(font.family_name())
}

/// The file a handle points at, when it points at one.
///
/// `Handle::Memory` faces have no path — font-kit materialised the bytes — so
/// they are simply absent rather than reported with a made-up location.
fn handle_path(handle: &Handle) -> Option<String> {
    match handle {
        Handle::Path { path, .. } => Some(path.display().to_string()),
        Handle::Memory { .. } => None,
    }
}

/// Where a family's files actually live.
///
/// **font-kit cannot answer this on macOS.** Its CoreText source returns
/// `Handle::Memory` for every installed face — measured here, all 69 faces of
/// Arial, Gill Sans and Helvetica Neue — so `handle_path` finds nothing and the
/// synced-font check would silently never fire. CoreText itself does know: the
/// font descriptor carries a URL, which is how Creative Cloud registers its
/// faces in the first place.
#[cfg(target_os = "macos")]
fn family_file_paths(family: &str) -> Vec<PathBuf> {
    let Some(collection) = core_text::font_collection::create_for_family(family) else {
        return Vec::new();
    };
    let Some(descriptors) = collection.get_descriptors() else {
        return Vec::new();
    };

    let mut out: Vec<PathBuf> = Vec::new();
    for descriptor in descriptors.iter() {
        if let Some(path) = descriptor.font_path() {
            // Faces of one family routinely share a .ttc, so the same file
            // comes back many times over.
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// Not needed off macOS: font-kit's DirectWrite and fontconfig sources both
/// build `Handle::Path`, so the paths already arrive with the handles.
#[cfg(not(target_os = "macos"))]
fn family_file_paths(_family: &str) -> Vec<PathBuf> {
    Vec::new()
}

/// The directories Creative Cloud syncs desktop faces into.
///
///     macOS    ~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r
///     Windows  %APPDATA%\Adobe\CoreSync\plugins\livetype\r
///
/// Both leaf spellings are tried on both platforms. The dot is the documented
/// difference between them, and it is not worth a wrong answer if Adobe ever
/// swaps one for the other.
///
/// This is the one place in the Rust side that knows what the sync store is.
/// It *locates* the store; deciding whether a given path is inside one is the
/// frontend's rule, in `src/platform/adobe-sync.ts`. Keep the two in step.
fn adobe_sync_dirs() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library").join("Application Support"));
    }
    #[cfg(target_os = "windows")]
    if let Some(appdata) = dirs::config_dir() {
        // dirs::config_dir() is %APPDATA% (Roaming) on Windows.
        roots.push(appdata);
    }

    let mut dirs_out = Vec::new();
    for root in roots {
        let livetype = root
            .join("Adobe")
            .join("CoreSync")
            .join("plugins")
            .join("livetype");
        for leaf in [".r", "r"] {
            let dir = livetype.join(leaf);
            if dir.is_dir() {
                dirs_out.push(dir);
            }
        }
    }
    dirs_out
}

/// Every font Creative Cloud has synced onto this machine, by family.
///
/// Read straight from the store rather than inferred from the OS font list,
/// for two reasons. The filenames in there are deliberately obfuscated —
/// `2ZQVDGB`, no extension — so the family name has to come out of the file's
/// own name table. And this keeps working on a platform whose font API declines
/// to say where a face lives, which is exactly what macOS does.
///
/// Cost is proportional to how many fonts the user has activated, not to how
/// many are installed: an empty store costs one `read_dir`.
fn adobe_sync_store() -> Vec<FamilyFile> {
    use font_kit::font::Font;

    let mut out = Vec::new();
    for dir in adobe_sync_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Anything that is not a font — .DS_Store, Adobe's own bookkeeping
            // files — simply fails to parse and is skipped.
            if let Ok(font) = Font::from_path(&path, 0) {
                out.push(FamilyFile {
                    family: font.family_name(),
                    path: path.display().to_string(),
                });
            }
        }
    }
    out
}

/// Build an inventory.
///
/// Family enumeration is cheap and returned in full. Face names are **not** —
/// loading all 11k fonts to read their name tables takes seconds. So faces are
/// resolved only for the families the caller actually asked about, which is a
/// handful per deck. File paths follow the same rule, and cost about the same:
/// measured at 199 ms for 2,232 families and 69 faces, unchanged by adding them.
///
/// `wanted` is the raw font names from the deck, e.g. `Helvetica Neue Medium`.
pub fn inventory(wanted: &[String]) -> Result<Inventory, String> {
    let source = SystemSource::new();
    let families = source
        .all_families()
        .map_err(|e| format!("Could not list installed font families: {e}"))?;

    let normalized: Vec<(String, &String)> = families.iter().map(|f| (norm(f), f)).collect();
    let mut faces: BTreeSet<String> = BTreeSet::new();
    let mut family_files: BTreeSet<FamilyFile> = BTreeSet::new();
    // Families the request actually reached, so their files can be located
    // afterwards in one pass rather than per matching rule.
    let mut matched: BTreeSet<String> = BTreeSet::new();

    for want in wanted {
        let want_key = norm(want);

        // A PostScript name is an exact, indexed lookup — try it first.
        if let Ok(handle) = source.select_by_postscript_name(want) {
            // This branch carries the Adobe case on its own. A synced face is
            // often written into a deck by its PostScript name
            // (`ProximaNova-Regular`), which no family-prefix match reaches.
            if let Some(family) = push_face_names(&handle, &mut faces) {
                if let Some(path) = handle_path(&handle) {
                    family_files.insert(FamilyFile {
                        family: family.clone(),
                        path,
                    });
                }
                matched.insert(family);
            }
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
                    let _ = push_face_names(handle, &mut faces);
                    if let Some(path) = handle_path(handle) {
                        // The enumerated family name, not the one inside the
                        // file: this is the string the frontend matched
                        // against, so it is the string it can look up.
                        family_files.insert(FamilyFile {
                            family: (*family).clone(),
                            path,
                        });
                    }
                }
                matched.insert((*family).clone());
            }
        }
    }

    // Where those families live, for the platforms whose handles do not say.
    for family in &matched {
        for path in family_file_paths(family) {
            family_files.insert(FamilyFile {
                family: family.clone(),
                path: path.display().to_string(),
            });
        }
    }

    // And what Creative Cloud has synced here, whether or not the deck asked
    // for it. This is the half that does not depend on the OS font API
    // reporting a location at all — it reads the store itself.
    for file in adobe_sync_store() {
        family_files.insert(file);
    }

    Ok(Inventory {
        families,
        faces: faces.into_iter().collect(),
        family_files: family_files.into_iter().collect(),
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

/// One file backing an installed family.
pub struct InstalledFont {
    pub filename: String,
    /// Absolute path on disk. `None` for a face font-kit materialised in
    /// memory, which has no single file to name.
    ///
    /// Carried through to the frontend because where a font file lives is
    /// evidence about where it came from — a face under the Creative Cloud
    /// CoreSync directory is one the licence forbids putting in a bundle,
    /// however ordinary it looks in the font menu.
    pub path: Option<String>,
    pub data: Vec<u8>,
}

/// Read an installed font's file, so it can go into a bundle.
///
/// Returns the bytes and the path. Only reads files the platform itself
/// reported for this family — the frontend cannot ask for an arbitrary path.
///
/// The path matters as much as the bytes here: a face Creative Cloud syncs may
/// not be copied to another machine, and it is indistinguishable from an
/// ordinary installed font by any other means. So the platform's own locations
/// are used where they exist, and the font-kit handles are the fallback for
/// faces it will not place — on macOS that fallback also loses the real
/// filename, since a `Handle::Memory` face has none.
pub fn read_installed_font(family: &str) -> Result<Vec<InstalledFont>, String> {
    let mut out = Vec::new();
    for path in family_file_paths(family) {
        let filename = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{family}.ttf"));
        if let Ok(data) = fs::read(&path) {
            out.push(InstalledFont {
                filename,
                path: Some(path.display().to_string()),
                data,
            });
        }
    }
    if !out.is_empty() {
        return Ok(out);
    }

    let source = SystemSource::new();
    let fam = source
        .select_family_by_name(family)
        .map_err(|e| format!("{family} is not installed: {e}"))?;

    // `out` is still empty here — the early return above covered the other case.
    for handle in fam.fonts() {
        match handle {
            Handle::Path { path, .. } => {
                let name = path
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("{family}.ttf"));
                if let Ok(data) = fs::read(path) {
                    out.push(InstalledFont {
                        filename: name,
                        path: Some(path.display().to_string()),
                        data,
                    });
                }
            }
            Handle::Memory { bytes, .. } => {
                out.push(InstalledFont {
                    filename: format!("{family}.ttf"),
                    path: None,
                    data: bytes.as_ref().clone(),
                });
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

    /// The store is *located*, never guessed at: a directory that is not there
    /// is simply not returned, so an empty result means "nothing synced" and
    /// never "look somewhere plausible".
    ///
    /// On the machine this was written on the macOS store exists and is empty —
    /// nothing is activated in Creative Cloud — so this asserts the shape of
    /// the path rather than that anything was found. A positive result needs a
    /// font activated in Creative Cloud first.
    #[test]
    fn sync_dirs_are_real_directories_under_the_documented_path() {
        for dir in adobe_sync_dirs() {
            assert!(dir.is_dir(), "{dir:?} was returned but does not exist");
            let path = dir.to_string_lossy().to_lowercase();
            assert!(
                path.contains("adobe") && path.contains("coresync") && path.contains("livetype"),
                "{dir:?} is not the CoreSync store",
            );
        }
    }

    /// Whatever is in the store, every entry must carry a family name read from
    /// the file and the path it came from — the frontend matches on the first
    /// and classifies on the second.
    #[test]
    fn sync_store_entries_are_named_and_located() {
        for file in adobe_sync_store() {
            assert!(!file.family.trim().is_empty(), "a synced file with no family name");
            assert!(Path::new(&file.path).is_file(), "{} is not a file", file.path);
        }
    }

    #[test]
    fn install_dir_is_under_the_home_directory() {
        let dir = install_dir().expect("an install dir on this platform");
        let home = dirs::home_dir().expect("a home directory");
        assert!(dir.starts_with(&home), "{dir:?} should be under {home:?}");
    }
}

