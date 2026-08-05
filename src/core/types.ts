/** Which OOXML script slot a typeface reference filled. */
export type ScriptSlot = 'latin' | 'ea' | 'cs' | 'sym'

/**
 * Where a font reference was found, ordered by how strongly it implies the
 * font is genuinely needed to render the deck.
 *
 * The distinction matters more than it looks. A deck authored in Office
 * carries a theme whose `<a:font script="...">` fallback list names ~30 CJK
 * and Indic fonts that are not used by anything — see `scan.ts`. Those are
 * dropped entirely and never become an origin.
 */
export type UsageTier =
  /** Explicit run properties in `ppt/slides/*.xml`, or a theme font a slide resolves to. */
  | 'slide'
  /** A layout or master that a slide actually inherits from, plus the theme's own major/minor faces. */
  | 'inherited'
  /** Notes, unreferenced layouts, chart and SmartArt parts, table styles. */
  | 'elsewhere'

export interface FontOrigin {
  /** Zip part path the reference came from, e.g. `ppt/slides/slide3.xml`. */
  part: string
  slot: ScriptSlot
  /** Set when this came from resolving a `+mn-lt`-style theme reference. */
  viaThemeRef?: string
  count: number
}

/** A font as it is named inside the deck, with everything we learned about it. */
export interface DeckFont {
  /** Exactly as written in the file, e.g. `Helvetica Neue Medium`. */
  name: string
  /** Style suffixes stripped, e.g. `Helvetica Neue`. */
  family: string
  /** Parsed out of the name: 400 for Regular, 500 Medium, 700 Bold, ... */
  weight: number
  italic: boolean
  /** Best tier across all origins. */
  tier: UsageTier
  origins: FontOrigin[]
  /** Total reference count across the deck. */
  count: number
  /** Font data is embedded in the deck itself — nothing to install. */
  embedded?: EmbeddedFont
}

/**
 * A font embedded in the presentation via `<p:embeddedFontLst>`.
 *
 * The payload in `ppt/fonts/*.fntdata` is **EOT** (Embedded OpenType), not a
 * bare TTF/OTF — verified against real decks: EOTSize matches the part length,
 * magic is 0x504C, and version is 0x00020002. When `compressed` is set the
 * glyph data is MicroType Express compressed and there is no sfnt signature
 * anywhere in the part, so it cannot be turned back into an installable file
 * without an MTX decompressor. We report these rather than extract them.
 */
export interface EmbeddedFont {
  typeface: string
  /** Zip parts holding the face data, one per weight/style. */
  parts: string[]
  /** MicroType Express compressed (EOT flag 0x00000004). */
  compressed: boolean
  /** EOT `fsType` embedding-permission bits, if read. */
  fsType?: number
  /**
   * Faces successfully recovered as installable sfnt data. Populated for
   * uncompressed EOT (Canva, LibreOffice) and bare-sfnt payloads; empty for
   * PowerPoint's MTX-compressed embeds, which cannot be unpacked.
   */
  extracted?: ExtractedFace[]
}

export interface ExtractedFace {
  /** Suggested filename, e.g. `CanvaSans-Regular.ttf`. */
  filename: string
  data: Uint8Array
  /** Source zip part. */
  part: string
}

export interface ScanWarning {
  code: 'no-slides' | 'unreadable-part' | 'no-theme' | 'legacy-format'
  message: string
  part?: string
}

export interface ScanResult {
  fonts: DeckFont[]
  slideCount: number
  /** Theme font schemes, keyed by theme part path. */
  themes: Record<string, { major: Partial<Record<ScriptSlot, string>>; minor: Partial<Record<ScriptSlot, string>> }>
  embedded: EmbeddedFont[]
  /** Fonts named only in theme script-fallback lists. Reported for transparency, never treated as used. */
  ignoredFallbacks: string[]
  warnings: ScanWarning[]
}

/** How a font's presence on the machine was determined. */
export type DetectMethod = 'local-font-access' | 'canvas-metrics' | 'native' | 'unknown'

export type InstallState =
  /** An exact family match is present. */
  | 'installed'
  /** The family is present but not this specific face (e.g. Helvetica Neue is there, Medium is not). */
  | 'family-installed'
  | 'missing'
  /** Embedded in the deck; installation is not required to render it. */
  | 'embedded'

export interface FontStatus {
  font: DeckFont
  state: InstallState
  method: DetectMethod
  /** The installed family name that satisfied the match, when one did. */
  matchedFamily?: string
  /** Google Fonts family this maps to, when available. */
  google?: GoogleMatch
}

/**
 * A font file fetched from a remote catalogue, ready to install or bundle.
 *
 * Shared by every download source (Google Fonts, Fontsource) so the bundle
 * builder does not care where a face came from.
 */
export interface FetchedFace {
  filename: string
  data: Uint8Array
  family: string
  weight: number
  italic: boolean
  /** SPDX id. */
  license: string
  /** True when the file is a variable font covering multiple weights. */
  variable: boolean
}

export interface GoogleMatch {
  family: string
  /** True when the deck's family name equals the Google family name. */
  exact: boolean
  /** SPDX id: OFL-1.1, Apache-2.0 or UFL-1.0 — all redistributable. */
  license: string
  category?: string
  /** Weights the family publishes. */
  weights?: number[]
  /** Static .ttf files exist in the google/fonts repo for this family. */
  downloadable?: boolean
}
