/**
 * Font name normalisation.
 *
 * PowerPoint writes whatever string the authoring app put in the run
 * properties, and that is frequently a *face* name rather than a *family*
 * name. Measured against the real decks in `test/fixtures`:
 *
 *   "Helvetica Neue Medium"  -> family Helvetica Neue, weight 500
 *   "Poppins Regular"        -> family Poppins,        weight 400
 *
 * Both families are installed on a typical Mac. Comparing the raw string
 * against installed *family* names reports them missing, which is a false
 * alarm — and then sends the user off to download a "Helvetica Neue Medium"
 * from Google Fonts, which does not exist. Stripping the style suffix first is
 * what makes the installed-check and the Google match both behave.
 */

/** Style tokens, longest first so `Semi Bold` wins over `Bold`. */
const WEIGHT_TOKENS: Array<[RegExp, number]> = [
  [/\b(extra|ultra)[\s-]?light\b/i, 200],
  [/\b(extra|ultra)[\s-]?bold\b/i, 800],
  [/\b(semi|demi)[\s-]?bold\b/i, 600],
  [/\b(semi|demi)[\s-]?light\b/i, 350],
  [/\bthin\b/i, 100],
  [/\bhairline\b/i, 100],
  [/\bextralight\b/i, 200],
  [/\bultralight\b/i, 200],
  [/\blight\b/i, 300],
  [/\bnormal\b/i, 400],
  [/\bregular\b/i, 400],
  [/\bbook\b/i, 400],
  [/\broman\b/i, 400],
  [/\bmedium\b/i, 500],
  [/\bsemibold\b/i, 600],
  [/\bdemibold\b/i, 600],
  [/\bextrabold\b/i, 800],
  [/\bultrabold\b/i, 800],
  [/\bbold\b/i, 700],
  [/\bheavy\b/i, 800],
  [/\bblack\b/i, 900],
  [/\bfat\b/i, 900],
]

const ITALIC_RE = /\b(italic|oblique|it)\b/i

/**
 * Tokens that look like styles but are part of the family name for at least
 * one real family. Stripping these breaks the match instead of fixing it.
 *
 * `Arial Black` and `Century Gothic` are the classic traps: "Black" is a
 * weight token everywhere else, but `Arial Black` is a distinct installed
 * family, not a 900-weight of `Arial`.
 */
const PROTECTED_FAMILIES = [
  'arial black',
  'arial narrow',
  'arial rounded mt bold',
  'gill sans nova',
  'avenir black',
  'archivo black',
  'roboto black',
  'sofia sans extra condensed',
  'times roman',
  'book antiqua',
  'bookman old style',
  'century schoolbook',
  'franklin gothic medium',
  'franklin gothic heavy',
  'franklin gothic book',
  'lucida bright',
  'segoe ui black',
  'segoe ui light',
  'segoe ui semibold',
  'segoe ui semilight',
  'hiragino sans',
]

/**
 * Deck-name -> installed-name aliases for cases a suffix strip cannot reach.
 * Keys are compared lowercased.
 */
const ALIASES: Record<string, string> = {
  // The PostScript-era name for what everyone ships as Times New Roman.
  'times roman': 'Times New Roman',
  'timesnewromanpsmt': 'Times New Roman',
  'timesnewromanps': 'Times New Roman',
  'arialmt': 'Arial',
  'arial-black': 'Arial Black',
  'helveticaneue': 'Helvetica Neue',
  'couriernewpsmt': 'Courier New',
  'calibri-light': 'Calibri Light',
  // Office 2024+ default; Aptos replaced Calibri and ships under both names.
  'aptos narrow': 'Aptos Narrow',
  'aptos display': 'Aptos Display',
}

/** `boldItalic` -> `bold Italic`, `SemiBoldItalic` -> `Semi Bold Italic`. */
function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

export interface ParsedFontName {
  /** Original string, untouched. */
  raw: string
  /** Style suffixes removed. */
  family: string
  weight: number
  italic: boolean
}

