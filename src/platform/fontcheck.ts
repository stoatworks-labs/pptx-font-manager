import type { DetectMethod } from '../core/types'

/**
 * Finding out which fonts are installed, from a web page.
 *
 * Two mechanisms, in order of preference:
 *
 * 1. **Local Font Access API** (`queryLocalFonts`) — Chromium 103+, secure
 *    context, behind a permission prompt that requires a user gesture. Gives
 *    exact family names, full names, PostScript names, and a `blob()` handle to
 *    the actual font file. That last part is what lets the bundle include a
 *    font the user already has.
 *
 * 2. **Canvas metric probing** — works everywhere, needs no permission, and
 *    cannot enumerate: it can only answer "is *this specific name* present?".
 *    The classic technique: render a string in the candidate font with each of
 *    the three generic families as fallback, and compare widths against the
 *    generic families alone. A difference means the candidate resolved to
 *    something real.
 *
 * The fallback was checked against CoreText ground truth on this machine for
 * nine fonts (Helvetica Neue, Poppins, Times New Roman, Gill Sans installed;
 * Calibri, Corbel, Garamond, Canva Sans and a control absent) and agreed on
 * all nine. It is reliable enough to be the default path — we only ask for the
 * permission prompt when the user wants the extra capability.
 */

export interface LocalFontRecord {
  postscriptName: string
  fullName: string
  family: string
  style: string
  blob?: () => Promise<Blob>
}

export interface FontInventory {
  method: DetectMethod
  /** Distinct family names. Empty when using canvas probing. */
  families: Set<string>
  /** Full and PostScript names. Empty when using canvas probing. */
  faces: Set<string>
  /** Present only with the Local Font Access API. */
  records?: LocalFontRecord[]
  /**
   * Families whose files live in the Creative Cloud CoreSync store rather than
   * with the system fonts — installed here, and absent anywhere without a
   * subscription. See `./adobe-sync.ts`.
   *
   * Desktop only: enumerating this needs font file paths, and no browser API
   * exposes one. Absent means "not known", never "none" — it only ever gates a
   * warning, so the browser build simply stays quiet.
   */
  adobeSynced?: Set<string>
  /** Set when enumeration is impossible and callers must probe by name. */
  probe?: (name: string) => boolean
}

declare global {
  interface Window {
    queryLocalFonts?: (opts?: { postscriptNames?: string[] }) => Promise<LocalFontRecord[]>
  }
}

export function hasLocalFontAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function'
}

/**
 * Request the full local font list. Must be called from a user gesture — the
 * permission prompt is gated on one, and calling without it rejects.
 */
export async function queryLocalFontInventory(): Promise<FontInventory> {
  if (!hasLocalFontAccess()) throw new Error('Local Font Access API is not available in this browser.')
  const records = await window.queryLocalFonts!()
  const families = new Set<string>()
  const faces = new Set<string>()
  for (const r of records) {
    if (r.family) families.add(r.family)
    if (r.fullName) faces.add(r.fullName)
    if (r.postscriptName) faces.add(r.postscriptName)
  }
  return { method: 'local-font-access', families, faces, records }
}

/* ------------------------------------------------------------------ */
/* Canvas probing                                                      */
/* ------------------------------------------------------------------ */

const PROBE_TEXT = 'mmmmmmmmmmlliWWMMÀÿ0123456789'
const PROBE_SIZE = 72
const GENERICS = ['monospace', 'serif', 'sans-serif'] as const

let ctx: CanvasRenderingContext2D | null = null
function context(): CanvasRenderingContext2D {
  if (!ctx) {
    const canvas = document.createElement('canvas')
    canvas.width = 10
    canvas.height = 10
    const c = canvas.getContext('2d')
    if (!c) throw new Error('Canvas 2D context unavailable; cannot detect fonts.')
    ctx = c
  }
  return ctx
}

function widthWith(fontSpec: string): number {
  const c = context()
  c.font = `${PROBE_SIZE}px ${fontSpec}`
  return c.measureText(PROBE_TEXT).width
}

let baselines: Record<string, number> | null = null
function genericBaselines(): Record<string, number> {
  if (!baselines) {
    baselines = {}
    for (const g of GENERICS) baselines[g] = widthWith(g)
  }
  return baselines
}

/** CSS font-family value: quote unless it is a bare generic. */
function quoteFamily(name: string): string {
  return `"${name.replace(/["\\]/g, '')}"`
}

/**
 * Is `name` installed? Probes against all three generic fallbacks.
 *
 * A font is considered present if rendering with it produces a width that
 * differs from the generic fallback for **any** of the three. Requiring all
 * three to differ would miss fonts that happen to be metric-compatible with
 * one generic; requiring only one keeps false negatives down, and the
 * threshold guards against sub-pixel noise.
 */
export function probeFontInstalled(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const base = genericBaselines()
  for (const g of GENERICS) {
    const w = widthWith(`${quoteFamily(trimmed)}, ${g}`)
    if (Math.abs(w - base[g]!) > 0.5) return true
  }
  return false
}

/** Inventory that answers by probing. Cannot enumerate. */
export function canvasInventory(): FontInventory {
  const cache = new Map<string, boolean>()
  return {
    method: 'canvas-metrics',
    families: new Set(),
    faces: new Set(),
    probe: (name: string) => {
      const key = name.toLowerCase()
      let hit = cache.get(key)
      if (hit === undefined) {
        hit = probeFontInstalled(name)
        cache.set(key, hit)
      }
      return hit
    },
  }
}

/**
 * Default inventory: canvas probing, no permission prompt.
 *
 * Callers upgrade to `queryLocalFontInventory()` from a click when the user
 * asks for it.
 */
export function defaultInventory(): FontInventory {
  return canvasInventory()
}
