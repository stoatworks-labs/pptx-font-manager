mod fonts;

pub use fonts::FontFile;
use fonts::{InstallReport, Inventory};
use serde::Serialize;

/// Installed families, plus face names for the families the deck asked about.
#[tauri::command]
fn font_inventory(wanted: Vec<String>) -> Result<Inventory, String> {
    fonts::inventory(&wanted)
}

/// Where fonts will be written. Shown in the UI before anything is installed,
/// so the user knows what is about to be touched.
#[tauri::command]
fn font_install_dir() -> Result<String, String> {
    fonts::install_dir().map(|p| p.display().to_string())
}

/// Install font files into the per-user font directory.
///
/// Existing files are skipped, never overwritten, and anything that is not a
/// real sfnt is rejected before it reaches the directory.
#[tauri::command]
fn install_fonts(files: Vec<FontFile>) -> Result<InstallReport, String> {
    fonts::install_fonts(files)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFontFile {
    filename: String,
    size: usize,
}

/// List the files backing an installed family, without transferring them.
///
/// Paired with `read_installed_font_file`: the frontend gets the list first and
/// pulls the bytes one at a time, because a JSON array of 160,000 numbers per
/// font is a poor way to move a file across the IPC boundary.
#[tauri::command]
fn list_installed_font_files(family: String) -> Result<Vec<LocalFontFile>, String> {
    Ok(fonts::read_installed_font(&family)?
        .into_iter()
        .map(|(filename, data)| LocalFontFile {
            filename,
            size: data.len(),
        })
        .collect())
}

/// Raw bytes of one file backing an installed family, as an ArrayBuffer.
#[tauri::command]
fn read_installed_font_file(family: String, index: usize) -> Result<tauri::ipc::Response, String> {
    let files = fonts::read_installed_font(&family)?;
    let (_, data) = files
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("No file at index {index} for {family}."))?;
    Ok(tauri::ipc::Response::new(data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            font_inventory,
            font_install_dir,
            install_fonts,
            list_installed_font_files,
            read_installed_font_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Exposed for `examples/probe.rs` — a manual check that native enumeration
/// agrees with the platform's own font list. Not part of the app's IPC surface.
pub fn probe_inventory(wanted: &[String]) -> Result<Inventory, String> {
    fonts::inventory(wanted)
}

// Re-exports for examples/install_probe.rs — a manual end-to-end check of the
// install path against a real font file. Not part of the app's IPC surface.
pub use fonts::install_fonts as probe_install;
pub fn probe_install_dir() -> Result<String, String> {
    fonts::install_dir().map(|p| p.display().to_string())
}
