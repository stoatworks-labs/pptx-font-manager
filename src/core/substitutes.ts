import { normalizeKey, type ParsedFontName } from './names'

/**
 * Substitutes for fonts that cannot be redistributed.
 *
 * ## Why this exists
 *
 * The fonts that actually go missing in practice are not exotic. They are
 * Calibri, Cambria, Arial, Times New Roman, Courier New and Georgia — the
 * Microsoft and Apple system fonts a deck picks up simply by being authored on
 * a particular machine. None of them may be redistributed, so none of them can
 * ever go in the sidecar bundle, and none of them are on Google Fonts.
 *
 * Before this table the app's answer for `Calibri` was "missing, not on Google
 * Fonts", with no suggestions — `suggestGoogleFamilies` ranks by shared word
 * tokens, and there is no path from "Calibri" to "Carlito". That is the single
 * most common deck this tool will ever see, answered with a shrug.
 *
 * ## Metric-compatible is a much stronger claim than "looks similar"
 *
 * A metric-compatible face has the **same advance widths** as its target, so a
 * run of text occupies the same horizontal space. Substituting it does not
 * reflow the deck: line breaks hold, text stays inside its box, and a slide
 * that was proofed at 1920x1080 still looks proofed.
 *
 * A merely *similar* face will change line breaks. That can push text out of a
 * shape or onto an extra line, which on a conference stage is worse than being
 * told the font is missing — the user thinks the problem is solved and finds
 * out in front of an audience.
 *
 * So the two kinds are separate fields rather than one ranked list, and
 * `metric` must be surfaced in the UI and written into the bundle manifest.
 * Never collapse them.
 *
 * Every family named here is checked against the shipped Google Fonts
 * catalogue by `test/substitutes.test.ts`, which fails if one disappears or
 * loses its downloadable files.
 */

export interface Substitute {
  /** Google Fonts family name. Must exist in the catalogue with real files. */
  family: string
  /**
   * Same advance widths as the target, so the deck does not reflow. A `false`
   * here is a genuinely weaker offer and must be presented as one.
   */
  metric: boolean
  /** Shown in the UI and written into the bundle manifest. */
  note: string
}

export interface SubstituteEntry {
  /** The non-redistributable family, named as decks name it. */
  target: string
  /**
   * Other spellings that should resolve to the same entry.
   *
   * These are matched against both the raw deck string and the parsed family,
   * which matters more than it looks: `parseFontName('Times New Roman')`
   * returns the family `Times New`, because `Roman` is a weight token (as in
   * `Times Roman`) and only `times roman` sits in `PROTECTED_FAMILIES`. Listing
   * the degraded form here is deliberate — see the note in the entry below.
   */
  aliases?: string[]
  /** Best first; metric-compatible entries always before similar-only ones. */
  substitutes: Substitute[]
}

