# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*PowerPoint deck font scanner/checker/bundler — PUBLIC, LIVE; two correctness pillars and the EOT/CSS-API traps*

**pptx-font-manager** — scans a `.pptx` for the fonts it *actually* uses, checks which
are installed, matches missing ones to Google Fonts, and builds a sidecar `.zip` with
per-platform installers. PUBLIC MIT, created 2026-08-05.

- Repo `stoatworks-labs/pptx-font-manager`, LIVE at
  `https://pptx-font-manager.allan-sargeant.workers.dev` (static-assets Worker, like
  [aspect calc](https://github.com/stoatworks-labs/aspect-calc/blob/main/docs/NOTES.md) (`aspect-calc`) / blend-calc).
- `src/core/` is deliberately DOM-free so the planned Tauri desktop port reuses it
  unchanged. Browser-only code is in `src/platform/`. Auto-install is desktop-only —
  a browser cannot write to a font directory, which caps the web app at "here is a zip".

**Two correctness pillars — the whole product:**

1. **Theme script-fallback tables are noise.** Every Office theme lists ~30 CJK/Indic
   fonts under `<a:font script="...">` whether or not such characters exist. A plain
   `typeface=` grep on three real decks reports **39, 36 and 9** fonts; truth is
   **2, 4 and 6**. Never count them — but a fallback name that is *also* genuinely
   used must still be reported (Arial).
2. **Decks name faces, not families.** `Helvetica Neue Medium`, `Poppins Regular`,
   `Times Roman` all report missing against installed *family* names when present.
   Strip style suffixes to family+weight+italic, match family AND PostScript/full names.
   Guard `Arial Black` — its own family, not a 900-weight of Arial.

**Traps, all verified against real bytes:**

- Embedded fonts are **EOT, not TTF**. PowerPoint's are MicroType Express compressed
  (flag 0x4, magic 0x504C) and unrecoverable; Canva/LibreOffice's are uncompressed and
  extract by taking the last `FontDataSize` bytes — seek from the END, name records are
  variable-length.
- **The Google CSS API cannot supply an installable font**: woff2 to any browser UA,
  subsetted by `unicode-range`, and a browser cannot override its own User-Agent.
  Download from `raw.githubusercontent.com/google/fonts` (complete files, CORS `*`).
  `fonts.google.com/metadata/fonts` has **no CORS** — hence the baked catalogue.
- **CSP must allow raw.githubusercontent.com** in `connect-src`. The dev server does not
  apply `_headers`, so getting it wrong fails *only in production*.
- `unzipSync` is filtered to `.xml`/`.rels`/`.fntdata` — one fixture deck is 316 MB of
  mostly video.

Test fixtures are the user's private decks, gitignored, `it.runIf(has(...))`.
**Unverified:** `install-fonts.ps1` never run on Windows (use [windows 11 parallels vm](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_windows_11_parallels_vm.md));
shell installers syntax-checked only; `queryLocalFonts` permission prompt unexercised.
