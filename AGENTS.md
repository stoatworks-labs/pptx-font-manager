# AGENTS.md — bringing an LLM up to speed on pptx-font-manager

Orientation for an AI assistant (or a new human) picking this project up cold.
`CLAUDE.md` holds the short command reference; this file explains the model and
the traps.

---

## 1. What this is

A browser app that takes a PowerPoint deck, works out **which fonts it actually
uses**, checks which of those are **installed on the machine looking at it**,
and builds a **sidecar .zip** with the fonts and per-platform installer scripts
so the deck opens correctly somewhere else.

Static Vite + React SPA on a Cloudflare static-assets Worker. No backend — the
deck never leaves the browser. A Tauri desktop port is planned (see §8).

---

## 2. The two things that make this project non-trivial

Everything else here is plumbing. These two are the product.

### 2.1 A naive `typeface=` grep is catastrophically wrong

Measured against the three real decks used as fixtures, a plain grep over the
zip reports **39, 36 and 9** distinct typefaces. The true answers are **2, 4 and
6**.

The noise comes from one place — every Office theme carries a *script fallback
table*:

```xml
<a:fontScheme name="Office">
  <a:minorFont>
    <a:latin typeface="Calibri"/>            <!-- the actual theme font -->
    <a:font script="Jpan" typeface="..."/>   <!-- ~30 of these -->
    <a:font script="Deva" typeface="Mangal"/>
```

Those entries say "reach for this if the document ever contains Devanagari".
They are present whether or not a single such character exists in the deck. A
scanner that counts them tells the user to install Mongolian Baiti, DokChampa
and Iskoola Pota.

`scan.ts` collects them separately as `ignoredFallbacks` and **never** treats
them as used. The UI shows the list behind a disclosure, because "why isn't this
tool listing 39 fonts like the other one" is a fair question that deserves an
answer.

**A name in the fallback table that is also genuinely used elsewhere must still
be reported.** Arial is in every fallback table and is also the real theme font
of one fixture. There is a test for this.

### 2.2 Font names in a deck are face names, not family names

PowerPoint writes whatever the authoring app put in the run properties. Real
examples from the fixtures, checked against CoreText ground truth on a stock
Mac:

| In the deck             | Naive verdict | Truth                                          |
| ----------------------- | ------------- | ---------------------------------------------- |
| `Helvetica Neue Medium` | missing       | Helvetica Neue **is** installed; Medium is a face |
| `Poppins Regular`       | missing       | Poppins **is** installed                       |
| `Times Roman`           | missing       | Times New Roman resolves it                    |
| `Garamond`              | missing       | genuinely missing                              |

So `names.ts` strips style suffixes to family + weight + italic before
comparing, and matches against family **and** full/PostScript face names.
Without this the app cries wolf on fonts the user already has, and then offers
to download a "Helvetica Neue Medium" from Google Fonts, which does not exist.

Two guards worth knowing about:

- `PROTECTED_FAMILIES` — `Arial Black` is its own installed family, not a
  900-weight of Arial. Stripping "Black" breaks the match instead of fixing it.
- If stripping every style token leaves nothing, the original name is kept.
  `Black` and `Medium` both exist as real family names.

---

## 3. Layout

```
src/core/         Portable, no DOM. Reusable unchanged in the desktop port.
  xml.ts            Tiny tag tokenizer — see §4
  scan.ts           THE scanner. Theme resolution, fallback filtering, tiers
  names.ts          Face-name -> family/weight/italic, installed matching
  eot.ts            Embedded font headers, and extraction where possible
  google.ts         Catalogue matching + downloads
  bundle.ts         The sidecar .zip
  installers.ts     The scripts that go inside it
  types.ts
src/platform/
  fontcheck.ts      Browser-only: Local Font Access + canvas probing
src/lib/
  resolve.ts        Ties scan + inventory + Google together
src/data/
  google-fonts.json Build-time snapshot — regenerate with the script below
scripts/
  build-catalogue.mjs
test/
  fixtures/         Real decks. NOT committed — see §7
```

---

## 4. Why there is a hand-rolled XML tokenizer

`src/core/xml.ts` is ~120 lines and exists because the core must run unchanged
in three places: the browser, vitest under the `node` environment, and the
future Tauri port. `DOMParser` exists in one of them.

Everything the scanner needs is attribute values plus enough nesting awareness
to tell `<a:majorFont><a:latin/>` from `<a:minorFont><a:latin/>`. That does not
justify a real XML parser, and a regex alone cannot do the nesting.

