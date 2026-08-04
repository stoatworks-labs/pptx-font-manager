# CLAUDE.md — PowerPoint Font Manager

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 43 tests, offline
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

## Regenerating the Google Fonts catalogue

```bash
node scripts/build-catalogue.mjs
```

Reads `fonts.google.com/metadata/fonts` and the `google/fonts` repo tree, writes
`src/data/google-fonts.json`. Re-run occasionally. The app works with a stale
catalogue, it just will not know about newly added families.

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
- **`public/_headers` CSP must allow `raw.githubusercontent.com`** in
  `connect-src`, or downloads fail in production only.
- Test fixtures are private decks and stay gitignored.
