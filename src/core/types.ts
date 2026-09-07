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
/**
 * How the deck says its fonts were embedded, from `<p:presentation>`.
 *
 * This is PowerPoint's own "Embed fonts in the file" choice:
 *
 *   full    embedTrueTypeFonts, saveSubsetFonts off — "embed all characters
 *           (best for editing by other people)". Someone without the font can
 *           edit the text.
 *   subset  saveSubsetFonts on — "embed only the characters used in the
 *           presentation". Only the glyphs this deck needed travel, so
 *           PowerPoint restricts editing of that text on a machine without
 *           the font: view and print, no typing.
 *   none    no embedding.
 *
 * It is a declaration by the producer, not a measurement. See `EmbedEvidence`.
 */
export type EmbedMode = 'full' | 'subset' | 'none'

/**
 * The OS/2 `fsType` embedding permission carried in the EOT header — what the
 * *foundry* allows, which is a different question from how PowerPoint chose to
 * embed.
 *
 * Worth keeping distinct because `preview-print` is the other thing anyone
 * means by "read only", and it can disagree with the embed mode in both
 * directions: a fully-embedded face may still be preview-and-print by licence.
 */
export type EmbedPermission =
  /** 0x0000 — may be installed on the reader's machine. */
  | 'installable'
  /** 0x0002 — may not be embedded at all without a licence. */
  | 'restricted'
  /** 0x0004 — document may be viewed and printed, not edited. */
  | 'preview-print'
  /** 0x0008 — document may be edited. */
  | 'editable'
  /** Not recorded, or bits we do not recognise. */
  | 'unknown'

/** What a recovered face actually covers, measured from its `cmap`. */
export interface FaceCoverage {
  glyphs: number
  codepoints: number
  /** Of the 95 printable ASCII characters. Exact; see `sfnt.ts`. */
  basicLatin: number
  /** Zip part this was measured from. */
  part: string
}

/**
 * Whether the payload backs up the deck's own claim about subsetting.
 *
 * `fuller-than-claimed` is not a curiosity — it is the Canva case, and Canva
 * is one of the two producers this tool sees most. That deck sets
 * `saveSubsetFonts="1"` and then embeds a complete Latin face.
 *
 * `thinner-than-claimed` is the dangerous direction and the reason this field
 * is not just a debug aid: the deck says every character is present, so
 * PowerPoint allows editing, and the glyphs to render what gets typed are not
 * actually there.
 */
export type EmbedEvidence =
  /** Measured, and consistent with the declared mode. */
  | 'confirmed'
  /** Declared subset; the recovered face covers all printable ASCII anyway. */
  | 'fuller-than-claimed'
  /** Declared full; the recovered face is missing printable ASCII. */
  | 'thinner-than-claimed'
  /** MTX-compressed: the declaration is the only evidence there will ever be. */
  | 'unverifiable'

export interface EmbeddedFont {
  typeface: string
  /** Zip parts holding the face data, one per weight/style. */
  parts: string[]
  /** MicroType Express compressed (EOT flag 0x00000004). */
  compressed: boolean
  /** EOT `fsType` embedding-permission bits, if read. */
  fsType?: number
  /** `fsType` decoded. What the foundry permits, not what PowerPoint did. */
  permission: EmbedPermission
  /** The deck-wide embed mode, copied here so a row can be read on its own. */
  mode: EmbedMode
  /**
   * Can a recipient without this font installed edit text that uses it?
   *
   * Follows the declared mode, because that is what PowerPoint acts on — it
   * restricts editing on the flag, whatever the glyphs turn out to be. Whether
   * the text will *render* correctly is `coverage`, and the two can disagree.
   */
  editable: boolean
  /** Measured from the recovered faces. Absent when nothing was recoverable. */
  coverage?: FaceCoverage
  evidence: EmbedEvidence
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
  /**
   * What this face on its own covers.
   *
   * Held per face rather than only per family because the bundle writes one
   * file per face, and warning on all four when only the bold one was cut down
   * would train the reader to ignore the warning.
   */
  coverage?: FaceCoverage
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
  /**
   * Deck-wide embedding mode from `<p:presentation>`. `none` when the deck
   * embeds nothing, which is the overwhelming majority of decks.
   */
  embedMode: EmbedMode
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
