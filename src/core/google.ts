import catalogue from '../data/google-fonts.json'
import { normalizeKey, type ParsedFontName } from './names'
import type { GoogleMatch } from './types'

/**
 * Matching deck fonts against Google Fonts, and fetching the files.
 *
 * The catalogue is a build-time snapshot (see scripts/build-catalogue.mjs) —
 * the metadata endpoint sends no CORS header so a browser cannot read it live.
 * Downloads, by contrast, happen at runtime: both fonts.googleapis.com/css2
 * and fonts.gstatic.com send `Access-Control-Allow-Origin: *`.
 */

interface RawFamily {
  n: string
  c: string
  w: number[]
  i: number
  /** SPDX licence id, e.g. `OFL-1.1`. Empty when no repo files were found. */
  l: string
  /** Repo path, e.g. `ofl/poppins`. */
  p: string
  /** Static .ttf filenames in that directory. */
  f: string[]
}

const FAMILIES = (catalogue as { families: RawFamily[] }).families
export const CATALOGUE_DATE = (catalogue as { generated: string }).generated
export const CATALOGUE_COUNT = FAMILIES.length

const BY_KEY = new Map<string, RawFamily>()
for (const f of FAMILIES) BY_KEY.set(normalizeKey(f.n), f)

/**
 * Licence comes from the directory the files live in under google/fonts —
 * `ofl/`, `apache/` or `ufl/`. All three permit redistribution, which is what
 * makes these safe to put in a sidecar bundle that gets handed to a venue.
 */
function toMatch(f: RawFamily, exact: boolean): GoogleMatch {
  return {
    family: f.n,
    exact,
    license: f.l || 'Unknown',
    category: f.c,
    weights: f.w,
    downloadable: f.f.length > 0,
  }
}

/** Exact family match, or null. */
export function findGoogleFamily(parsed: ParsedFontName): GoogleMatch | null {
  const byFamily = BY_KEY.get(normalizeKey(parsed.family))
  if (byFamily) return toMatch(byFamily, normalizeKey(parsed.family) === normalizeKey(parsed.raw))
  const byRaw = BY_KEY.get(normalizeKey(parsed.raw))
  if (byRaw) return toMatch(byRaw, true)
  return null
}

/**
 * Near matches, for when a font is missing and not on Google Fonts.
 *
 * Token overlap rather than edit distance: the useful suggestions are
 * "Garamond" -> "EB Garamond" / "Cormorant Garamond", which share a whole word
 * but are far apart by character edits. Ranked by how much of the wanted name
 * the candidate covers, shortest name winning ties so the plainest option
 * comes first.
 */
export function suggestGoogleFamilies(parsed: ParsedFontName, limit = 3): GoogleMatch[] {
  const wanted = normalizeKey(parsed.family)
  const wantedTokens = new Set(wanted.split(' ').filter((t) => t.length > 2))
  if (wantedTokens.size === 0) return []

  const scored: Array<{ f: RawFamily; score: number }> = []
  for (const f of FAMILIES) {
    const key = normalizeKey(f.n)
    if (key === wanted) continue
    const tokens = key.split(' ')
    let hits = 0
    for (const t of tokens) if (wantedTokens.has(t)) hits++
    if (hits === 0) continue
    // Prefer families that cover more of what was asked for, and are not
    // padded out with extra words.
    const score = hits / wantedTokens.size - (tokens.length - hits) * 0.08
    scored.push({ f, score })
  }

  scored.sort((a, b) => b.score - a.score || a.f.n.length - b.f.n.length)
  return scored.slice(0, limit).map(({ f }) => toMatch(f, false))
}

/** Nearest published weight to the one the deck asked for. */
export function nearestWeight(match: GoogleMatch, wanted: number): number {
  const weights = match.weights?.length ? match.weights : [400]
  return weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]!)
}

/* ------------------------------------------------------------------ */
/* Downloading                                                         */
/* ------------------------------------------------------------------ */


const RAW_BASE = 'https://raw.githubusercontent.com/google/fonts/main'

/** Style token as it appears in a static filename, e.g. `Poppins-SemiBold.ttf`. */
const STYLE_WEIGHTS: Array<[string, number]> = [
  ['Thin', 100],
  ['ExtraLight', 200],
  ['UltraLight', 200],
  ['Light', 300],
  ['Regular', 400],
  ['Medium', 500],
  ['SemiBold', 600],
  ['DemiBold', 600],
  ['ExtraBold', 800],
  ['UltraBold', 800],
  ['Bold', 700],
  ['Black', 900],
  ['Heavy', 900],
]

