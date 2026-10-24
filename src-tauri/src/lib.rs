mod fonts;
mod video;

pub use fonts::FontFile;
use fonts::{InstallReport, Inventory};
use serde::Serialize;
use tauri::AppHandle;
use video::{Downloaded, Tool, ToolInfo, ToolsReport};

/// Run blocking work off the async runtime's threads — yt-dlp's first start
/// alone takes ten seconds, and a download takes minutes.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// yt-dlp, Deno and ffmpeg: where each is and what version, if anywhere.
#[tauri::command]
async fn video_tools(app: AppHandle) -> Result<ToolsReport, String> {
    blocking(move || video::report(&app)).await
}

/// Download one tool's official release, check it against its published
/// checksum, and install it into this app's own folder.
#[tauri::command]
async fn fetch_video_tool(app: AppHandle, tool: Tool) -> Result<ToolInfo, String> {
    blocking(move || video::fetch(&app, tool)).await
}

/// Download one video with yt-dlp. Progress arrives as `video-progress` events.
#[tauri::command]
async fn download_video(app: AppHandle, job: String, url: String, max_height: u32) -> Result<Downloaded, String> {
    blocking(move || video::download(&app, &job, &url, max_height)).await
}

#[tauri::command]
fn cancel_download(app: AppHandle, job: String) {
    video::cancel(&app, &job)
}

/// A finished download's bytes, as an ArrayBuffer.
#[tauri::command]
async fn read_video(app: AppHandle, job: String) -> Result<tauri::ipc::Response, String> {
    blocking(move || video::read(&app, &job).map(tauri::ipc::Response::new)).await
}

#[tauri::command]
fn discard_video(app: AppHandle, job: String) -> Result<(), String> {
    video::discard(&app, &job)
}

/// Ask where to save, and open a temporary file there. `None` if cancelled.
#[tauri::command]
async fn save_begin(app: AppHandle, suggested: String, filter_name: String, ext: String) -> Result<Option<String>, String> {
    blocking(move || video::save_begin(&app, &suggested, &filter_name, &ext)).await
}

/// One piece of the file, as the raw request body; the save's id in a header.
#[tauri::command]
async fn save_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let token = request
        .headers()
        .get("x-save-token")
        .and_then(|v| v.to_str().ok())
        .ok_or("No save id.")?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes.".into());
    };
    let bytes = bytes.clone();
    blocking(move || video::save_chunk(&app, &token, &bytes)).await
}

/// Put the finished file in place. Returns where it went.
#[tauri::command]
async fn save_finish(app: AppHandle, token: String) -> Result<String, String> {
    blocking(move || video::save_finish(&app, &token)).await
}

#[tauri::command]
fn save_abort(app: AppHandle, token: String) {
    video::save_abort(&app, &token)
}

/// Debug builds only: the deck `PFM_DEBUG_OPEN` names, for an end-to-end run
/// that cannot click through the Open panel. Always `None` in a release build.
#[tauri::command]
async fn debug_open_deck() -> Result<Option<(String, Vec<u8>)>, String> {
    blocking(video::debug_open).await
}

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
    /// Absolute path, or `None` for a face with no file of its own.
    ///
    /// The frontend needs this to decide whether the file may be copied at
    /// all: a face Creative Cloud syncs lives under CoreSync rather than in
    /// the font directory, and its licence does not permit handing it to
    /// another machine. See `src/platform/adobe-sync.ts`.
    path: Option<String>,
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
        .map(|f| LocalFontFile {
            filename: f.filename,
            size: f.data.len(),
            path: f.path,
        })
        .collect())
}

/// Raw bytes of one file backing an installed family, as an ArrayBuffer.
#[tauri::command]
fn read_installed_font_file(family: String, index: usize) -> Result<tauri::ipc::Response, String> {
    let files = fonts::read_installed_font(&family)?;
    let file = files
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("No file at index {index} for {family}."))?;
    Ok(tauri::ipc::Response::new(file.data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoState::default())
        .setup(|app| {
            video::clean_jobs(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            font_inventory,
            font_install_dir,
            install_fonts,
            list_installed_font_files,
            read_installed_font_file,
            video_tools,
            fetch_video_tool,
            download_video,
            cancel_download,
            read_video,
            discard_video,
            save_begin,
            save_chunk,
            save_finish,
            save_abort,
            debug_open_deck,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Exposed for `examples/probe.rs` — a manual check that native enumeration
/// agrees with the platform's own font list. Not part of the app's IPC surface.
pub fn probe_inventory(wanted: &[String]) -> Result<Inventory, String> {
    fonts::inventory(wanted)
}

// For examples/fetch_probe.rs — fetches each video tool into a folder of your
// choosing and runs it. Not part of the app's IPC surface.
pub use video::{fetch_to as probe_fetch_tool, Tool as VideoTool};
// For examples/download_probe.rs — the app's own yt-dlp run, without the app.
pub use video::{find_tools as probe_find_video_tools, run_ytdlp as probe_run_ytdlp};

// Re-exports for examples/install_probe.rs — a manual end-to-end check of the
// install path against a real font file. Not part of the app's IPC surface.
pub use fonts::install_fonts as probe_install;
pub fn probe_install_dir() -> Result<String, String> {
    fonts::install_dir().map(|p| p.display().to_string())
}
