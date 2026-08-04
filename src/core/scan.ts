import { unzipSync, strFromU8 } from 'fflate'
import { walkTags } from './xml'
import { parseFontName, normalizeKey } from './names'
import { parseEot, isBareSfnt, extractSfnt } from './eot'
import type {
  DeckFont,
  EmbeddedFont,
  ExtractedFace,
  FontOrigin,
  ScanResult,
  ScanWarning,
  ScriptSlot,
  UsageTier,
} from './types'

/**
 * Scan a .pptx/.potx/.ppsx for the fonts it actually uses.
 *
 * ## The thing this file exists to get right
 *
 * A naive `typeface="..."` grep over the zip is catastrophically wrong. On the
 * three real decks used as fixtures it reports **39, 36 and 9** distinct
 * typefaces where the true answers are 2–5. The noise comes from one place:
 *
 * ```xml
 * <a:fontScheme name="Office">
 *   <a:minorFont>
 *     <a:latin typeface="Calibri"/>        <-- the actual theme font
 *     <a:font script="Jpan" typeface="..."/>   <-- ~30 of these
 *     <a:font script="Deva" typeface="Mangal"/>
 * ```
 *
 * Those `<a:font script="...">` entries are the *script fallback table*: what
 * to reach for if the document ever contains Devanagari or Khmer. They are
 * present in every Office-authored theme whether or not the deck contains a
 * single non-Latin character. A scanner that counts them tells the user to go
 * and install Mongolian Baiti, DokChampa and Iskoola Pota. We collect them
 * separately as `ignoredFallbacks` and never treat them as used.
 *
 * ## The second correctness pillar
 *
 * Most text on a slide carries no explicit typeface — it inherits, and the run
 * properties instead say `typeface="+mn-lt"`. One fixture deck has 45 such
 * references and zero explicit body fonts. Resolving `+mj-*`/`+mn-*` through
 * the theme that the slide's layout's master points at is the difference
 * between "this deck uses no fonts" and "this deck needs Helvetica Neue".
 */

const SLOTS: Record<string, ScriptSlot> = {
  latin: 'latin',
  ea: 'ea',
  cs: 'cs',
  sym: 'sym',
}

/** `+mj-lt` -> major/latin, `+mn-ea` -> minor/ea. */
const THEME_REF_RE = /^\+(mj|mn)-(lt|ea|cs)$/

const THEME_SLOT: Record<string, ScriptSlot> = { lt: 'latin', ea: 'ea', cs: 'cs' }

interface ThemeScheme {
  major: Partial<Record<ScriptSlot, string>>
  minor: Partial<Record<ScriptSlot, string>>
}

type Zip = Record<string, Uint8Array>

function textOf(zip: Zip, part: string): string | null {
  const data = zip[part]
  if (!data) return null
  try {
    return strFromU8(data)
  } catch {
    return null
  }
}

/**
 * Parse `_rels/<name>.rels` for a part, returning target paths by
 * relationship type suffix (e.g. `slideLayout`, `slideMaster`, `theme`).
 */
function relsFor(zip: Zip, part: string): Array<{ id: string; type: string; target: string }> {
  const slash = part.lastIndexOf('/')
  const dir = slash === -1 ? '' : part.slice(0, slash)
  const file = slash === -1 ? part : part.slice(slash + 1)
  const relPath = `${dir}/_rels/${file}.rels`
  const xml = textOf(zip, relPath)
  if (!xml) return []
  const out: Array<{ id: string; type: string; target: string }> = []
  for (const tag of walkTags(xml)) {
    if (tag.local !== 'Relationship' || tag.close) continue
    const target = tag.attrs.Target
    const type = tag.attrs.Type ?? ''
    if (!target) continue
    out.push({
      id: tag.attrs.Id ?? '',
      type: type.slice(type.lastIndexOf('/') + 1),
      target: resolvePath(dir, target),
    })
  }
  return out
}

/** Resolve a rels Target (often `../theme/theme1.xml`) against its part's dir. */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const stack = baseDir ? baseDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

/**
 * Read a theme's font scheme, keeping only the real major/minor faces and
 * discarding the script fallback table.
 */