Do **not** "simplify" this to a regex. The `majorFont`/`minorFont` distinction
and the `fontScheme` skip in `collectRefs` both depend on tag nesting.

---

## 5. Embedded fonts: three formats, two recoverable

`<p:embeddedFontLst>` points at `ppt/fonts/*.fntdata`. That payload is **EOT**
(Embedded OpenType), not a bare TTF. Verified against real bytes:

```
ppt/fonts/Garamond-boldItalic.fntdata   (PowerPoint)
  EOTSize=79089  FontDataSize=78883  Version=0x00020002
  Flags=0x00000004  Magic=0x504C        <- TTCOMPRESSED
  no sfnt signature anywhere in the part

ppt/fonts/font10.fntdata                (Canva)
  Flags=0x00000000                      <- uncompressed
  sfnt at offset 216 == len - FontDataSize
```

| Producer            | Format                     | Recoverable?                    |
| ------------------- | -------------------------- | ------------------------------- |
| PowerPoint          | EOT + MicroType Express    | **No** — needs an MTX decompressor |
| Canva, LibreOffice  | EOT, uncompressed          | **Yes** — last `FontDataSize` bytes |
| A few others        | bare sfnt                  | Yes — use directly              |

`extractSfnt()` seeks from the **end** of the part, not a fixed offset: the
variable-length name records sit between the header and the font data. A
verified Canva extraction yields a valid 18-table TTF.

There is a licensing reason as well as a technical one not to fight MTX:
permission to *embed* a font in a document is not permission to extract and
install it. Reporting "this travels with the deck" is the useful answer.

---

## 6. Google Fonts: the CSS API cannot give you an installable font

This is the trap that will bite anyone who "improves" the download path.

- `fonts.googleapis.com/css` and `/css2` serve **woff2** to any modern browser
  UA, **subsetted by `unicode-range`** into separate latin / latin-ext /
  devanagari files.
- A browser **cannot** override its own `User-Agent` on `fetch` — it is a
  forbidden header. There is no way to ask them for the TTF.
- A subsetted woff2 in a font bundle is worse than nothing: it installs without
  complaint and renders blanks outside its subset.

So downloads come from **`raw.githubusercontent.com/google/fonts`** — the
original complete files, `Access-Control-Allow-Origin: *`.

The catalogue at `src/data/google-fonts.json` is a build-time snapshot because
`fonts.google.com/metadata/fonts` sends **no** CORS header. It carries the real
SPDX licence, taken from which directory (`ofl/`, `apache/`, `ufl/`) the files
live in. 1934 of 1942 families have downloadable static TTFs.

**The CSP in `public/_headers` must list `raw.githubusercontent.com` in
`connect-src`.** The dev server does not apply `_headers`, so getting this wrong
fails only in production.

Variable fonts (`EBGaramond[wght].ttf`) are one file covering the whole axis.
`pickFiles()` prefers a matching static face and falls back to the variable.

---

## 7. Fixtures are real decks and are NOT committed

`test/fixtures/*.pptx` is gitignored. They are private presentations. Every test
that needs one is wrapped in `it.runIf(has(...))`, so the suite passes on a
clean clone and in CI — it just tests less.

If you need them, any deck will do, but the three shapes that matter are:

- one authored in **Canva** (uncompressed embedded EOT, huge fallback table)
- one from **Office with embedded fonts** (MTX-compressed, many layouts)
- one that is **theme-reference heavy** (`+mn-lt` everywhere, no explicit fonts)

The third fixture is 316 MB, which is why `scanPptx` passes a `filter` to
`unzipSync` and only inflates `.xml`, `.rels` and `.fntdata`. Without it the
browser inflates hundreds of MB of video for nothing.

---

## 8. The desktop port

Same repo, same `src/core/`. Only `src/platform/native.ts` and the factory in
`src/platform/index.ts` differ from the web build, plus `src-tauri/`. Tauri v2.

```bash
npm run desktop:dev      # tauri dev  (drives vite on 5188 — the port must match devUrl)
npm run desktop:build    # bundles .app/.dmg/.nsis/.deb/.appimage
cd src-tauri && cargo test
cd src-tauri && cargo run --example probe           # native enumeration vs ground truth
cd src-tauri && cargo run --example install_probe   # real install, then `-- clean`
```

### 8.1 Two traps found by testing, not by reading