/** Case/space/punctuation-insensitive key for comparing font names. */
export function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[_\-,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split a font name into family + weight + italic.
 *
 * Conservative by design: if stripping every style token would leave nothing,
 * the original name is kept as the family. That protects single-word families
 * whose whole name is a style word (`Black`, `Medium` both exist as families).
 */
export function parseFontName(raw: string): ParsedFontName {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  const key = normalizeKey(trimmed)

  if (PROTECTED_FAMILIES.includes(key)) {
    return { raw, family: ALIASES[key] ?? trimmed, weight: 400, italic: false }
  }
  if (ALIASES[key]) {
    return { raw, family: ALIASES[key], weight: 400, italic: false }
  }

  // A trailing "-Bold" / "-BoldItalic" is a PostScript name, not a family.
  //
  // The style tail is written run-together — PowerPoint really does emit
  // `Garamond-boldItalic` — so it has to be split on case transitions before
  // the style tokens below can see word boundaries. Only the tail is split:
  // doing it to the whole string would mangle families that are legitimately
  // camel-cased, such as DejaVu Sans or McLaren.
  let work = trimmed
  const hyphen = trimmed.search(/[-_]/)
  if (hyphen !== -1) {
    const head = trimmed.slice(0, hyphen)
    const tail = trimmed.slice(hyphen + 1).replace(/[-_]/g, ' ')
    work = `${head} ${splitCamel(tail)}`
  }
  work = work.replace(/\s+/g, ' ')

  let italic = false
  if (ITALIC_RE.test(work)) {
    italic = true
    work = work.replace(ITALIC_RE, ' ')
  }

  let weight = 400
  let weightFound = false
  for (const [re, w] of WEIGHT_TOKENS) {
    if (re.test(work)) {
      weight = w
      weightFound = true
      work = work.replace(re, ' ')
      break
    }
  }

  // Numeric weights: "Roboto 500", "Inter 700"
  const numeric = work.match(/\b([1-9]00)\b/)
  if (numeric && !weightFound) {
    weight = parseInt(numeric[1]!, 10)
    work = work.replace(numeric[0], ' ')
  }

  // Drop foundry suffixes that never appear in an installed family name.
  work = work.replace(/\b(MT|MS|PS|Std|Pro|LT|W\d{1,2})\b/gi, ' ')

  const family = work.replace(/\s+/g, ' ').trim()
  if (!family) {
    // The whole name was style words — keep it as-is.
    return { raw, family: trimmed, weight: 400, italic: false }
  }

  const familyKey = normalizeKey(family)
  return { raw, family: ALIASES[familyKey] ?? family, weight, italic }
}

/**
 * Does `candidate` (an installed family or face name) satisfy `wanted`?
 *
 * Returns the strength of the match so callers can prefer an exact family hit
 * over a face-level one.
 */
export type MatchStrength = 'exact' | 'family' | 'none'

export function matchStrength(wanted: ParsedFontName, candidate: string): MatchStrength {
  const c = normalizeKey(candidate)
  if (c === normalizeKey(wanted.raw)) return 'exact'
  if (c === normalizeKey(wanted.family)) return wanted.weight === 400 && !wanted.italic ? 'exact' : 'family'
  return 'none'
}

/**
 * Resolve a wanted font against a set of installed names.
 *
 * `families` should be family names; `faces` should be full/PostScript face
 * names when the platform can supply them (the Local Font Access API and
 * CoreText both can). Passing faces is what lets `Helvetica Neue Medium`
 * report as genuinely present rather than merely "family installed".
 */
export function resolveInstalled(
  wanted: ParsedFontName,
  families: Iterable<string>,
  faces?: Iterable<string>,
): { state: 'installed' | 'family-installed' | 'missing'; matchedFamily?: string } {
  const wantFamily = normalizeKey(wanted.family)
  const wantRaw = normalizeKey(wanted.raw)

  let familyHit: string | undefined
  for (const f of families) {
    const k = normalizeKey(f)
    if (k === wantRaw) return { state: 'installed', matchedFamily: f }
    if (k === wantFamily) familyHit = f
  }

  if (faces) {
    for (const face of faces) {
      if (normalizeKey(face) === wantRaw) {
        return { state: 'installed', matchedFamily: familyHit ?? wanted.family }
      }
    }
  }

  if (familyHit) {
    // Family is present. A plain Regular request is fully satisfied by it;
    // a specific weight/style is only probably satisfied.
    if (wanted.weight === 400 && !wanted.italic) {
      return { state: 'installed', matchedFamily: familyHit }
    }
    return { state: 'family-installed', matchedFamily: familyHit }
  }

  return { state: 'missing' }
}
