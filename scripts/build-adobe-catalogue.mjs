#!/usr/bin/env node
/**
 * Regenerate src/data/adobe-fonts.json — a **recognition-only** catalogue.
 *
 * ## Adobe is the one source that can never lead to a download
 *
 * Two independent reasons, either decisive on its own:
 *
 * 1. **There is no font-file endpoint.** The Typekit/Adobe Fonts API is still
 *    live — typekit.com/api/v1 answers 401, not 404 — but it does kit
 *    management and metadata only. Desktop faces reach a machine solely through
 *    Creative Cloud sync, into an obfuscated CoreSync directory. Signing in
 *    changes nothing, because there is nothing to sign in to.
 *
 * 2. **The licence forbids exactly what this app does.** Adobe's own
 *    documentation states the fonts "are not compatible with packaging
 *    workflows that involve transferring font files to another user or
 *    computer", and the terms do not permit copying font files or distributing
 *    them so others can use them directly. A sidecar .zip handed to a venue is
 *    that transfer.
 *
 * So this catalogue exists to let the app *name* the problem — "Proxima Nova is
 * an Adobe font; it is active on your machine and will not be on the venue's,
 * here is where they activate it". That is the most dangerous case the scanner
 * meets, because the deck works perfectly for its author and breaks everywhere
 * else. Same reasoning as AGENTS.md §5 on MTX-compressed embeds: reporting the
 * truth is the useful answer.
 *
 * ## This catalogue may only ever assert POSITIVES
 *
 * The public feed cannot be fully enumerated. `fonts.adobe.com/fonts.json`
 * reports 5,369 families but:
 *
 *   - page size is fixed at 12 (`limit` and `per_page` are ignored), and
 *   - it hard-caps at page 200, so the plain feed reaches only 2,400.
 *
 * `?filters=cl:xx` partitions it differently, but the 13 classification slices
 * total 4,189 *before* dedup, so even feed + slices is not provably complete.
 *
 * **Therefore "not in this catalogue" must never be rendered as "not an Adobe
 * font".** A miss is silence. `src/core/adobe.ts` is built that way and there
 * is a test pinning it.
 *
 *   node scripts/build-adobe-catalogue.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
const outFile = join(outDir, 'adobe-fonts.json')
const UA = { 'User-Agent': 'pptx-font-manager-build' }
const BASE = 'https://fonts.adobe.com/fonts.json'

/** ~560 requests against a site with no API contract. Do not hammer it. */
const DELAY_MS = 120

/** Classification facets, used to reach families the plain feed's cap hides. */
const CLASSIFICATIONS = [
  'cl:bl', 'cl:de', 'cl:do', 'cl:ds', 'cl:ha', 'cl:hm', 'cl:ms',
  'cl:sc', 'cl:se', 'cl:sl', 'cl:ss', 'cl:st', 'cl:yu',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPage(params, attempt = 0) {
  try {
    const res = await fetch(`${BASE}?${params}`, { headers: UA })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return await res.json()
  } catch (err) {
    // One bad page out of hundreds must not lose the whole run — the feed
    // returns a non-JSON error body intermittently under this much traffic.
    if (attempt >= 4) {
      console.warn(`  ! giving up on ${params}: ${err.message}`)
      return null
    }
    await sleep(500 * 2 ** attempt)
    return getPage(params, attempt + 1)
  }
}

/** slug -> record. Keyed by slug because slices overlap heavily. */
const bySlug = new Map()

function absorb(data) {
  for (const f of data?.families_data?.families ?? []) {
    if (!f?.name || !f?.slug || bySlug.has(f.slug)) continue
    bySlug.set(f.slug, {
      n: f.name,
      s: f.slug,
      // Disambiguates the many same-named revivals ("Garamond").
      y: f.foundry?.name ?? '',
      // A family with an open-source cut may also be obtainable from a source
      // that IS redistributable, so the app can point at that instead of
      // dead-ending on "activate this in Creative Cloud".
      o: f.has_open_source_fonts ? 1 : 0,
    })
  }
}

console.log('Fetching Adobe Fonts catalogue...')
const first = await getPage('page=1')
if (!first?.families_data?.families?.length) {
  throw new Error('Catalogue came back empty; refusing to write.')
}
const totalFamilies = first.families_data.totalFamilies ?? 0
const totalPages = Math.min(first.families_data.totalPages ?? 1, 200)
console.log(`  library reports ${totalFamilies} families; feed exposes ${totalPages} pages`)

absorb(first)
for (let page = 2; page <= totalPages; page++) {
  absorb(await getPage(`page=${page}`))
  if (page % 50 === 0) console.log(`  feed page ${page}/${totalPages} — ${bySlug.size} families`)
  await sleep(DELAY_MS)
}
console.log(`  plain feed done: ${bySlug.size} families`)

for (const cl of CLASSIFICATIONS) {
  const head = await getPage(`filters=${cl}`)
  if (!head) continue
  const pages = Math.min(head.families_data?.totalPages ?? 1, 200)
  absorb(head)
  for (let page = 2; page <= pages; page++) {
    absorb(await getPage(`filters=${cl}&page=${page}`))
    await sleep(DELAY_MS)
  }
  console.log(`  ${cl}: ${bySlug.size} families total`)
}

const families = [...bySlug.values()].sort((a, b) => a.n.localeCompare(b.n))
if (families.length === 0) throw new Error('Collected nothing; refusing to write.')

// A partial scrape silently replacing a good catalogue would make fonts start
// reporting as "not Adobe" — the one claim this data may never make. Full
// coverage is impossible, so guard against *regression* instead.
if (existsSync(outFile)) {
  const prev = JSON.parse(readFileSync(outFile, 'utf8')).count ?? 0
  if (families.length < prev * 0.9) {
    throw new Error(
      `Collected ${families.length}, down from ${prev} — refusing to overwrite with a worse catalogue.`,
    )
  }
}

mkdirSync(outDir, { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    count: families.length,
    /** What the library claims to hold, so the gap is visible in the data. */
    libraryTotal: totalFamilies,
    /** Recognition only — see the header. Nothing here can be downloaded. */
    downloadable: false,
    families,
  }),
)
console.log(
  `Wrote ${families.length} of ${totalFamilies} families to src/data/adobe-fonts.json ` +
    `(identify-only; a miss means "unknown", never "not Adobe")`,
)