**`window.__TAURI__` does not exist.** It is only injected when
`withGlobalTauri` is set in `tauri.conf.json`, which it is not. Sniffing for it
reports every desktop launch as a browser: the app runs, looks completely
normal, and silently loses the only feature it was built for. Use `isTauri()`
from `@tauri-apps/api/core`.

**macOS font registration is asynchronous.** Writing a file into
`~/Library/Fonts` *does* work — but the font server picks it up on its own
schedule, measured at roughly **ten seconds** on an M-series Mac. That is long
enough to be a bug and not a delay, because the install flow immediately
re-checks what is installed and would truthfully report the font it just
installed as still missing. `register_font` calls
`CTFontManagerRegisterFontsForURL` with user scope, which makes it visible
synchronously. Verified causally: absent (2232 families) -> install -> visible
in the same process (2233).

### 8.2 Watch out when testing font installation on this machine

`~/Library/Fonts/google-fonts/` is a **clone of the entire google/fonts repo**,
and macOS scans that directory recursively. Roughly 1,900 Google families are
therefore already installed, and `ls ~/Library/Fonts | grep -i <name>` will not
show them because they are in subdirectories.

This invalidates the obvious test. Picking any well-known Google font as an
"install this missing font" target proves nothing, because it is already there.
Find a genuinely absent family first:

```bash
cd src-tauri && cargo run --example probe   # then diff against src/data/google-fonts.json
```

At the time of writing 113 of the 1,942 catalogued families were not visible to
CoreText; `Asimovian` is the one the install probe uses.

### 8.3 Why the Rust side re-validates everything

`install_fonts` writes into the user's font directory, so it does not trust the
frontend:

- filenames must be plain font filenames — no separators, no `..`, and a
  `.ttf`/`.otf`/`.ttc` extension;
- the bytes must start with a real sfnt signature. This is not a formality: a
  failed download returns an **HTML error page**, and writing that into the
  font directory is how a font manager corrupts a font book;
- existing files are skipped, never overwritten;
- if the OS-registration step fails the written file is removed again, rather
  than leaving a font that half exists.

Because of that validation the Tauri capability set grants **no filesystem
plugin** — everything goes through these commands.

### 8.4 Face names are resolved lazily

`font_inventory` takes the list of names the deck wants. Families come back in
full (2,232 here, ~210 ms), but face names do not: reading the name table of
all 11,630 installed font files to answer a question about five of them takes
seconds. Only the families that prefix-match something the deck asked for get
their faces loaded.

This is what makes the desktop build *more* accurate than the web one.
`Helvetica Neue Medium` resolves to an exact installed **face**, so it reports
"Installed" rather than the browser's best answer of "family only".

## 9. State of play

Verified working, end to end:

*Web build, in a real browser:*

- scanning all three fixture shapes, including the 316 MB one
- installed/missing verdicts matching CoreText ground truth on this Mac
- embedded-EOT extraction to a valid TTF
- bundle .zip: structure, manifest, installer scripts, line endings, exec bits
- Google Fonts download over CORS from a page origin, under the production CSP

*Desktop build, on macOS:*

- app launches, detects desktop mode, native inventory (2,232 families, ~210 ms)
- native face resolution beating the browser: `Helvetica Neue Medium` and
  `Times Roman` both resolve as exact installed faces
- **real font install**, verified causally against a genuinely absent family:
  absent -> download from google/fonts -> installed -> visible to CoreText in
  the same process
- install guards: HTML error page refused, path traversal refused, existing
  file skipped rather than overwritten

**Not verified:**

- **Windows, at all.** `install-fonts.ps1` (the bundle's script) has never run
  on Windows, and neither has the desktop app's Rust `register_font` path,
  which writes the `HKCU\...\Fonts` registry value. Both were written against
  Microsoft's documented behaviour and neither has been executed. The Parallels
  Windows 11 **ARM64** VM is the place to test both — drive it with `.ps1`
  files, not `powershell -Command`.
- **Linux, at all.** The `fc-cache` path in `post_install_note` and the bundle's
  `install-fonts.sh` are both unexecuted.
- `install-fonts.command` is syntax-checked (`bash -n`) but has not been run
  against a real font install — the desktop app's own install path was tested
  instead, since that is the one people will use.
- The Local Font Access path (`queryLocalFonts`) is implemented but the
  permission prompt has not been accepted in a test run, so blob-reading of
  locally installed fonts in the browser is unexercised.
- The desktop app has not been driven through a full deck-to-install cycle in
  its own window; the install path was exercised through
  `cargo run --example install_probe` instead.
- No code signing or notarisation yet, so a distributed build will hit
  Gatekeeper.
