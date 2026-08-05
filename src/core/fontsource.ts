import catalogue from '../data/fontsource-fonts.json'
import { normalizeKey, type ParsedFontName } from './names'
import type { FetchedFace } from './types'

/**
 * Fontsource, as a second download source — for the families Google does not
 * carry.
 *
 * Fontsource republishes ~2,100 open-source families, but ~1,976 of those are
 * Google Fonts and we already fetch those from the original repo files. The
 * shipped catalogue is filtered at build time down to the **120 families Google
 * does not have**: Adwaita, Aileron, Chunk Five, Bluu Next and similar. See
 * `scripts/build-fontsource-catalogue.mjs`.
 *
 * ## The trap this module is built around
 *
 * Fontsource's own documentation says its TTF files bundle every subset into
 * one file. **They do not.** Every file is `{subset}-{weight}-{style}.ttf`;
 * there is no full-range TTF (`400-normal.ttf` is a 404). That is the same
 * unicode-range subsetting that makes the Google CSS API useless to us — see
 * AGENTS.md §6 — and a subsetted font in a bundle is worse than nothing,
 * because it installs cleanly and then renders blanks outside its subset.
 *
 * The catalogue therefore only contains families declaring exactly **one**
 * subset, for which the single file is the entire font. The build script
 * enforces this, so a multi-subset family added upstream later is dropped
 * rather than silently shipped broken.
 *
 * ## CSP
 *
 * Downloads come from jsDelivr, so `public/_headers` must list
 * `cdn.jsdelivr.net` in `connect-src`. The dev server does not apply
 * `_headers`, so getting this wrong fails in production only — exactly the way
 * the `raw.githubusercontent.com` entry does.
 */

interface RawFamily {
  n: string
  /** Fontsource id, also the CDN path segment. */
  s: string
  /** The family's single subset, e.g. `latin`. */
  u: string
  c: string
  w: number[]
  i: number
  l: string
  v: number
}

const FAMILIES = (catalogue as { families: RawFamily[] }).families
export const FONTSOURCE_DATE = (catalogue as { generated: string }).generated
export const FONTSOURCE_COUNT = FAMILIES.length

const BY_KEY = new Map<string, RawFamily>()
for (const f of FAMILIES) BY_KEY.set(normalizeKey(f.n), f)

export interface FontsourceMatch {
  family: string
  /** True when the deck's name equals the Fontsource family name. */
  exact: boolean
  /** SPDX id — always one of the redistributable set, by construction. */
  license: string
  category?: string
  weights?: number[]
}

function toMatch(f: RawFamily, exact: boolean): FontsourceMatch {
  return {
    family: f.n,
    exact,
    license: f.l,
    category: f.c,
    weights: f.w,
  }
}

/** Exact family match, or null. */
export function findFontsourceFamily(parsed: ParsedFontName): FontsourceMatch | null {
  const byFamily = BY_KEY.get(normalizeKey(parsed.family))
  if (byFamily) {
    return toMatch(byFamily, normalizeKey(parsed.family) === normalizeKey(parsed.raw))
  }
  const byRaw = BY_KEY.get(normalizeKey(parsed.raw))
  if (byRaw) return toMatch(byRaw, true)
  return null
}

const CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'

/** Nearest published weight to the one the deck asked for. */
function nearest(weights: number[], wanted: number): number {
  if (weights.length === 0) return 400
  return weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]!)
}

/**
 * Download installable .ttf files for a Fontsource family.
 *
 * Filenames on the CDN are `{subset}-{weight}-{style}.ttf`, which is not a name
 * anyone wants in their font folder — `latin-400-normal.ttf` says nothing about
 * which font it is, and a bundle full of them is unusable. They are renamed to
 * the usual `Family-Weight.ttf` convention on the way out.
 */
export async function fetchFontsourceFaces(
  family: string,
  weights: number[],
  opts: { italics?: boolean; signal?: AbortSignal } = {},
): Promise<FetchedFace[]> {
  const rec = BY_KEY.get(normalizeKey(family))
  if (!rec) throw new Error(`${family} is not in the Fontsource catalogue.`)

  const styles: Array<'normal' | 'italic'> = opts.italics && rec.i ? ['normal', 'italic'] : ['normal']
  const wanted: Array<{ weight: number; style: 'normal' | 'italic' }> = []
  const seen = new Set<string>()

  for (const w of weights.length ? weights : [400]) {
    const weight = nearest(rec.w, w)
    for (const style of styles) {
      const key = `${weight}-${style}`
      if (seen.has(key)) continue
      seen.add(key)
      wanted.push({ weight, style })
    }
  }

  const out: FetchedFace[] = []
  for (const pick of wanted) {
    const url = `${CDN}/${rec.s}@latest/${rec.u}-${pick.weight}-${pick.style}.ttf`
    const res = await fetch(url, { signal: opts.signal })
    if (!res.ok) continue
    const data = new Uint8Array(await res.arrayBuffer())
    const stem = rec.n.replace(/\s+/g, '')
    const suffix = `${pick.weight}${pick.style === 'italic' ? 'Italic' : ''}`
    out.push({
      filename: `${stem}-${suffix}.ttf`,
      data,
      family: rec.n,
      weight: pick.weight,
      italic: pick.style === 'italic',
      license: rec.l,
      // Filtered out at build time; kept on the type for a uniform shape.
      variable: false,
    })
  }

  if (out.length === 0) throw new Error(`Could not download any face of ${family}.`)
  return out
}