function parseThemeScheme(xml: string, ignored: Set<string>): ThemeScheme {
  const scheme: ThemeScheme = { major: {}, minor: {} }
  // Track where we are: inside majorFont, minorFont, or neither.
  let bucket: 'major' | 'minor' | null = null
  let inFontScheme = false

  for (const tag of walkTags(xml)) {
    if (tag.local === 'fontScheme') {
      inFontScheme = !tag.close
      if (tag.close) bucket = null
      continue
    }
    if (!inFontScheme) continue

    if (tag.local === 'majorFont') {
      bucket = tag.close ? null : 'major'
      continue
    }
    if (tag.local === 'minorFont') {
      bucket = tag.close ? null : 'minor'
      continue
    }
    if (!bucket || tag.close) continue

    const typeface = tag.attrs.typeface
    if (!typeface) continue

    // `<a:font script="Jpan" .../>` — the fallback table. Never a used font.
    if (tag.local === 'font') {
      if (tag.attrs.script) ignored.add(typeface)
      continue
    }

    const slot = SLOTS[tag.local]
    if (slot && typeface.trim()) scheme[bucket][slot] = typeface.trim()
  }
  return scheme
}

interface RawRef {
  typeface: string
  slot: ScriptSlot
  part: string
  themeRef?: string
}

/**
 * Collect typeface references from a content part, skipping anything inside a
 * `<a:fontScheme>` (a slideMaster can carry an override scheme with its own
 * fallback table, and those are noise for exactly the same reason).
 */
function collectRefs(xml: string, part: string): RawRef[] {
  const refs: RawRef[] = []
  let fontSchemeDepth = 0

  for (const tag of walkTags(xml)) {
    if (tag.local === 'fontScheme') {
      if (tag.close) fontSchemeDepth = Math.max(0, fontSchemeDepth - 1)
      else if (!tag.selfClose) fontSchemeDepth++
      continue
    }
    if (fontSchemeDepth > 0) continue
    if (tag.close) continue

    const slot = SLOTS[tag.local]
    if (!slot) continue
    const typeface = tag.attrs.typeface?.trim()
    if (!typeface) continue

    if (THEME_REF_RE.test(typeface)) {
      refs.push({ typeface: '', slot, part, themeRef: typeface })
    } else {
      refs.push({ typeface, slot, part })
    }
  }
  return refs
}

function tierForPart(part: string, usedLayouts: Set<string>, usedMasters: Set<string>): UsageTier {
  if (part.startsWith('ppt/slides/')) return 'slide'
  if (part.startsWith('ppt/slideLayouts/')) return usedLayouts.has(part) ? 'inherited' : 'elsewhere'
  if (part.startsWith('ppt/slideMasters/')) return usedMasters.has(part) ? 'inherited' : 'elsewhere'
  return 'elsewhere'
}

const TIER_RANK: Record<UsageTier, number> = { slide: 0, inherited: 1, elsewhere: 2 }

