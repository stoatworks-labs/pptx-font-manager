//! Download one video through the same yt-dlp run the app makes — format
//! selection, progress parsing, the result line, the file check — and print
//! what came back.
//!
//! Tools are looked up the way the app looks them up, with `<tools folder>`
//! standing in for the app's own (fill one with `fetch_probe`). Run it with a
//! bare PATH to see what a Finder-launched app would find:
//!
//!   env -i HOME=$HOME PATH=/usr/bin:/bin cargo run --example download_probe -- \
//!     <tools folder> <empty out folder> <url> [max height]

use pptx_font_manager_lib::{probe_find_video_tools, probe_run_ytdlp};
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (tools_dir, out, url) = (PathBuf::from(&a[0]), PathBuf::from(&a[1]), &a[2]);
    let height = a.get(3).and_then(|h| h.parse().ok()).unwrap_or(1080);
    let tools = probe_find_video_tools(&tools_dir).expect("tools");
    println!("yt-dlp {:?}\nffmpeg {:?}\ndeno   {:?}", tools.ytdlp, tools.ffmpeg, tools.deno);

    let start = std::time::Instant::now();
    let mut events = 0usize;
    let mut last = String::new();
    let r = probe_run_ytdlp(
        &tools,
        &out,
        url,
        height,
        |child| println!("spawned pid {}", child.lock().unwrap().id()),
        |p| {
            events += 1;
            // One line per stream, not per update.
            let key = format!("{:?} audio={}", p.format, p.audio);
            if key != last {
                println!("progress: {key} total={:?}", p.total);
                last = key;
            }
        },
    );
    println!("{events} progress events in {:.1} s", start.elapsed().as_secs_f32());
    match r {
        Ok(d) => println!("{d:#?}"),
        Err(e) => {
            println!("FAILED: {e}");
            std::process::exit(1);
        }
    }
}