export const SUBSTITUTES: SubstituteEntry[] = [
  {
    target: 'Calibri',
    // `Calibri Light` parses to family Calibri at weight 300, so it arrives
    // here without needing an alias; the hyphenated PostScript form does not.
    aliases: ['Calibri-Light'],
    substitutes: [
      {
        family: 'Carlito',
        metric: true,
        note: 'Metric-compatible with Calibri — same widths, so the deck does not reflow.',
      },
    ],
  },
  {
    target: 'Cambria',
    // Parses as its own family "Cambria Math", not as Cambria.
    aliases: ['Cambria Math'],
    substitutes: [
      {
        family: 'Caladea',
        metric: true,
        note: 'Metric-compatible with Cambria — same widths, so the deck does not reflow.',
      },
    ],
  },
  {
    target: 'Arial',
    // Arial Black is deliberately absent: it is its own installed family, which
    // is why PROTECTED_FAMILIES in names.ts guards it. Substituting Arimo for
    // it would swap a 900-weight display face for a regular one.
    aliases: ['Helvetica', 'Arial MT', 'ArialMT', 'Liberation Sans', 'Arial Narrow'],
    substitutes: [
      {
        family: 'Arimo',
        metric: true,
        note: 'Metric-compatible with Arial (and so with Helvetica) — same widths, so the deck does not reflow.',
      },
    ],
  },
  {
    target: 'Times New Roman',
    // "Times New" is what parseFontName yields for "Times New Roman": Roman is
    // a weight token. Matching it here is a deliberate belt-and-braces so this
    // table keeps working whether it is handed the raw name or the parsed one.
    aliases: ['Times New', 'Times', 'Times Roman', 'Liberation Serif', 'TimesNewRomanPSMT'],
    substitutes: [
      {
        family: 'Tinos',
        metric: true,
        note: 'Metric-compatible with Times New Roman — same widths, so the deck does not reflow.',
      },
    ],
  },
  {
    target: 'Courier New',
    aliases: ['Courier', 'Liberation Mono', 'CourierNewPSMT'],
    substitutes: [
      {
        family: 'Cousine',
        metric: true,
        note: 'Metric-compatible with Courier New — same widths, so the deck does not reflow.',
      },
    ],
  },
  {
    target: 'Georgia',
    substitutes: [
      {
        family: 'Gelasio',
        metric: true,
        note: 'Metric-compatible with Georgia — same widths, so the deck does not reflow.',
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  /* No metric-compatible option exists for these. Similar only — the deck   */
  /* WILL reflow, and the UI has to say so.                                  */
  /* ---------------------------------------------------------------------- */

  {
    target: 'Segoe UI',
    aliases: ['Segoe', 'Segoe UI Light', 'Segoe UI Semibold', 'Segoe UI Semilight', 'Segoe UI Black'],
    substitutes: [
      {
        family: 'Open Sans',
        metric: false,
        note: 'Visually close humanist sans. Widths differ — line breaks will move.',
      },
      {
        family: 'Source Sans 3',
        metric: false,
        note: 'Alternative humanist sans. Widths differ — line breaks will move.',
      },
    ],
  },
  {
    target: 'Garamond',
    aliases: ['ITC Garamond', 'Adobe Garamond', 'Garamond MT', 'Garamond Premier'],
    substitutes: [
      {
        family: 'EB Garamond',
        metric: false,
        note: 'A digitisation from the same Garamond source. Widths differ — line breaks will move.',
      },
      {
        family: 'Cormorant Garamond',
        metric: false,
        note: 'Display-oriented Garamond. Widths differ — line breaks will move.',
      },
    ],
  },
  {
    target: 'Helvetica Neue',
    aliases: ['HelveticaNeue'],
    substitutes: [
      {
        family: 'Inter',
        metric: false,
        note: 'Neo-grotesque designed for screens. Widths differ — line breaks will move.',
      },
      {
        family: 'Lato',
        metric: false,
        note: 'Alternative neo-grotesque. Widths differ — line breaks will move.',
      },
    ],
  },
  {
    target: 'Futura',
    aliases: ['Futura PT', 'Century Gothic'],
    substitutes: [
      {
        family: 'Jost',
        metric: false,
        note: 'Geometric sans in the Futura tradition. Widths differ — line breaks will move.',
      },
    ],
  },
  {
    target: 'Gill Sans',
    aliases: ['Gill Sans MT', 'Gill Sans Nova'],
    substitutes: [
      {
        family: 'Lato',
        metric: false,
        note: 'Humanist sans. Widths differ — line breaks will move.',
      },
    ],
  },
]

/** normalised name -> entry, covering targets and aliases alike. */
const BY_KEY = new Map<string, SubstituteEntry>()
for (const entry of SUBSTITUTES) {
  BY_KEY.set(normalizeKey(entry.target), entry)
  for (const alias of entry.aliases ?? []) {
    const key = normalizeKey(alias)
    // A target always wins over another entry's alias.
    if (!BY_KEY.has(key)) BY_KEY.set(key, entry)
  }
}

export interface SubstituteMatch {
  /** The entry's canonical target name, e.g. `Times New Roman`. */
  target: string
  substitutes: Substitute[]
  /** True when at least one option preserves the deck's line breaks. */
  hasMetric: boolean
}

/**
 * Find substitutes for a font that is missing and cannot be downloaded.
 *
 * Tried against the raw deck string first and the parsed family second. Both
 * are needed: the raw string carries names the parser degrades (`Times New
 * Roman` -> `Times New`), while the parsed family is what reaches us for
 * face-name variants (`Calibri Light` -> `Calibri`).
 */
export function findSubstitutes(parsed: ParsedFontName): SubstituteMatch | null {
  const entry = BY_KEY.get(normalizeKey(parsed.raw)) ?? BY_KEY.get(normalizeKey(parsed.family))
  if (!entry) return null
  return {
    target: entry.target,
    substitutes: entry.substitutes,
    hasMetric: entry.substitutes.some((s) => s.metric),
  }
}