interface RepoFile {
  file: string
  weight: number
  italic: boolean
  /** `Family[wght].ttf` — one file covering the whole weight axis. */
  variable: boolean
}

function describeFile(file: string): RepoFile {
  const base = file.replace(/\.ttf$/i, '')
  const variable = /\[[^\]]+\]$/.test(base)
  const stem = base.replace(/\[[^\]]+\]$/, '')
  const suffix = stem.includes('-') ? stem.slice(stem.indexOf('-') + 1) : ''
  const italic = /italic/i.test(suffix)
  const withoutItalic = suffix.replace(/italic/i, '')

  let weight = 400
  for (const [token, w] of STYLE_WEIGHTS) {
    if (withoutItalic.toLowerCase() === token.toLowerCase()) {
      weight = w
      break
    }
  }
  return { file, weight, italic, variable }
}

/**
 * Pick the best file for a wanted weight/style.
 *
 * Variable fonts (`EBGaramond[wght].ttf`) are one file spanning every weight,
 * so they satisfy any request on their axis. Static files are preferred when
 * one matches, because they are unambiguous to a system font installer.
 */
function pickFiles(files: string[], wantWeight: number, wantItalic: boolean): RepoFile[] {
  const described = files.map(describeFile)
  const statics = described.filter((d) => !d.variable && d.italic === wantItalic)

  if (statics.length > 0) {
    const best = statics.reduce((a, b) =>
      Math.abs(b.weight - wantWeight) < Math.abs(a.weight - wantWeight) ? b : a,
    )
    return [best]
  }

  const variables = described.filter((d) => d.variable && d.italic === wantItalic)
  if (variables.length > 0) return [variables[0]!]

  const uprights = described.filter((d) => !d.italic)
  return uprights.length > 0 ? [uprights[0]!] : described.slice(0, 1)
}

export interface FetchedFace {
  filename: string
  data: Uint8Array
  family: string
  weight: number
  italic: boolean
  /** SPDX id, from the licence directory the file lives in. */
  license: string
  /** True when the file is a variable font covering multiple weights. */
  variable: boolean
}

/**
 * Download installable .ttf files for a Google family.
 *
 * Source is raw.githubusercontent.com/google/fonts: the original, complete,
 * unsubsetted files, served with `Access-Control-Allow-Origin: *`.
 *
 * Deliberately NOT the CSS API. fonts.googleapis.com/css and /css2 both serve
 * **woff2** to any modern browser UA, subsetted by `unicode-range` into
 * separate latin / latin-ext / devanagari files. A browser cannot override its
 * own User-Agent on fetch, so there is no way to ask them for a TTF. A
 * subsetted woff2 in a font bundle is worse than nothing: it installs without
 * complaint and then renders blanks outside its subset.
 */
export async function fetchGoogleFaces(
  family: string,
  weights: number[],
  opts: { italics?: boolean; signal?: AbortSignal } = {},
): Promise<FetchedFace[]> {
  const rec = BY_KEY.get(normalizeKey(family))
  if (!rec) throw new Error(`${family} is not in the Google Fonts catalogue.`)
  if (!rec.p || rec.f.length === 0) {
    throw new Error(`${family} has no downloadable static files in the Google Fonts repo.`)
  }

  const wanted: RepoFile[] = []
  const seen = new Set<string>()
  const styles = opts.italics ? [false, true] : [false]
  for (const w of weights.length ? weights : [400]) {
    for (const italic of styles) {
      for (const pick of pickFiles(rec.f, w, italic)) {
        if (seen.has(pick.file)) continue
        seen.add(pick.file)
        wanted.push(pick)
      }
    }
  }

  const out: FetchedFace[] = []
  for (const pick of wanted) {
    const url = `${RAW_BASE}/${rec.p}/${encodeURIComponent(pick.file)}`
    const res = await fetch(url, { signal: opts.signal })
    if (!res.ok) continue
    const data = new Uint8Array(await res.arrayBuffer())
    out.push({
      filename: pick.file,
      data,
      family: rec.n,
      weight: pick.weight,
      italic: pick.italic,
      license: rec.l || 'Unknown',
      variable: pick.variable,
    })
  }
  if (out.length === 0) throw new Error(`Could not download any face of ${family}.`)
  return out
}

/** URL of the licence text shipped with a family, for the bundle manifest. */
export function licenseUrl(family: string): string | null {
  const rec = BY_KEY.get(normalizeKey(family))
  if (!rec?.p) return null
  const file = rec.p.startsWith('ufl/')
    ? 'UFL.txt'
    : rec.p.startsWith('apache/')
      ? 'LICENSE.txt'
      : 'OFL.txt'
  return `${RAW_BASE}/${rec.p}/${file}`
}
