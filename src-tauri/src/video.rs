//! Online video: finding yt-dlp and its helpers, fetching them, running a
//! download, and writing a large file the user picked a place for.
//!
//! The deck itself is rewritten in TypeScript (`src/core/localvideo.ts`); this
//! side only does what a web view cannot — run a program and write a file.
//!
//! ## Three tools, and why all three
//!
//! Measured against YouTube on 2026-10-24 with yt-dlp 2026.10.21:
//!
//! | yt-dlp with      | What comes back                                 |
//! | ---------------- | ----------------------------------------------- |
//! | nothing          | separate video and audio streams only — nothing PowerPoint can play |
//! | Deno             | one combined 360p file (format 18)              |
//! | ffmpeg           | H.264 up to 1080p plus AAC, joined by ffmpeg; yt-dlp warns that YouTube without a JS runtime is deprecated |
//! | Deno and ffmpeg  | the same, without the warning                   |
//!
//! So ffmpeg is what makes a usable file and Deno is what keeps it working.
//!
//! ## Where they come from
//!
//! First this app's own copies (`<app data>/tools`), then `PATH`, then the
//! places package managers put things. A Finder-launched app gets a bare
//! `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew's `/opt/homebrew/bin`
//! has to be asked for by name — and yt-dlp, run from here, cannot find
//! ffmpeg or Deno on its own for the same reason. They are passed to it by
//! path.
//!
//! Fetching downloads each tool's official release and checks it against the
//! checksum its publisher posts beside it, with curl (shipped with macOS,
//! Windows 10 1803+ and practically every Linux), so no HTTP stack is linked
//! in. A copy this app fetched is the only one it will replace: Homebrew's
//! belongs to Homebrew.
//!
//! None of this is bundled. yt-dlp goes stale in weeks, and a binary inside a
//! signed .app could not update itself without breaking the signature.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Tool {
    YtDlp,
    Deno,
    Ffmpeg,
}

impl Tool {
    pub const ALL: [Tool; 3] = [Tool::YtDlp, Tool::Deno, Tool::Ffmpeg];

    fn stem(self) -> &'static str {
        match self {
            Tool::YtDlp => "yt-dlp",
            Tool::Deno => "deno",
            Tool::Ffmpeg => "ffmpeg",
        }
    }

    fn exe(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.stem())
        } else {
            self.stem().to_string()
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub tool: Tool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// This app's own copy, which it may replace. Anything else is the user's.
    pub managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsReport {
    pub tools: Vec<ToolInfo>,
    pub managed_dir: String,
    /// Whether this platform has a known release to fetch for every tool.
    pub can_fetch: bool,
}

// ---------------------------------------------------------------------------
// Finding

pub fn managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))?
        .join("tools");
    Ok(dir)
}

