//! Manual end-to-end check of the install path with a real font.
//!
//!     cargo run --example install_probe          # install
//!     cargo run --example install_probe -- clean # remove what it installed
//!
//! Downloads Lobster from the google/fonts repo — the same URL the app uses —
//! and puts it through install_fonts, including the sfnt guard and the
//! skip-if-present behaviour.
use pptx_font_manager_lib::{probe_install, probe_install_dir, FontFile};

const URL: &str = "https://raw.githubusercontent.com/google/fonts/main/ofl/asimovian/Asimovian-Regular.ttf";
const NAME: &str = "Asimovian-Regular.ttf";

fn main() {
    let dir = probe_install_dir().expect("install dir");
    let target = std::path::Path::new(&dir).join(NAME);

    if std::env::args().any(|a| a == "clean") {
        match std::fs::remove_file(&target) {
            Ok(()) => println!("removed {}", target.display()),
            Err(e) => println!("nothing to remove ({e})"),
        }
        return;
    }

    println!("downloading {URL}");
    let out = std::process::Command::new("curl")
        .args(["-sL", URL])
        .output()
        .expect("curl");
    let data = out.stdout;
    println!("  {} bytes, first four: {:?}", data.len(), &data[..4.min(data.len())]);

    // 1. The real thing.
    let report = probe_install(vec![FontFile { filename: NAME.into(), data: data.clone() }])
        .expect("install");
    println!("\ninstall -> dir={} installed={} skipped={} failed={}",
        report.dir, report.installed, report.skipped, report.failed);
    for o in &report.outcomes {
        println!("   {} {} {:?}", o.filename, o.status, o.detail);
    }
    println!("   note: {:?}", report.note);
    println!("   file on disk: {}", target.exists());

    // 1b. Immediately visible? This is the whole point of explicit
    //     registration — without it the font server takes ~10s.
    let inv = pptx_font_manager_lib::probe_inventory(&["Asimovian".to_string()]).expect("inv");
    println!("   VISIBLE IMMEDIATELY: {}  (families={})",
        inv.families.iter().any(|f| f == "Asimovian"), inv.families.len());

    // 2. Again — must skip, never overwrite.
    let again = probe_install(vec![FontFile { filename: NAME.into(), data: data.clone() }])
        .expect("install");
    println!("\nsecond run -> installed={} skipped={} (must be 0 / 1)", again.installed, again.skipped);

    // 3. An HTML error page must be refused.
    let bad = probe_install(vec![FontFile {
        filename: "Evil-Regular.ttf".into(),
        data: b"<!DOCTYPE html><title>404</title>".to_vec(),
    }]).expect("install");
    println!("\nHTML payload -> failed={} detail={:?}", bad.failed,
        bad.outcomes.first().and_then(|o| o.detail.clone()));

    // 4. A path traversal must be refused.
    let evil = probe_install(vec![FontFile {
        filename: "../../../.zshrc".into(),
        data: vec![0x00, 0x01, 0x00, 0x00],
    }]).expect("install");
    println!("traversal    -> failed={} detail={:?}", evil.failed,
        evil.outcomes.first().and_then(|o| o.detail.clone()));
}
