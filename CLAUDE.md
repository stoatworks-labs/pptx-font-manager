# CLAUDE.md — PowerPoint Font Manager

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 176 tests, offline (5 network-gated, see below; 13 need the private fixture decks)
npm run test:watch
npm run build        # tsc -b && vite build -> dist/
npm run preview      # serve the built dist/ (does NOT apply _headers)
npm run serve:dist   # serve dist/ WITH _headers applied — use this to check the CSP
npx tsc -b           # typecheck only
```

Network-dependent tests are opt-in — they hit the real google/fonts repo:

```bash
NETWORK_TESTS=1 npm test
```

Online video on the desktop (AGENTS.md §13) has two probes that run the app's
own Rust without the app, and a debug build takes two hooks that reach past the
Open and Save panels, which UI automation cannot drive:

```bash
cd src-tauri && cargo run --example fetch_probe -- <empty dir>         # fetch yt-dlp, ffmpeg, Deno, checksum-checked
cd src-tauri && cargo run --example download_probe -- <tools dir> <out dir> <url> [height]
npx tauri build --debug --bundles app
env -i HOME=$HOME PATH=/usr/bin:/bin PFM_DEBUG_OPEN=<deck> PFM_DEBUG_SAVE_DIR=<dir> \
  "src-tauri/target/debug/bundle/macos/PowerPoint Font Manager.app/Contents/MacOS/pptx-font-manager"
```

## Regenerating the font catalogues

```bash
node scripts/build-catalogue.mjs
```

Reads `fonts.google.com/metadata/fonts` and the `google/fonts` repo tree, writes
`src/data/google-fonts.json`. Re-run occasionally. The app works with a stale
catalogue, it just will not know about newly added families.

```bash
node scripts/build-fontsource-catalogue.mjs
```

Writes `src/data/fontsource-fonts.json` — the families Fontsource has and
Google does not. **Run it after the Google one**, since it reads
`google-fonts.json` to work out what to leave out.

## Deploy

Static-assets Worker, not Cloudflare Pages.

**Automatic.** `.github/workflows/deploy.yml` tests, builds, smoke-checks and
deploys on every push to `main` that touches something a visitor sees, then
verifies the live `<head>` hash matches the build. Doc-only pushes are skipped.

Needs `CLOUDFLARE_API_TOKEN` (repo secret) and `CLOUDFLARE_ACCOUNT_ID` (repo
variable). The workflow fails in one second with instructions if the token is
missing, rather than after a build.

Manual fallback, for when Actions is down:

```bash
cf-run npx wrangler deploy
```

**Do not connect a Cloudflare dashboard build.** None was ever connected — the
comment that used to be in `wrangler.toml` describing one was aspirational, and
it cost twelve commits sitting undeployed for sixteen days. Two things deploying
the same Worker is worse than one.

## Ground rules

- **`src/core/` must not touch the DOM.** It runs in vitest under the `node`
  environment and is meant to move into the Tauri desktop port unchanged.
  Browser-only code lives in `src/platform/`.
- **Do not widen the scanner to count every `typeface=`.** See AGENTS.md §2.1 —
  it inflates a 2-font deck to 39.
- **Do not switch font downloads to the Google CSS API.** It cannot return an
  installable file. See AGENTS.md §6.
- **Do not take Fontsource's word that its TTFs carry every subset.** They are
  subsetted per unicode-range, same as the CSS API. Only single-subset families
  are safe, and the build script enforces that. See AGENTS.md §10.
- **`public/_headers` CSP must allow `raw.githubusercontent.com` AND
  `cdn.jsdelivr.net`** in `connect-src`, or downloads fail in production only.
- **Decide download sources through `downloadPlan()`**, never by branching on
  `r.google` / `r.fontsource` at the call site.
- **Never add a fetch/download path to `src/core/adobe.ts`.** No such API
  exists and the licence forbids it. See AGENTS.md §11.
- **A miss in the Adobe catalogue means "unknown", not "not an Adobe font".**
  The public feed cannot be fully enumerated — 5,017 of 5,369.
- **Flag an INSTALLED Adobe font only on `installedViaAdobeSync`**, never on a
  catalogue hit — Adobe resells the Microsoft system fonts, so the name proves
  nothing and the CoreSync file path proves everything. See AGENTS.md §11.
- **Keep metric-compatible substitutes distinct from merely similar ones.**
  See AGENTS.md §9 — one preserves the deck's line breaks, the other does not.
- **Never collapse `saveSubsetFonts` into the measured coverage.** See
  AGENTS.md §5.1 — the flag says what PowerPoint will *allow*, the bytes say
  what will *render*, and Canva ships decks where they disagree.
- **Read OOXML booleans with `onOff()`, never `=== '1'`.** Office writes `1`,
  Canva writes `true`; a strict test loses every Canva deck silently.
- Test fixtures are private decks and stay gitignored — except the two
  generated ones, `synthetic.pptx` and `media.pptx`, and `online-video.pptx`,
  made in PowerPoint for Mac from a CC-BY video, which are committed.
  Regenerate the media one with `node scripts/make-media-deck.mjs` (needs
  ffmpeg; the suite does not).
- **Never bundle yt-dlp, ffmpeg or Deno.** Fetch the publisher's release and
  check the published SHA-256 first, and only ever replace the app's own copy.
  See AGENTS.md §13.
- **Pass ffmpeg and Deno to yt-dlp by path.** A Finder-launched app has a bare
  PATH and so does every yt-dlp it starts.
- **Media never goes through `unzipSync`.** Read it with `zipdir.ts`, which
  returns views into the deck for stored entries. A real show deck is 2 GB of
  video. See AGENTS.md §12.
- **Count a video per shape, not per relationship.** PowerPoint links every
  embedded clip twice (`a:videoFile` and `p14:media`). See AGENTS.md §12.
- **Slide numbers come from `<p:sldIdLst>`**, never from `slideN.xml` — the
  file names drift from show order the first time someone reorders a slide.
- **`rewriteZip` copies every unchanged entry byte for byte.** Do not "simplify"
  it into unzip + zip: that re-deflates the media and holds two copies of the
  deck in memory.

## Regenerating the Adobe recognition catalogue

```bash
node scripts/build-adobe-catalogue.mjs
```

Writes `src/data/adobe-fonts.json`. Takes several minutes — ~560 requests
against a site with no API contract, deliberately paced. Identify-only: nothing
in it can be downloaded.
