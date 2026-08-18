# CLAUDE.md — PowerPoint Font Manager

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 125 tests, offline (5 network-gated, see below)
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

```bash
cf-run npx wrangler deploy
```

Or connect the repo in the Cloudflare dashboard: build `npm ci && npm run build`,
deploy `npx wrangler deploy`.

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
- Test fixtures are private decks and stay gitignored.

## Regenerating the Adobe recognition catalogue

```bash
node scripts/build-adobe-catalogue.mjs
```

Writes `src/data/adobe-fonts.json`. Takes several minutes — ~560 requests
against a site with no API contract, deliberately paced. Identify-only: nothing
in it can be downloaded.