export function scanPptx(file: Uint8Array): ScanResult {
  const warnings: ScanWarning[] = []

  // A legacy binary .ppt is not a zip and has no OOXML inside it.
  if (!(file[0] === 0x50 && file[1] === 0x4b)) {
    throw new Error(
      'This is not a .pptx file. Legacy binary .ppt presentations are not supported — ' +
        'open it in PowerPoint or Keynote and save as .pptx first.',
    )
  }

  let zip: Zip
  try {
    // Only inflate what we read. Decks are overwhelmingly media by volume —
    // one of the fixtures is 331 MB, of which the XML is well under 1%.
    // Inflating the video and images would blow browser memory for nothing.
    zip = unzipSync(file, {
      filter: (f) =>
        f.name.endsWith('.xml') || f.name.endsWith('.rels') || f.name.endsWith('.fntdata'),
    })
  } catch (e) {
    throw new Error(`Could not read the presentation archive: ${(e as Error).message}`)
  }

  const parts = Object.keys(zip)
  const slideParts = parts
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort(numericPartSort)

  if (slideParts.length === 0) {
    warnings.push({
      code: 'no-slides',
      message: 'No slides found. If this is a template (.potx) that is expected.',
    })
  }

  // ---- 1. Walk the inheritance graph: slide -> layout -> master -> theme ----
  const usedLayouts = new Set<string>()
  const usedMasters = new Set<string>()
  /** Content part -> the theme part that resolves its +mj-/+mn- references. */
  const themeForPart = new Map<string, string>()

  const layoutToMaster = new Map<string, string>()
  const masterToTheme = new Map<string, string>()

  for (const p of parts) {
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p)) {
      const m = relsFor(zip, p).find((r) => r.type === 'slideMaster')
      if (m) layoutToMaster.set(p, m.target)
    } else if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p)) {
      const t = relsFor(zip, p).find((r) => r.type === 'theme')
      if (t) masterToTheme.set(p, t.target)
    }
  }

  for (const slide of slideParts) {
    const layout = relsFor(zip, slide).find((r) => r.type === 'slideLayout')?.target
    if (!layout) continue
    usedLayouts.add(layout)
    const master = layoutToMaster.get(layout)
    if (!master) continue
    usedMasters.add(master)
    const theme = masterToTheme.get(master)
    if (!theme) continue
    themeForPart.set(slide, theme)
    themeForPart.set(layout, theme)
    themeForPart.set(master, theme)
  }
  for (const [master, theme] of masterToTheme) {
    if (!themeForPart.has(master)) themeForPart.set(master, theme)
  }
  for (const [layout, master] of layoutToMaster) {
    const theme = masterToTheme.get(master)
    if (theme && !themeForPart.has(layout)) themeForPart.set(layout, theme)
  }

  // ---- 2. Theme font schemes ----
  const ignoredFallbacks = new Set<string>()
  const themes: Record<string, ThemeScheme> = {}
  for (const p of parts) {
    if (!/^ppt\/theme\/theme\d+\.xml$/.test(p)) continue
    const xml = textOf(zip, p)
    if (!xml) {
      warnings.push({ code: 'unreadable-part', message: 'Theme part could not be read.', part: p })
      continue
    }
    themes[p] = parseThemeScheme(xml, ignoredFallbacks)
  }
  if (Object.keys(themes).length === 0) {
    warnings.push({ code: 'no-theme', message: 'No theme found; inherited fonts cannot be resolved.' })
  }

  const defaultTheme = themeForPart.get(slideParts[0] ?? '') ?? Object.keys(themes)[0]

  // ---- 3. Embedded fonts ----
  const embedded: EmbeddedFont[] = []
  const embeddedByName = new Map<string, EmbeddedFont>()
  const presXml = textOf(zip, 'ppt/presentation.xml')
  if (presXml) {
    const presRels = relsFor(zip, 'ppt/presentation.xml')
    const relTarget = new Map(presRels.map((r) => [r.id, r.target]))
    let current: EmbeddedFont | null = null
    for (const tag of walkTags(presXml)) {
      if (tag.local === 'embeddedFont' && !tag.close) {
        current = { typeface: '', parts: [], compressed: false }
        continue
      }
      if (tag.local === 'embeddedFont' && tag.close) {
        if (current && current.typeface) {
          embedded.push(current)
          embeddedByName.set(normalizeKey(current.typeface), current)
        }
        current = null
        continue
      }
      if (!current || tag.close) continue
      if (tag.local === 'font' && tag.attrs.typeface) {
        current.typeface = tag.attrs.typeface
        continue
      }
      // <p:regular r:id="rId2"/>, <p:bold .../>, <p:italic .../>, <p:boldItalic .../>
      if (['regular', 'bold', 'italic', 'boldItalic'].includes(tag.local)) {
        const rid = tag.attrs['r:id'] ?? tag.attrs.id
        const target = rid ? relTarget.get(rid) : undefined
        if (target) current.parts.push(target)
      }
    }
  }
  // Inspect the payload of each embedded part: report what it is, and recover
  // an installable file where the format allows it.
  for (const ef of embedded) {
    const extracted: ExtractedFace[] = []
    for (const part of ef.parts) {
      const data = zip[part]
      if (!data) continue
      const eot = parseEot(data)
      if (eot) {
        ef.compressed ||= eot.compressed
        ef.fsType ??= eot.fsType
      } else if (isBareSfnt(data)) {
        ef.compressed = false
      }
      const sfnt = extractSfnt(data)
      if (sfnt) {
        extracted.push({ filename: faceFilename(ef.typeface, part, sfnt), data: sfnt, part })
      }
    }
    if (extracted.length) ef.extracted = extracted
  }

  // ---- 4. Collect references from every content part ----
  const contentParts = parts.filter(
    (p) =>
      p.endsWith('.xml') &&
      !p.includes('/_rels/') &&
      !/^ppt\/theme\/theme\d+\.xml$/.test(p) &&
      (p.startsWith('ppt/slides/') ||
        p.startsWith('ppt/slideLayouts/') ||
        p.startsWith('ppt/slideMasters/') ||
        p.startsWith('ppt/notesSlides/') ||
        p.startsWith('ppt/notesMasters/') ||
        p.startsWith('ppt/handoutMasters/') ||
        p.startsWith('ppt/charts/') ||
        p.startsWith('ppt/diagrams/') ||
        p === 'ppt/presentation.xml' ||
        p === 'ppt/tableStyles.xml'),
  )

  /** key -> aggregated font */
  const found = new Map<string, DeckFont>()

  const add = (typeface: string, slot: ScriptSlot, part: string, themeRef?: string) => {
    const name = typeface.trim()
    if (!name) return
    // Guard: a fallback-table name reaching here means a bug upstream.
    const key = normalizeKey(name)
    const parsed = parseFontName(name)
    let entry = found.get(key)
    if (!entry) {
      entry = {
        name,
        family: parsed.family,
        weight: parsed.weight,
        italic: parsed.italic,
        tier: 'elsewhere',
        origins: [],
        count: 0,
      }
      found.set(key, entry)
    }
    const tier = tierForPart(part, usedLayouts, usedMasters)
    if (TIER_RANK[tier] < TIER_RANK[entry.tier]) entry.tier = tier

    const existing = entry.origins.find(
      (o: FontOrigin) => o.part === part && o.slot === slot && o.viaThemeRef === themeRef,
    )
    if (existing) existing.count++
    else entry.origins.push({ part, slot, viaThemeRef: themeRef, count: 1 })
    entry.count++
  }

  for (const part of contentParts) {
    const xml = textOf(zip, part)
    if (xml === null) {
      warnings.push({ code: 'unreadable-part', message: 'Part could not be read.', part })
      continue
    }
    for (const ref of collectRefs(xml, part)) {
      if (ref.themeRef) {
        const themePart = themeForPart.get(part) ?? defaultTheme
        const scheme = themePart ? themes[themePart] : undefined
        if (!scheme) continue
        const m = THEME_REF_RE.exec(ref.themeRef)!
        const bucket = m[1] === 'mj' ? scheme.major : scheme.minor
        const resolved = bucket[THEME_SLOT[m[2]!]!]
        if (resolved) add(resolved, ref.slot, part, ref.themeRef)
      } else {
        add(ref.typeface, ref.slot, part)
      }
    }
  }

  // The theme's own major/minor Latin faces are the deck's default typography.
  // If any slide exists, they are in play even where no run names them.
  if (slideParts.length > 0 && defaultTheme && themes[defaultTheme]) {
    const scheme = themes[defaultTheme]
    for (const face of [scheme.major.latin, scheme.minor.latin]) {
      if (face) add(face, 'latin', defaultTheme.replace('ppt/theme/', 'theme:'))
    }
  }

  // ---- 5. Attach embedded-font info ----
  for (const entry of found.values()) {
    const hit = embeddedByName.get(normalizeKey(entry.name)) ?? embeddedByName.get(normalizeKey(entry.family))
    if (hit) entry.embedded = hit
  }

  const fonts = [...found.values()].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.count - a.count || a.name.localeCompare(b.name),
  )

  // A name that appears ONLY in fallback tables is noise; if it also appears in
  // real content it is a genuine font and must not be listed as ignored.
  const realNames = new Set([...found.keys()])
  const ignored = [...ignoredFallbacks].filter((n) => !realNames.has(normalizeKey(n))).sort()

  return {
    fonts,
    slideCount: slideParts.length,
    themes,
    embedded,
    ignoredFallbacks: ignored,
    warnings,
  }
}

/**
 * Name an extracted face file.
 *
 * The zip part name is the best hint available — PowerPoint writes
 * `Garamond-boldItalic.fntdata`, which carries the style. Canva writes
 * `font10.fntdata`, which carries nothing, so we fall back to the typeface.
 */
function faceFilename(typeface: string, part: string, data: Uint8Array): string {
  const ext = data[0] === 0x4f ? 'otf' : 'ttf' // 'OTTO' -> CFF outlines
  const base = part.replace(/^.*\//, '').replace(/\.fntdata$/i, '')
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '')
  if (/^font\d+$/i.test(base)) return `${clean(typeface) || 'Font'}.${ext}`
  return `${clean(base)}.${ext}`
}

function numericPartSort(a: string, b: string): number {
  const na = parseInt(a.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)
  const nb = parseInt(b.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)
  return na - nb
}
