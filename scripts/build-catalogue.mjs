#!/usr/bin/env node
/**
 * Regenerate src/data/google-fonts.json.
 *
 * Two sources, both build-time:
 *
 * 1. fonts.google.com/metadata/fonts — family list, category, published
 *    weights. Sends **no** Access-Control-Allow-Origin header, so a browser
 *    cannot read it live; that is why this is baked.
 *
 * 2. The google/fonts repo tree — the real, complete static .ttf files and,
 *    from the directory they sit in, the actual licence (ofl / apache / ufl).
 *
 * ## Why not just download from the CSS API at runtime
 *
 * Because it does not give you an installable font. fonts.googleapis.com/css
 * and /css2 both serve **woff2** to any modern browser UA, and — worse — they
 * serve it **subsetted by unicode-range**: one file for latin, another for
 * latin-ext, another for devanagari. A browser cannot override its own
 * User-Agent on fetch, so there is no way to ask for the TTF. Installing a
 * subsetted woff2 gives you a font that appears to install and then renders
 * nothing outside its subset.
 *
 * raw.githubusercontent.com serves the complete original .ttf and sends
 * `Access-Control-Allow-Origin: *`, so that is what the app downloads from.
 *
 *   node scripts/build-catalogue.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
const UA = { 'User-Agent': 'pptx-font-manager-build' }

async function getJson(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

/** Directory key for a family name: lowercase, alphanumerics only. */
const dirKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

console.log('Fetching Google Fonts metadata...')
const meta = await getJson('https://fonts.google.com/metadata/fonts')
const list = meta.familyMetadataList ?? []
if (list.length === 0) throw new Error('Catalogue came back empty; refusing to write.')

console.log('Fetching google/fonts repo tree...')
const root = await getJson('https://api.github.com/repos/google/fonts/git/trees/main')
const LICENSES = { ofl: 'OFL-1.1', apache: 'Apache-2.0', ufl: 'UFL-1.0' }

/** dirKey -> { lic, dir, files: [...] } */
const repo = new Map()
for (const licDir of Object.keys(LICENSES)) {
  const node = root.tree.find((t) => t.path === licDir)
  if (!node) continue
  const tree = await getJson(
    `https://api.github.com/repos/google/fonts/git/trees/${node.sha}?recursive=1`,
  )
  if (tree.truncated) throw new Error(`Tree for ${licDir} was truncated; cannot build a reliable catalogue.`)
  for (const entry of tree.tree) {
    if (!entry.path.endsWith('.ttf')) continue
    const [dir, file] = entry.path.split('/')
    if (!dir || !file) continue
    const key = dirKey(dir)
    let rec = repo.get(key)
    if (!rec) {
      rec = { lic: licDir, dir, files: [] }
      repo.set(key, rec)
    }
    rec.files.push(file)
  }
  console.log(`  ${licDir}: ${tree.tree.filter((t) => t.path.endsWith('.ttf')).length} ttf files`)
}

let matched = 0
const families = list
  .map((f) => {
    const weights = [...new Set(Object.keys(f.fonts ?? {}).map((k) => parseInt(k, 10)))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    const italic = Object.keys(f.fonts ?? {}).some((k) => k.endsWith('i'))
    const rec = repo.get(dirKey(f.family))
    if (rec) matched++
    return {
      n: f.family,
      c: f.category ?? '',
      w: weights,
      i: italic ? 1 : 0,
      // Licence + repo path, present only when we found real files to fetch.
      l: rec ? LICENSES[rec.lic] : '',
      p: rec ? `${rec.lic}/${rec.dir}` : '',
      f: rec ? rec.files.sort() : [],
    }
  })
  .sort((a, b) => a.n.localeCompare(b.n))

mkdirSync(outDir, { recursive: true })
const out = {
  generated: new Date().toISOString().slice(0, 10),
  count: families.length,
  withFiles: matched,
  families,
}
writeFileSync(join(outDir, 'google-fonts.json'), JSON.stringify(out))
console.log(
  `Wrote ${families.length} families (${matched} with downloadable static TTFs) ` +
    `to src/data/google-fonts.json`,
)
