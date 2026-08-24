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
  substitutes.ts    Stand-ins for fonts that cannot be redistributed — see §9
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

### 8.2b Windows, measured on real Windows

Tested on Windows 11 ARM64 (build 26200) in the Parallels VM, driven with
`prlctl exec`. Two things about that harness matter before you trust a result:

- **`prlctl exec` runs as SYSTEM** (`MACHINE$`), so `%LOCALAPPDATA%` is
  `C:\Windows\system32\config\systemprofile\...`. A per-user font install
  tested that way proves nothing about a real user. Pass `--current-user`.
- **`Expand-Archive` strips Mark-of-the-Web.** Only the shell's own copy engine
  propagates it, so extract through `Shell.Application`'s `CopyHere` if the
  point of the test is MOTW. And `curl`/`Invoke-WebRequest` never set MOTW in
  the first place — only browsers do, so write the `Zone.Identifier` stream
  yourself.

What the bundle installer got right, confirmed end to end under a genuine
`ZoneId=3`:

| Claim in README.txt | Result |
| --- | --- |
| The `.ps1` is blocked when it comes from a downloaded zip | **Confirmed** — "cannot be loaded… is not digitally signed", under the default `CurrentUser = RemoteSigned` |
| The `.cmd` wrapper gets through | **Confirmed** — installs, exit 0 |
| Existing fonts are skipped, not overwritten | **Confirmed** on a second run |
| The font ends up usable | **Confirmed for GDI** — a fresh process enumerating `InstalledFontCollection` sees the family (272 families, the new one among them) |

What it got wrong, and is now fixed:

- **The registry value name must be the font's own face name.** It was written
  from the filename — `Lobster-Regular (TrueType)` instead of
  `Lobster (TrueType)`. A value written that way **did not persist**: it was
  present immediately after the install and gone by the next check, while the
  font itself stayed usable. `install-fonts.ps1` now reads the real face name
  out of the file with `PrivateFontCollection` before writing the value, which
  is what the shell's own installer records.
- **Nothing told the OS a font had arrived.** Both the script and the Rust
  `register_font` copied the file and wrote the value and stopped there.
  Windows' own installer also calls `AddFontResourceW` and broadcasts
  `WM_FONTCHANGE`; both now do. This is the same class of bug as the macOS
  asynchronous-registration one in §8.1, with a different remedy.

**Still open — Chromium does not see per-user fonts.** After a successful
install that GDI could see, Edge 151 could not: the canvas width probe reported
the family absent, across two fresh Edge launches including one after
`taskkill`. Windows' own fonts (Arial, Calibri, Segoe UI, Cambria) all probe
correctly in the same run, so the probe itself works on Windows — it is
specifically the freshly installed per-user font that Edge cannot reach.

That has a real consequence: **on Windows the web app will keep reporting a
font as missing after the user installs it.** The desktop build reads the OS
font registry directly and is unaffected. Whether a logout fixes it is
untested — the VM rebooted to a lock screen and testing stopped there rather
than entering credentials.

Two other things the Windows run confirmed, which macOS could not:

- the canvas width-measurement probe correctly identifies Windows-only faces
  (Segoe UI, Cambria, Calibri) and rejects a control string;
- the `raw.githubusercontent.com` font fetch clears CORS from Edge on Windows
  (160,316 bytes, sfnt signature intact).

`queryLocalFonts` was reported absent in that run, but the probe page was
served over plain HTTP — it is a secure-context API, so that result says
nothing about Edge. It was not retested.

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

- **The desktop app's Rust `register_font` has never run on Windows.** The
  bundle's `install-fonts.ps1` now has (see §8.2b), and the two share a
  convention — face-name registry value, `AddFontResourceW`, `WM_FONTCHANGE` —
  so the risk is much lower than it was. But it is different code, and the
  Windows build itself has never been produced: there is no Rust or MSVC
  toolchain in the VM, and cross-compiling from macOS fails in `tauri-winres`
  for want of `llvm-rc`. The Win32 FFI block was checked only by compiling an
  equivalent against stubs on the host, which proves the signatures are
  well-formed and nothing else.
- **Whether Chromium ever sees a per-user font**, and whether a logout fixes
  it — see the open item in §8.2b. The VM rebooted to a lock screen and testing
  stopped rather than entering credentials.
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

---

## 9. Substitutes: the fonts that actually go missing

The fonts a deck is most likely to be missing are not exotic. They are
**Calibri, Cambria, Arial, Times New Roman, Courier New and Georgia** — the
system fonts a deck picks up simply by being authored on Windows or a Mac.

All of them share three properties: they may not be redistributed, they are not
on Google Fonts, and the machine the deck is going to very likely lacks them
too. Before `src/core/substitutes.ts` the app's entire answer for `Calibri` was
"missing, not on Google Fonts", with no suggestions — `suggestGoogleFamilies`
ranks by shared word tokens and there is no path from "Calibri" to "Carlito".

### Metric-compatible is a strictly stronger claim than "looks similar"