fn search_dirs(managed: &Path) -> Vec<PathBuf> {
    let mut out = vec![managed.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        out.extend(std::env::split_paths(&path));
    }
    let home = dirs::home_dir();
    #[cfg(not(windows))]
    {
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] {
            out.push(PathBuf::from(d));
        }
        if let Some(h) = &home {
            out.push(h.join(".local/bin"));
            out.push(h.join(".deno/bin"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(h) = &home {
            out.push(h.join(".deno").join("bin"));
            out.push(h.join("scoop").join("shims"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|d| seen.insert(d.clone()));
    out
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn find(tool: Tool, managed: &Path) -> Option<(PathBuf, bool)> {
    for dir in search_dirs(managed) {
        let candidate = dir.join(tool.exe());
        if is_executable(&candidate) {
            return Some((candidate, dir == managed));
        }
    }
    None
}

/// A command that does not flash a console window on Windows.
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run a short command and return its stdout, or `None` on failure or timeout.
fn capture(program: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The tool's version, which doubles as proof that it runs at all.
///
/// yt-dlp's standalone build unpacks itself on every start; the first run on
/// a Mac takes about ten seconds, hence the generous timeout.
pub fn version(tool: Tool, path: &Path) -> Option<String> {
    let arg = if tool == Tool::Ffmpeg { "-version" } else { "--version" };
    let out = capture(path, &[arg], Duration::from_secs(90))?;
    let first = out.lines().next()?.trim();
    let v = match tool {
        Tool::YtDlp => first.to_string(),
        // "deno 2.9.8 (stable, release, aarch64-apple-darwin)"
        Tool::Deno => first.split_whitespace().nth(1)?.to_string(),
        // "ffmpeg version 9.0.2-https://www.martin-riedl.de Copyright (c) …"
        Tool::Ffmpeg => {
            let v = first.split_whitespace().nth(2)?;
            v.split("-http").next().unwrap_or(v).to_string()
        }
    };
    (!v.is_empty()).then_some(v)
}

pub fn report(app: &AppHandle) -> Result<ToolsReport, String> {
    let managed = managed_dir(app)?;
    let tools = Tool::ALL
        .iter()
        .map(|&tool| match find(tool, &managed) {
            Some((path, is_managed)) => ToolInfo {
                tool,
                version: version(tool, &path),
                path: Some(path.display().to_string()),
                managed: is_managed,
            },
            None => ToolInfo { tool, path: None, version: None, managed: false },
        })
        .collect();
    Ok(ToolsReport {
        tools,
        managed_dir: managed.display().to_string(),
        can_fetch: Tool::ALL.iter().all(|&t| plan(t).is_ok()),
    })
}

// ---------------------------------------------------------------------------
// Fetching

enum Pack {
    /// The asset is the program.
    Bare,
    /// A zip holding the program at a path ending in `member`.
    Zip(&'static str),
    /// A .tar.xz holding the program at a path ending in `member`.
    TarXz(&'static str),
}

struct Plan {
    /// Where to get it. For `redirect`, a URL that answers with a 307 to it.
    url: String,
    /// The asset's file name, as the checksum list spells it.
    asset: String,
    /// Where its SHA-256 is published. `None` means `<resolved url>.sha256`.
    sums: Option<String>,
    redirect: bool,
    pack: Pack,
}

const YTDLP: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const DENO: &str = "https://github.com/denoland/deno/releases/latest/download/";
const FFMPEG_BUILDS: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/";
/// Martin Riedl's static macOS builds: signed, GPL, with libx264. yt-dlp's own
/// FFmpeg builds cover Windows and Linux but not the Mac.
const FFMPEG_MAC: &str = "https://ffmpeg.martin-riedl.de/";

fn plan(tool: Tool) -> Result<Plan, String> {
    use std::env::consts::{ARCH, OS};
    let unsupported = || Err(format!("No {} release is known for {OS} on {ARCH}.", tool.stem()));
    let arm = ARCH == "aarch64";
    if !matches!(ARCH, "aarch64" | "x86_64") {
        return unsupported();
    }
    Ok(match tool {
        Tool::YtDlp => {
            let asset = match (OS, arm) {
                ("macos", _) => "yt-dlp_macos",
                ("windows", false) => "yt-dlp.exe",
                ("windows", true) => "yt-dlp_arm64.exe",
                ("linux", false) => "yt-dlp_linux",
                ("linux", true) => "yt-dlp_linux_aarch64",
                _ => return unsupported(),
            };
            Plan {
                url: format!("{YTDLP}{asset}"),
                asset: asset.into(),
                sums: Some(format!("{YTDLP}SHA2-256SUMS")),
                redirect: false,
                pack: Pack::Bare,
            }
        }
        Tool::Deno => {
            let triple = match (OS, arm) {
                ("macos", true) => "aarch64-apple-darwin",
                ("macos", false) => "x86_64-apple-darwin",
                ("windows", true) => "aarch64-pc-windows-msvc",
                ("windows", false) => "x86_64-pc-windows-msvc",
                ("linux", true) => "aarch64-unknown-linux-gnu",
                ("linux", false) => "x86_64-unknown-linux-gnu",
                _ => return unsupported(),
            };
            let asset = format!("deno-{triple}.zip");
            Plan {
                url: format!("{DENO}{asset}"),
                sums: Some(format!("{DENO}{asset}.sha256sum")),
                asset,
                redirect: false,
                pack: Pack::Zip(if cfg!(windows) { "deno.exe" } else { "deno" }),
            }
        }
        Tool::Ffmpeg => match OS {
            "macos" => Plan {
                url: format!(
                    "{FFMPEG_MAC}redirect/latest/macos/{}/release/ffmpeg.zip",
                    if arm { "arm64" } else { "amd64" }
                ),
                asset: "ffmpeg.zip".into(),
                sums: None,
                redirect: true,
                pack: Pack::Zip("ffmpeg"),
            },
            "windows" => {
                let asset = format!("ffmpeg-master-latest-{}-gpl.zip", if arm { "winarm64" } else { "win64" });
                Plan {
                    url: format!("{FFMPEG_BUILDS}{asset}"),
                    asset,
                    sums: Some(format!("{FFMPEG_BUILDS}checksums.sha256")),
                    redirect: false,
                    pack: Pack::Zip("bin/ffmpeg.exe"),
                }
            }
            "linux" => {
                let asset = format!("ffmpeg-master-latest-{}-gpl.tar.xz", if arm { "linuxarm64" } else { "linux64" });
                Plan {
                    url: format!("{FFMPEG_BUILDS}{asset}"),
                    asset,
                    sums: Some(format!("{FFMPEG_BUILDS}checksums.sha256")),
                    redirect: false,
                    pack: Pack::TarXz("bin/ffmpeg"),
                }
            }
            _ => return unsupported(),
        },
    })
}

fn curl_program() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else if cfg!(target_os = "macos") {
        "/usr/bin/curl"
    } else {
        "curl"
    }
}

fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = command(curl_program())
        .args(["-sS", "--proto", "=https", "--tlsv1.2", "--connect-timeout", "30"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not run curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Download failed: {}", err.trim()));
    }
    Ok(out.stdout)
}

fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    let dest = dest.to_str().ok_or("Unusable download path.")?;
    curl(&["-fL", "--retry", "2", "--max-time", "1800", "-o", dest, url]).map(|_| ())
}

fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The hash for `asset` in a `sha256sum`-style list (`<hash>  [*]<name>`).
pub fn expected_hash(sums: &str, asset: &str) -> Option<String> {
    let lines: Vec<&str> = sums.lines().filter(|l| !l.trim().is_empty()).collect();
    for line in &lines {
        let mut parts = line.split_whitespace();
        let (Some(hash), name) = (parts.next(), parts.next()) else { continue };
        let named = name.map(|n| n.trim_start_matches('*'));
        let hash_ok = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        if hash_ok && (named == Some(asset) || (named.is_none() && lines.len() == 1)) {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

/// Download, verify and install one tool into the managed folder.
pub fn fetch(app: &AppHandle, tool: Tool) -> Result<ToolInfo, String> {
    fetch_to(tool, &managed_dir(app)?)
}

/// `fetch`, into any folder — also what `examples/fetch_probe.rs` runs.
pub fn fetch_to(tool: Tool, managed: &Path) -> Result<ToolInfo, String> {
    let p = plan(tool)?;
    let work = managed.join(format!(".fetch-{}", tool.stem()));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| format!("Could not create {}: {e}", work.display()))?;
    let result = fetch_into(tool, &p, managed, &work);
    let _ = fs::remove_dir_all(&work);
    result
}

fn fetch_into(tool: Tool, p: &Plan, managed: &Path, work: &Path) -> Result<ToolInfo, String> {
    let url = if p.redirect {
        // The 307 is followed by hand so the checksum can be fetched from
        // beside the file it actually resolved to.
        let to = String::from_utf8_lossy(&curl(&["-o", null_device(), "-w", "%{redirect_url}", &p.url])?).trim().to_string();
        if !to.starts_with(FFMPEG_MAC) {
            return Err(format!("Unexpected download location for {}: {to}", tool.stem()));
        }
        to
    } else {
        p.url.clone()
    };
    let sums_url = p.sums.clone().unwrap_or_else(|| format!("{url}.sha256"));
    let sums = String::from_utf8_lossy(&curl(&["-fL", "--max-time", "60", &sums_url])?).to_string();
    let want = expected_hash(&sums, &p.asset)
        .ok_or_else(|| format!("No checksum for {} in {sums_url}.", p.asset))?;

    let archive = work.join(&p.asset);
    download_to(&url, &archive)?;
    let got = sha256_file(&archive)?;
    if got != want {
        return Err(format!(
            "{} did not match its published checksum (expected {want}, got {got}). Nothing was installed.",
            p.asset
        ));
    }

    let program = match p.pack {
        Pack::Bare => archive,
        Pack::Zip(member) => unzip_member(&archive, member, work)?,
        Pack::TarXz(member) => untar_member(&archive, member, work)?,
    };

    fs::create_dir_all(managed).map_err(|e| e.to_string())?;
    let dest = managed.join(tool.exe());
    let staged = managed.join(format!(".{}.new", tool.exe()));
    fs::copy(&program, &staged).map_err(|e| format!("Could not stage {}: {e}", tool.stem()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    // Refuse anything that does not run, rather than replace a working copy.
    let Some(v) = version(tool, &staged) else {
        let _ = fs::remove_file(&staged);
        return Err(format!("The downloaded {} would not run here. Nothing was installed.", tool.stem()));
    };
    if cfg!(windows) && dest.exists() {
        fs::remove_file(&dest).map_err(|e| format!("Could not replace {}: {e}", dest.display()))?;
    }
    fs::rename(&staged, &dest).map_err(|e| format!("Could not install {}: {e}", tool.stem()))?;
    Ok(ToolInfo { tool, path: Some(dest.display().to_string()), version: Some(v), managed: true })
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn unzip_member(archive: &Path, member: &str, work: &Path) -> Result<PathBuf, String> {
    let f = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Not a zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name == member || name.ends_with(&format!("/{member}")) {
            let out = work.join(Path::new(member).file_name().unwrap_or_default());
            let mut w = File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
            return Ok(out);
        }
    }
    Err(format!("{} has no {member} in it.", archive.display()))
}

fn untar_member(archive: &Path, member: &str, work: &Path) -> Result<PathBuf, String> {
    let into = work.join("x");
    fs::create_dir_all(&into).map_err(|e| e.to_string())?;
    let status = command("tar")
        .arg("-xJf")
        .arg(archive)
        .arg("-C")
        .arg(&into)
        .status()
        .map_err(|e| format!("Could not run tar: {e}"))?;
    if !status.success() {
        return Err(format!("Could not unpack {}.", archive.display()));
    }
    fn walk(dir: &Path, member: &str) -> Option<PathBuf> {
        for e in fs::read_dir(dir).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(hit) = walk(&p, member) {
                    return Some(hit);
                }
            } else if p.to_string_lossy().replace('\\', "/").ends_with(&format!("/{member}")) {
                return Some(p);
            }
        }
        None
    }
    walk(&into, member).ok_or_else(|| format!("{} has no {member} in it.", archive.display()))
}

// ---------------------------------------------------------------------------
// Downloading a video

#[derive(Default)]
pub struct VideoState {
    running: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    finished: Mutex<HashMap<String, PathBuf>>,
    saves: Mutex<HashMap<String, SaveJob>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    /// yt-dlp's format id for the stream in flight, and whether it is sound.
    pub format: Option<String>,
    pub audio: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job: String,
    #[serde(flatten)]
    progress: Progress,
}

/// The three programs a download runs, wherever each was found.
pub struct Tools {
    pub ytdlp: PathBuf,
    pub ffmpeg: Option<PathBuf>,
    pub deno: Option<PathBuf>,
}

pub fn find_tools(managed: &Path) -> Result<Tools, String> {
    Ok(Tools {
        ytdlp: find(Tool::YtDlp, managed).ok_or("yt-dlp is not installed.")?.0,
        ffmpeg: find(Tool::Ffmpeg, managed).map(|f| f.0),
        deno: find(Tool::Deno, managed).map(|f| f.0),
    })
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    #[serde(default)]
    pub job: String,
    #[serde(default)]
    pub size: u64,
    pub filepath: Option<String>,
    pub title: Option<String>,
    pub id: Option<String>,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub ext: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

fn jobs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No cache folder: {e}"))?
        .join("video-jobs"))
}

fn job_dir(app: &AppHandle, job: &str) -> Result<PathBuf, String> {
    if job.is_empty() || job.len() > 64 || !job.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Bad job id.".into());
    }
    Ok(jobs_dir(app)?.join(job))
}

/// Leftovers from a run that ended mid-download.
pub fn clean_jobs(app: &AppHandle) {
    if let Ok(dir) = jobs_dir(app) {
        let _ = fs::remove_dir_all(dir);
    }
}

/// The yt-dlp format selection: H.264 and AAC in MP4, which both PowerPoints
/// play, no taller than `max_height`. YouTube offers H.264 only up to 1080p;
/// above that it is VP9 and AV1, which PowerPoint for Mac cannot decode.
///
/// Stereo sound first. YouTube's "best" AAC for some videos is 5.1 (format
/// 258), which a laptop then downmixes into a venue's stereo PA on its own
/// terms; the stereo track (140) is the one the video was mixed for.
pub fn format_selector(max_height: u32, have_ffmpeg: bool) -> String {
    let h = max_height;
    if have_ffmpeg {
        format!(
            "bv*[vcodec^=avc1][height<={h}]+ba[acodec^=mp4a][audio_channels<=2]/bv*[vcodec^=avc1][height<={h}]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<={h}]/bv*[height<={h}]+ba/b[height<={h}]/b"
        )
    } else {
        // Without ffmpeg nothing can join two streams: one file or nothing.
        format!("b[vcodec^=avc1][acodec^=mp4a][height<={h}]/b[ext=mp4][height<={h}]/b[ext=mp4]")
    }
}

/// yt-dlp learned `--js-runtimes` in 2025.11.12. Versions are dates, so they
/// compare as strings.
fn takes_js_runtimes(ytdlp_version: Option<&str>) -> bool {
    ytdlp_version.is_some_and(|v| v.get(..10).unwrap_or(v) >= "2025.11.12")
}

/// Download one video for the app: a job folder in the cache, progress as
/// `video-progress` events, and a handle `cancel` can kill.
pub fn download(app: &AppHandle, job: &str, url: &str, max_height: u32) -> Result<Downloaded, String> {
    let tools = find_tools(&managed_dir(app)?)?;
    let dir = job_dir(app, job)?;
    let state = app.state::<VideoState>();
    let spawned = std::cell::Cell::new(false);
    let result = run_ytdlp(
        &tools,
        &dir,
        url,
        max_height,
        |child| {
            spawned.set(true);
            state.running.lock().unwrap().insert(job.to_string(), child);
        },
        |progress| {
            let _ = app.emit("video-progress", ProgressEvent { job: job.to_string(), progress });
        },
    );
    // `cancel` takes the handle out; finding it gone means the user stopped it.
    let cancelled = spawned.get() && state.running.lock().unwrap().remove(job).is_none();
    match result {
        Ok(mut r) if !cancelled => {
            r.job = job.to_string();
            let path = PathBuf::from(r.filepath.clone().unwrap_or_default());
            state.finished.lock().unwrap().insert(job.to_string(), path);
            Ok(r)
        }
        other => {
            let _ = fs::remove_dir_all(&dir);
            Err(if cancelled { "Cancelled.".into() } else { other.err().unwrap_or_default() })
        }
    }
}

/// Run yt-dlp for one URL into `dir`, which it empties first.
///
/// `on_spawn` gets the running process, for cancelling; `on_progress` gets
/// every progress line. The result's `filepath` is the finished file, checked
/// to be inside `dir`. Also what `examples/download_probe.rs` runs.
pub fn run_ytdlp(
    tools: &Tools,
    dir: &Path,
    url: &str,
    max_height: u32,
    on_spawn: impl FnOnce(Arc<Mutex<Child>>),
    mut on_progress: impl FnMut(Progress),
) -> Result<Downloaded, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web addresses can be downloaded.".into());
    }
    let Tools { ytdlp, ffmpeg, deno } = tools;
    let ytdlp_version = version(Tool::YtDlp, ytdlp);

    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let mut warnings = Vec::new();
    let mut cmd = command(ytdlp);
    cmd.args(["--ignore-config", "--no-playlist", "--no-mtime", "--newline", "--progress"])
        .args([
            "--progress-template",
            "download:PFM %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s %(info.vcodec)s",
        ])
        .args(["--print", "after_move:RESULT %(.{filepath,title,id,duration,width,height,vcodec,acodec,ext})j"])
        .arg("-o")
        .arg(dir.join("video.%(ext)s"))
        .args(["-f", &format_selector(max_height, ffmpeg.is_some())]);
    if let Some(f) = &ffmpeg {
        cmd.args(["--merge-output-format", "mp4"]).arg("--ffmpeg-location").arg(f);
    }
    if let Some(d) = &deno {
        if takes_js_runtimes(ytdlp_version.as_deref()) {
            cmd.arg("--js-runtimes").arg(format!("deno:{}", d.display()));
        } else {
            warnings.push("This yt-dlp is too old to use Deno. Update it.".into());
        }
    }
    // Belt and braces for anything yt-dlp looks up itself.
    let mut path_dirs: Vec<PathBuf> = [ffmpeg, deno].iter().filter_map(|p| p.as_ref()?.parent().map(Path::to_path_buf)).collect();
    if let Some(p) = std::env::var_os("PATH") {
        path_dirs.extend(std::env::split_paths(&p));
    }
    if let Ok(joined) = std::env::join_paths(path_dirs) {
        cmd.env("PATH", joined);
    }
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    cmd.arg("--").arg(url);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Its own process group, so cancelling also stops the ffmpeg it runs.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Could not start yt-dlp: {e}"))?;
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    for (is_err, stream) in [
        (false, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
        (true, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
    ] {
        let Some(stream) = stream else { continue };
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if tx.send((is_err, line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let child = Arc::new(Mutex::new(child));
    on_spawn(child.clone());

    let mut result: Option<Downloaded> = None;
    let mut errors: Vec<String> = Vec::new();
    for (is_err, line) in rx {
        let line = line.trim().to_string();
        if let Some(rest) = line.strip_prefix("PFM ") {
            let f: Vec<&str> = rest.split_whitespace().collect();
            let num = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok()).map(|n| n as u64);
            on_progress(Progress {
                downloaded: num(0),
                total: num(1).or(num(2)),
                format: f.get(3).map(|s| s.to_string()),
                audio: f.get(4) == Some(&"none"),
            });
        } else if let Some(json) = line.strip_prefix("RESULT ") {
            result = serde_json::from_str(json).ok();
        } else if let Some(w) = line.strip_prefix("WARNING: ") {
            // yt-dlp warns about codecs it does not know (`iamf`) on every
            // YouTube video; that is noise, not news.
            if !w.starts_with("Unknown codec") {
                warnings.push(w.to_string());
            }
        } else if let Some(e) = line.strip_prefix("ERROR: ") {
            errors.push(e.to_string());
        } else if is_err && !line.is_empty() {
            errors.push(line);
        }
    }
    let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let why = errors.iter().rev().find(|e| !e.is_empty()).cloned();
        return Err(why.unwrap_or_else(|| format!("yt-dlp stopped with {status}.")));
    }

    let mut r = result.ok_or("yt-dlp finished but did not say where the file went.")?;
    let file = PathBuf::from(r.filepath.clone().unwrap_or_default());
    // Only ever hand back a file from this job's own folder.
    let canonical = file.canonicalize().map_err(|e| format!("The downloaded file is missing: {e}"))?;
    if !canonical.starts_with(dir.canonicalize().map_err(|e| e.to_string())?) {
        return Err("yt-dlp put the file somewhere unexpected.".into());
    }
    r.size = fs::metadata(&canonical).map_err(|e| e.to_string())?.len();
    r.filepath = Some(canonical.display().to_string());
    r.warnings = warnings;
    if ffmpeg.is_none() {
        r.warnings.push(
            "ffmpeg is not installed, so only a single combined file could be used — for YouTube that is 360p at best."
                .into(),
        );
    }
    Ok(r)
}

pub fn cancel(app: &AppHandle, job: &str) {
    let child = app.state::<VideoState>().running.lock().unwrap().remove(job);
    let Some(child) = child else { return };
    let pid = child.lock().unwrap().id();
    #[cfg(unix)]
    {
        // The whole group: yt-dlp and any ffmpeg it started.
        let _ = command("/bin/kill").args(["-KILL", &format!("-{pid}")]).status();
    }
    #[cfg(windows)]
    {
        let _ = command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
    let _ = child.lock().unwrap().kill();
}

pub fn read(app: &AppHandle, job: &str) -> Result<Vec<u8>, String> {
    let path = app
        .state::<VideoState>()
        .finished
        .lock()
        .unwrap()
        .get(job)
        .cloned()
        .ok_or("No finished download with that id.")?;
    fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

pub fn discard(app: &AppHandle, job: &str) -> Result<(), String> {
    app.state::<VideoState>().finished.lock().unwrap().remove(job);
    let _ = fs::remove_dir_all(job_dir(app, job)?);
    Ok(())
}

// ---------------------------------------------------------------------------
// Saving a large file
//
// The web view has the bytes and a save dialog has the place. The deck comes
// across in pieces — most of them views into the original, see `rewriteZip`
// — into a temporary file beside the destination, which is renamed over it
// only once every piece has arrived, so a failed save never leaves half a
// deck under the name the user chose.

struct SaveJob {
    file: BufWriter<File>,
    temp: PathBuf,
    dest: PathBuf,
}

static SAVE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}", nanos, SAVE_COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn save_begin(app: &AppHandle, suggested: &str, filter_name: &str, ext: &str) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dest = if let Some(dir) = debug_env("PFM_DEBUG_SAVE_DIR") {
        PathBuf::from(dir).join(Path::new(suggested).file_name().ok_or("Bad file name.")?)
    } else {
        let picked = app
            .dialog()
            .file()
            .set_file_name(suggested)
            .add_filter(filter_name, &[ext])
            .blocking_save_file();
        let Some(picked) = picked else { return Ok(None) };
        picked.into_path().map_err(|e| e.to_string())?
    };
    let t = token();
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let temp = dest.with_file_name(format!(".{name}.{t}.partial"));
    let file = File::create(&temp).map_err(|e| format!("Could not write to {}: {e}", dest.display()))?;
    app.state::<VideoState>()
        .saves
        .lock()
        .unwrap()
        .insert(t.clone(), SaveJob { file: BufWriter::with_capacity(1 << 20, file), temp, dest });
    Ok(Some(t))
}

pub fn save_chunk(app: &AppHandle, token: &str, bytes: &[u8]) -> Result<(), String> {
    let state = app.state::<VideoState>();
    let mut saves = state.saves.lock().unwrap();
    let job = saves.get_mut(token).ok_or("No save in progress with that id.")?;
    job.file.write_all(bytes).map_err(|e| format!("Could not write {}: {e}", job.dest.display()))
}

pub fn save_finish(app: &AppHandle, token: &str) -> Result<String, String> {
    let job = app.state::<VideoState>().saves.lock().unwrap().remove(token).ok_or("No save in progress with that id.")?;
    let SaveJob { file, temp, dest } = job;
    let finish = || -> Result<(), String> {
        let file = file.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if cfg!(windows) && dest.exists() {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
        fs::rename(&temp, &dest).map_err(|e| e.to_string())
    };
    finish().map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Could not save {}: {e}", dest.display())
    })?;
    Ok(dest.display().to_string())
}

pub fn save_abort(app: &AppHandle, token: &str) {
    if let Some(job) = app.state::<VideoState>().saves.lock().unwrap().remove(token) {
        drop(job.file);
        let _ = fs::remove_file(&job.temp);
    }
}

// ---------------------------------------------------------------------------
// Test hooks, debug builds only
//
// The Open and Save panels run in a separate macOS process that UI automation
// may not drive, so an end-to-end run in a debug build reaches past them:
//
//   PFM_DEBUG_OPEN=<deck.pptx>     load this deck at start
//   PFM_DEBUG_SAVE_DIR=<folder>    save there instead of asking
//
// Release builds compile both to nothing.

fn debug_env(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

/// The deck named by `PFM_DEBUG_OPEN`, as (file name, bytes).
pub fn debug_open() -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(path) = debug_env("PFM_DEBUG_OPEN") else { return Ok(None) };
    let p = PathBuf::from(path);
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(Some((name, fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_hash_for_one_asset_in_a_list() {
        let sums = "b7af77f686e95f7845ce8d09d21957718febb8b48b30555adb9dd2292ad7bf14  yt-dlp\n\
                    7a6fe71d7d680f1fb0ac18d4949873d77db2859e90017c0f44bd94b23be4ee40  yt-dlp_macos\n";
        assert_eq!(
            expected_hash(sums, "yt-dlp_macos").as_deref(),
            Some("7a6fe71d7d680f1fb0ac18d4949873d77db2859e90017c0f44bd94b23be4ee40")
        );
        assert_eq!(expected_hash(sums, "yt-dlp.exe"), None);
    }

    #[test]
    fn reads_single_line_and_starred_lists() {
        let one = "9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e  deno-aarch64-apple-darwin.zip\n";
        assert!(expected_hash(one, "deno-aarch64-apple-darwin.zip").is_some());
        // A bare hash, as some publishers write it.
        let bare = "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924\n";
        assert!(expected_hash(bare, "ffmpeg.zip").is_some());
        let star = "C8ED4C4E6978A03C485EDBFE4E0A5DC2380F8A30BBA5150531B31B094492D924 *ffmpeg.zip";
        assert_eq!(
            expected_hash(star, "ffmpeg.zip").as_deref(),
            Some("c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924")
        );
        assert_eq!(expected_hash("not a hash  ffmpeg.zip", "ffmpeg.zip"), None);
    }

    #[test]
    fn asks_for_h264_and_aac_and_knows_when_it_cannot_join_them() {
        let with = format_selector(1080, true);
        assert!(with.starts_with("bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a][audio_channels<=2]/"));
        let without = format_selector(720, false);
        assert!(!without.contains('+'), "nothing can merge without ffmpeg: {without}");
    }

    #[test]
    fn only_passes_js_runtimes_to_a_yt_dlp_that_knows_it() {
        assert!(takes_js_runtimes(Some("2026.10.21")));
        assert!(takes_js_runtimes(Some("2025.11.12")));
        assert!(!takes_js_runtimes(Some("2025.10.22")));
        assert!(!takes_js_runtimes(None));
    }

    #[test]
    fn every_tool_has_a_release_on_this_machine() {
        for t in Tool::ALL {
            assert!(plan(t).is_ok(), "{t:?}");
        }
    }
}
