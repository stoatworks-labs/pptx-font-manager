import { describe, it, expect } from 'vitest'
import { SUBSTITUTES, findSubstitutes } from '../src/core/substitutes'
import { parseFontName } from '../src/core/names'
import catalogue from '../src/data/google-fonts.json'

interface RawFamily {
  n: string
  l: string
  f: string[]
}
const FAMILIES = (catalogue as { families: RawFamily[] }).families
const byName = new Map(FAMILIES.map((f) => [f.n.toLowerCase(), f]))

const look = (name: string) => findSubstitutes(parseFontName(name))

describe('substitute catalogue integrity', () => {
  // The table is only useful if every family in it can actually be fetched.
  // A family that is renamed or dropped upstream would otherwise turn into a
  // dead "download this instead" button that fails at the last step.
  it('every substitute exists in the Google Fonts catalogue with downloadable files', () => {
    const broken: string[] = []
    for (const entry of SUBSTITUTES) {
      for (const sub of entry.substitutes) {
        const rec = byName.get(sub.family.toLowerCase())
        if (!rec) broken.push(`${entry.target} -> ${sub.family}: not in catalogue`)
        else if (rec.f.length === 0) broken.push(`${entry.target} -> ${sub.family}: no static TTFs`)
      }
    }
    expect(broken).toEqual([])
  })

  it('every substitute carries a redistributable licence', () => {
    // The whole point of the sidecar bundle is that it may legally be handed to
    // a venue. A substitute under anything else would quietly break that.
    const allowed = new Set(['OFL-1.1', 'Apache-2.0', 'UFL-1.0'])
    for (const entry of SUBSTITUTES) {
      for (const sub of entry.substitutes) {
        const rec = byName.get(sub.family.toLowerCase())!
        expect(allowed.has(rec.l), `${sub.family} is ${rec.l}`).toBe(true)
      }
    }
  })

  it('lists metric-compatible options before similar-only ones', () => {
    for (const entry of SUBSTITUTES) {
      const firstSimilar = entry.substitutes.findIndex((s) => !s.metric)
      const lastMetric = entry.substitutes.map((s) => s.metric).lastIndexOf(true)
      if (firstSimilar !== -1 && lastMetric !== -1) {
        expect(lastMetric, `${entry.target} orders a similar option before a metric one`).toBeLessThan(firstSimilar)
      }
    }
  })
})

describe('the fonts that actually go missing', () => {
  it.each([
    ['Calibri', 'Carlito'],
    ['Cambria', 'Caladea'],
    ['Arial', 'Arimo'],
    ['Times New Roman', 'Tinos'],
    ['Courier New', 'Cousine'],
    ['Georgia', 'Gelasio'],
  ])('%s resolves to the metric-compatible %s', (deckName, expected) => {
    const m = look(deckName)
    expect(m).not.toBeNull()
    expect(m!.substitutes[0]!.family).toBe(expected)
    expect(m!.substitutes[0]!.metric).toBe(true)
    expect(m!.hasMetric).toBe(true)
  })
})

describe('names the parser degrades or decorates', () => {
  // parseFontName('Times New Roman') yields the family "Times New", because
  // Roman is a weight token and only "times roman" is in PROTECTED_FAMILIES.
  // The lookup has to survive that, which is why it tries the raw name first.
  it('Times New Roman still resolves despite parsing to the family "Times New"', () => {
    expect(parseFontName('Times New Roman').family).toBe('Times New')
    expect(look('Times New Roman')?.target).toBe('Times New Roman')
  })

  it('face-name variants reach their family entry', () => {
    expect(look('Calibri Light')?.target).toBe('Calibri')
    expect(look('Segoe UI Semibold')?.target).toBe('Segoe UI')
    expect(look('Gill Sans MT')?.target).toBe('Gill Sans')
  })

  it('Cambria Math is matched explicitly, since it parses as its own family', () => {
    expect(parseFontName('Cambria Math').family).toBe('Cambria Math')
    expect(look('Cambria Math')?.target).toBe('Cambria')
  })

  it('PostScript spellings resolve', () => {
    expect(look('TimesNewRomanPSMT')?.target).toBe('Times New Roman')
    expect(look('ArialMT')?.target).toBe('Arial')
  })
})

describe('what must NOT be substituted', () => {
  // Arial Black is its own installed family, not a 900-weight of Arial —
  // the same trap PROTECTED_FAMILIES exists for in names.ts. Handing someone
  // Arimo for it swaps a heavy display face for a regular one.
  it('Arial Black does not resolve to Arial’s substitute', () => {
    expect(look('Arial Black')).toBeNull()
  })

  it('a font with no entry returns null rather than guessing', () => {
    expect(look('Wingdings')).toBeNull()
    expect(look('Comic Sans MS')).toBeNull()
  })
})

describe('similar-only entries are honest about reflowing', () => {
  it.each(['Segoe UI', 'Garamond', 'Helvetica Neue', 'Futura', 'Gill Sans'])(
    '%s offers no metric-compatible option',
    (name) => {
      const m = look(name)
      expect(m).not.toBeNull()
      expect(m!.hasMetric).toBe(false)
      for (const s of m!.substitutes) {
        expect(s.metric).toBe(false)
        // The warning is the product here — without it the user believes the
        // deck is fixed and discovers otherwise on stage.
        expect(s.note).toMatch(/line breaks will move/i)
      }
    },
  )
})
