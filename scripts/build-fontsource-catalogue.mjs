#!/usr/bin/env node
/**
 * Regenerate src/data/fontsource-fonts.json.
 *
 * Fontsource (fontsource.org) republishes ~2,100 open-source families. Around
 * 1,976 of them are Google Fonts, which we already have from a better source,
 * so this catalogue keeps only the **~120 that Google does not carry** —
 * Adwaita, Aileron, Chunk Five, Bluu Next and similar.
 *
 * ## The trap: every Fontsource TTF is unicode-range subsetted
 *
 * The Fontsource docs state that its TTF files "include all subsets in one
 * file". **That is not true**, and believing it would reintroduce exactly the
 * bug AGENTS.md §6 exists to prevent. Checked against the live CDN:
 *
 *     inter@latest/latin-400-normal.ttf   200, 66,912 bytes   <- latin only
 *     inter@latest/400-normal.ttf         404
 *     inter@latest/full-400-normal.ttf    404
 *
 * Every file is `{subset}-{weight}-{style}.ttf`. There is no full-range TTF.
 * A subsetted font in a bundle is worse than nothing: it installs without
 * complaint and then renders blanks outside its subset.
 *
 * ## Why it is nonetheless safe for the families we keep
 *
 * A family declaring exactly **one** subset has nothing to lose to subsetting —
 * its single `latin` file *is* the whole font. At the time of writing all 120
 * non-Google families are single-subset, so all 120 are usable.
 *
 * `SINGLE_SUBSET_ONLY` below enforces that rather than assuming it, so if
 * Fontsource ever adds a multi-subset family from a non-Google source it is
 * dropped instead of silently shipping a broken font.
 *
 * Both api.fontsource.org and the jsDelivr CDN send
 * `Access-Control-Allow-Origin: *`, so unlike the Google catalogue the metadata
 * *could* be read live — this is baked purely to keep matching offline and
 * instant.
 *
 *   node scripts/build-fontsource-catalogue.mjs
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
const UA = { 'User-Agent': 'pptx-font-manager-build' }
const API = 'https://api.fontsource.org/v1'

/** See the header — a multi-subset family would ship a partial font. */
const SINGLE_SUBSET_ONLY = true

/** Licences that permit putting the file in a bundle handed to someone else. */
const REDISTRIBUTABLE = new Set([
  'OFL-1.1',
  'Apache-2.0',
  'UFL-1.0',
  'CC0-1.0',
  'MIT',
  'Unlicense',
])

async function getJson(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

const key = (s) =>
  s
    .toLowerCase()
    .replace(/[_\-,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Google family names, plus the forms a Fontsource name can collapse into once
 * `parseFontName` has stripped a trailing style word.
 *
 * Fontsource publishes some single-style cuts as their own family — `Syne
 * Italic` is a real entry. The app's name parser reduces that to `Syne`, which
 * Google already has, so keeping it would add a duplicate that can never win
 * the precedence check anyway. Better to leave it out than to ship a catalogue
 * entry that is dead by construction.
 */
const googleKeys = new Set(
  JSON.parse(readFileSync(join(outDir, 'google-fonts.json'), 'utf8')).families.map((f) => key(f.n)),
)

const STYLE_TAIL =
  /\s+(thin|extra ?light|ultra ?light|light|regular|normal|book|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy|italic|oblique)$/i

function collidesWithGoogle(name) {
  if (googleKeys.has(key(name))) return true
  const stripped = name.replace(STYLE_TAIL, '')
  return stripped !== name && googleKeys.has(key(stripped))
}

console.log('Fetching Fontsource catalogue...')
const all = await getJson(`${API}/fonts`)
if (!Array.isArray(all) || all.length === 0) {
  throw new Error('Catalogue came back empty; refusing to write.')
}
console.log(`  ${all.length} families total`)

// `type: 'google'` families are already covered, from the original repo files
// rather than Fontsource's subsetted republish.
const candidates = all.filter((f) => f.type !== 'google')
console.log(`  ${candidates.length} not from Google Fonts`)

const families = []
const skipped = []

for (const f of candidates) {
  const subsets = f.subsets ?? []
  const licence = (f.license ?? '').toUpperCase() === 'MIT' ? 'MIT' : f.license

  if (SINGLE_SUBSET_ONLY && subsets.length !== 1) {
    skipped.push(`${f.family}: ${subsets.length} subsets, TTF would be partial`)
    continue
  }
  if (!REDISTRIBUTABLE.has(licence)) {
    skipped.push(`${f.family}: licence ${f.license} is not known-redistributable`)
    continue
  }
  if (collidesWithGoogle(f.family)) {
    skipped.push(`${f.family}: collapses to a family Google Fonts already has`)
    continue
  }

  families.push({
    n: f.family,
    // Fontsource id, which is also the CDN path segment.
    s: f.id,
    // The one subset, needed to build a file URL.
    u: subsets[0],
    c: f.category ?? '',
    w: (f.weights ?? []).slice().sort((a, b) => a - b),
    i: (f.styles ?? []).includes('italic') ? 1 : 0,
    l: licence,
    v: f.variable ? 1 : 0,
  })
}

families.sort((a, b) => a.n.localeCompare(b.n))

if (families.length === 0) throw new Error('Nothing survived filtering; refusing to write.')

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'fontsource-fonts.json'),
  JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    count: families.length,
    families,
  }),
)

console.log(`Wrote ${families.length} families to src/data/fontsource-fonts.json`)
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length}:`)
  for (const s of skipped) console.log(`  ${s}`)
}
