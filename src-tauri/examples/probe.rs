//! Manual check: does native enumeration agree with the CoreText ground truth
//! and with what the browser build reports?
//!
//!     cargo run --example probe
use pptx_font_manager_lib::probe_inventory;

fn main() {
    let wanted: Vec<String> = [
        "Asimovian", "Helvetica Neue Medium", "Calibri",
        "Times Roman", "Helvetica Neue", "Arial", "Gill Sans", "Corbel",
        "Garamond", "Canva Sans", "Arial Black",
    ].iter().map(|s| s.to_string()).collect();

    let t0 = std::time::Instant::now();
    let inv = probe_inventory(&wanted).expect("inventory");
    let elapsed = t0.elapsed();

    println!("families: {}  faces resolved: {}  in {:?}", inv.families.len(), inv.faces.len(), elapsed);
    println!();
    let fam_lower: Vec<String> = inv.families.iter().map(|f| f.to_lowercase()).collect();
    let face_lower: Vec<String> = inv.faces.iter().map(|f| f.to_lowercase()).collect();
    for w in &wanted {
        let wl = w.to_lowercase();
        let fam = fam_lower.iter().any(|f| f == &wl);
        let face = face_lower.iter().any(|f| f == &wl);
        println!("{:<24} family={:<5} face={}", w, fam, face);
    }
    println!();
    println!("faces found: {:?}", inv.faces);
}