A **metric-compatible** face has the same advance widths as its target. Text
occupies the same horizontal space, so line breaks hold, text stays in its box,
and a slide proofed at 1920x1080 is still proofed. These exist because Google
and RedHat commissioned them for exactly this problem:

| Deck asks for   | Stand-in | Note                         |
| --------------- | -------- | ---------------------------- |
| Calibri         | Carlito  | commissioned as a Calibri metric clone |
| Cambria         | Caladea  | commissioned as a Cambria metric clone |
| Arial/Helvetica | Arimo    | Chrome OS core font          |
| Times New Roman | Tinos    | Chrome OS core font          |
| Courier New     | Cousine  | Chrome OS core font          |
| Georgia         | Gelasio  | metric-compatible with Georgia |

A **similar** face (Open Sans for Segoe UI, EB Garamond for Garamond) will
change line breaks. Presented as a fix, it is worse than saying nothing: the
user believes the deck is safe and discovers otherwise in front of an audience.

**So `metric` is a separate field, not a ranking.** It drives the colour of the
row, the wording, and a distinct `SUBSTITUTIONS` section in the bundle
manifest. Do not collapse the two into one sorted list.

### Two things that will bite

- **Substitutes are a fallback, never a first answer.** `resolve.ts` only
  attaches them when the font is missing *and* nothing downloadable matches it
  directly. A real copy of the font the deck asked for always wins.
- **`parseFontName('Times New Roman')` returns the family `Times New`**, because
  `Roman` is a weight token (as in `Times Roman`) and only `times roman` is in
  `PROTECTED_FAMILIES`. The installed-check survives this by comparing the raw
  name first, and `findSubstitutes` does the same — it tries `parsed.raw` before
  `parsed.family`, and `Times New` is listed as an alias as belt-and-braces.
  There is a test pinning this exact behaviour.

Substitutes are deliberately **excluded from the bulk "install missing fonts"
action**. A substitute is a different typeface, and swapping one in without the
user choosing it is not a call this app gets to make silently. They get their
own per-row button, and their own manifest section that leads the file.

---

## 10. Fontsource: a second source, and the same subsetting trap

`src/core/fontsource.ts` adds the **119 open families Google Fonts does not
carry** — Adwaita, Aileron, Chunk Five, Bluu Next and similar.

### Its docs are wrong about TTFs, in the way that matters

Fontsource states that its `.ttf` files bundle every subset into one file.
**They do not.** Measured against the live CDN:

```
inter@latest/latin-400-normal.ttf   200, 66,912 bytes   <- latin only
inter@latest/400-normal.ttf         404
inter@latest/full-400-normal.ttf    404
```

Every file is `{subset}-{weight}-{style}.ttf`. This is the same unicode-range
subsetting that makes the Google CSS API useless here (§6), and a subsetted
font in a bundle is worse than nothing — it installs cleanly, then renders
blanks outside its subset.

**What makes it safe anyway:** a family declaring exactly *one* subset has
nothing to lose. Its single `latin` file *is* the whole font. The build script
keeps only single-subset families, so if Fontsource ever adds a multi-subset
non-Google family it is dropped rather than silently shipped broken.

### Three more things the build script does

- **Drops anything Google already has.** Fetching Google families from
  Fontsource would mean fetching a subsetted republish instead of the original.
- **Drops names that collapse onto a Google family.** `Syne Italic` is a real
  Fontsource entry, but `parseFontName` reduces it to `Syne`, which Google has —
  so the entry could never win the precedence check. Dead by construction is
  worse than absent.
- **Drops non-redistributable licences,** though at present everything is
  OFL/Apache/CC0/MIT/Unlicense.

### Precedence lives in exactly one place

`downloadPlan()` in `src/lib/resolve.ts` decides which catalogue supplies a
font: Google, then Fontsource, then nothing. Callers must not branch on
`r.google` / `r.fontsource` themselves — the row button, the bulk install and
the bundle builder all go through it so they cannot drift apart. Substitutes
(§9) sit below both and are handled separately, because they are a different
typeface rather than a copy of what was asked for.

### CSP

`public/_headers` must list **`cdn.jsdelivr.net`** in `connect-src` alongside
`raw.githubusercontent.com`. Verified under the real production headers via
`npm run serve:dist`, with `fonts.googleapis.com` as a negative control to
confirm the policy is actually being enforced rather than merely permissive.

---

## 11. Adobe Fonts: recognition only, and why that is the whole story

`src/core/adobe.ts` can identify an Adobe font. It can never download one, and
**no amount of signing in would change that.** Two independent blockers:

1. **There is no font-file endpoint.** The Typekit/Adobe Fonts API is still live
   — `typekit.com/api/v1` answers 401, not 404 — but it does kit management and
   metadata only. Desktop faces reach a machine solely through Creative Cloud
   sync, into an obfuscated CoreSync directory
   (`~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/` on
   macOS). There is nothing to authenticate *to* for a file.
