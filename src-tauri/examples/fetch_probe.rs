//! Fetch yt-dlp, ffmpeg and Deno from their official releases into a scratch
//! folder, through the same code the app's "Get" buttons run: resolve, check
//! the published SHA-256, unpack, run `--version`, install.
//!
//! The app itself never offers to fetch a tool it can already find (Homebrew's
//! ffmpeg, say), so this is the way to exercise every path on one machine.
//!
//!   cargo run --example fetch_probe -- <empty folder> [yt-dlp|ffmpeg|deno ...]

use pptx_font_manager_lib::{probe_fetch_tool, VideoTool};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("usage: fetch_probe <folder> [tool...]"));
    let mut tools: Vec<VideoTool> = args
        .map(|a| match a.as_str() {
            "yt-dlp" => VideoTool::YtDlp,
            "ffmpeg" => VideoTool::Ffmpeg,
            "deno" => VideoTool::Deno,
            other => panic!("unknown tool {other}"),
        })
        .collect();
    if tools.is_empty() {
        tools = vec![VideoTool::YtDlp, VideoTool::Ffmpeg, VideoTool::Deno];
    }
    let mut failed = false;
    for t in tools {
        let start = std::time::Instant::now();
        match probe_fetch_tool(t, &dir) {
            Ok(info) => println!("{t:?}: {:?} at {:?} ({:.1} s)", info.version, info.path, start.elapsed().as_secs_f32()),
            Err(e) => {
                failed = true;
                println!("{t:?}: FAILED {e}");
            }
        }
    }
    std::process::exit(i32::from(failed));
}