2. **The licence forbids this app's entire workflow.** Adobe's documentation
   states the fonts "are not compatible with packaging workflows that involve
   transferring font files to another user or computer", and the terms do not
   permit copying font files or distributing them so others can use them
   directly. A sidecar `.zip` handed to a venue is that transfer.

So do not add a fetcher here. There is a test asserting the module exports no
`fetch`/`download`/`install` function, precisely so a future reader who has not
read this section cannot quietly add one.

### What it is actually for

For a **missing** font, it names the reason and links to activation. "Not on
Google Fonts" is true but reads as a failure of the tool; "Adobe's licence does
not permit putting this in a bundle, here is where a subscriber activates it"
is actionable. Compare §5 on MTX embeds: reporting the truth beats a fix that
cannot exist.

### Why it fires ONLY for missing fonts — the trap

**Adobe Fonts resells the Microsoft system fonts.** Monotype lists Calibri,
Times New Roman, Courier New, Segoe UI and Wingdings there. Those are genuine
catalogue entries, not matching bugs.

So a catalogue hit does not mean "this font is exotic and cannot travel". An
early cut of this feature applied the note to installed fonts too, in order to
warn about the most dangerous deck there is — the one that **works perfectly for
its author and breaks everywhere else**, because an Adobe font synced by
Creative Cloud registers with the OS like any other. Run against a real deck, it
told the user that *Times New Roman* "cannot travel with the deck and will break
elsewhere". That is the §2.2 false alarm in a new costume.

### Recovering the warning: the file path, not the name

The name cannot carry that warning. The **location of the file** can, and the
desktop build now reports it. A face Creative Cloud syncs is not in the font
directory at all:

    macOS    ~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/
    Windows  %APPDATA%\Adobe\CoreSync\plugins\livetype\r\

with an obfuscated, extensionless filename. Times New Roman is never in there;
an activated Proxima Nova is only in there. So `resolveFont` flags an
**installed** Adobe font when, and only when, `installedViaAdobeSync` is true —
proven by a path — and the system fonts cannot satisfy that condition however
many times Monotype lists them.

Three parts, and each one has a trap in it:

1. **font-kit will not give you the path on macOS.** Its CoreText source hands
   back `Handle::Memory` for *every* installed face — verified against Arial,
   Gill Sans and Helvetica Neue, 69 faces, no paths at all. So `fonts.rs` asks
   CoreText itself (`CTFontDescriptor` → URL, via the `core-text` crate) for
   family locations. Windows and Linux need none of this: DirectWrite and
   fontconfig both build `Handle::Path` already.
2. **The store is also read directly**, in `adobe_sync_store()`. It does not
   depend on the OS font API naming a location, and the family name comes out
   of each file's own name table because the filenames are deliberately
   meaningless. Cost scales with how many fonts the user has activated; an
   empty store is one `read_dir`.
3. **A family with a synced file AND an ordinary one is not a risk.** Adobe
   resells the system fonts, so a subscriber can hold two Times New Romans. The
   family is only reported as synced when *no* non-synced file backs it —
   otherwise the false alarm walks straight back in. Bundling is filtered
   separately, per file, because the synced file may not travel even when its
   family is safe.

`src/platform/adobe-sync.ts` owns the rule for what a synced path looks like,
and matches the four-directory chain `Adobe/CoreSync/plugins/livetype` rather
than a `$HOME`-based prefix — the leaf differs by platform (`.r` vs `r`), both
filesystems are case-insensitive, and a relocated home would defeat a literal
prefix. The Rust side locates the store and reports paths; it does not classify
them. Keep those two in step.

**The positive case has never been observed on a real machine.** The `.r`
directory on the development Mac exists and is empty — nothing is activated in
Creative Cloud — so every test of a synced font drives hand-written paths of the
documented shape. Confirming it end to end needs a font activated in Creative
Cloud, then a rescan on the desktop build. The tests say so in their own
comments; do not quietly upgrade them to "verified".

Both halves of the original trap are still pinned by tests: Times New Roman
installed gets no flag, Proxima Nova missing still does.

### The catalogue may only ever assert POSITIVES

`fonts.adobe.com/fonts.json` reports 5,369 families, sends no CORS header
(so it is baked at build time, like the Google one), and **cannot be fully
enumerated**:

- page size is fixed at 12 — `limit` and `per_page` are ignored;
- it hard-caps at **page 200**, so the plain feed reaches exactly 2,400;
- `?filters=cl:xx` partitions it differently, but the 13 classification slices
  total 4,189 *before* dedup.

The build script unions the feed with every classification slice, which gets
closer, but completeness is not achievable from the public endpoint.

**Therefore a name that is absent means "unknown", never "not an Adobe font".**
`findAdobeFamily` returning null must stay silent in the UI. Do not add a
`definitelyNotAdobe` helper — the data cannot support one. The catalogue records
`libraryTotal` alongside `count` so the gap is visible in the data itself, and a
test asserts `count < libraryTotal` so the incompleteness cannot be forgotten.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
