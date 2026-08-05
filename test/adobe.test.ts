import { describe, it, expect } from 'vitest'
import {
  findAdobeFamily,
  adobeBundleNote,
  ADOBE_COUNT,
  ADOBE_LIBRARY_TOTAL,
} from '../src/core/adobe'
import { parseFontName } from '../src/core/names'

const look = (n: string) => findAdobeFamily(parseFontName(n))

describe('the Adobe catalogue', () => {
  it('holds a useful share of the library', () => {
    expect(ADOBE_COUNT).toBeGreaterThan(2000)
  })

  /**
   * The single most important property of this module.
   *
   * The public feed hard-caps at page 200 of 12, so it cannot be fully
   * enumerated — the shipped catalogue is knowingly incomplete. Every consumer
   * must treat a miss as "unknown", never as "not an Adobe font". This test
   * exists to make that incompleteness impossible to forget: if someone later
   * assumes full coverage, the numbers here contradict them.
   */
  it('is knowingly incomplete, and records the gap in its own data', () => {
    expect(ADOBE_LIBRARY_TOTAL).toBeGreaterThan(ADOBE_COUNT)
  })

  it('exposes no download or fetch function', async () => {
    // Adobe's licence forbids transferring font files to another machine, and
    // no file endpoint exists in the first place. If a fetch helper ever
    // appears here, both of those have been forgotten.
    const mod = await import('../src/core/adobe')
    const fetchers = Object.keys(mod).filter((k) => /fetch|download|install/i.test(k))
    expect(fetchers).toEqual([])
  })
})

describe('findAdobeFamily', () => {
  it('recognises a well-known Adobe family', () => {
    const m = look('Proxima Nova')
    expect(m).not.toBeNull()
    expect(m!.family).toBe('Proxima Nova')
    expect(m!.url).toMatch(/^https:\/\/fonts\.adobe\.com\/fonts\//)
  })

  it('matches through a stripped style suffix', () => {
    expect(look('Proxima Nova Bold')?.family).toBe('Proxima Nova')
  })

  it('returns null — meaning UNKNOWN, not "no" — for anything it lacks', () => {
    expect(look('Definitely Not A Real Typeface 9000')).toBeNull()
  })
})

describe('Adobe Fonts resells the Microsoft system fonts', () => {
  // This is the trap. Monotype lists Calibri, Times New Roman, Courier New,
  // Segoe UI and Wingdings on Adobe Fonts — all genuine catalogue entries, not
  // matching bugs. Treating a *catalogue hit* as "this font cannot travel and
  // will break elsewhere" is therefore nonsense for a font that ships with both
  // Windows and macOS, and is exactly the false alarm §2.2 exists to prevent.
  it.each(['Times New Roman', 'Courier New', 'Calibri', 'Segoe UI', 'Wingdings'])(
    '%s really is in the Adobe catalogue',
    (name) => {
      expect(look(name)).not.toBeNull()
    },
  )

  it('so an installed system font must not be flagged — see resolveFont', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const font = {
      name: 'Times New Roman',
      family: 'Times New Roman',
      weight: 400,
      italic: false,
      tier: 'slide' as const,
      origins: [],
      count: 1,
    }
    const installed = {
      families: new Set(['Times New Roman']),
      faces: new Set<string>(),
      method: 'local-font-access' as const,
    }
    const r = resolveFont(font, installed as never)
    expect(r.state).toBe('installed')
    expect(r.adobe).toBeUndefined()
  })

  it('but a missing one still gets its activation link', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const font = {
      name: 'Proxima Nova',
      family: 'Proxima Nova',
      weight: 400,
      italic: false,
      tier: 'slide' as const,
      origins: [],
      count: 1,
    }
    const empty = {
      families: new Set<string>(),
      faces: new Set<string>(),
      method: 'local-font-access' as const,
    }
    const r = resolveFont(font, empty as never)
    expect(r.state).toBe('missing')
    expect(r.adobe?.family).toBe('Proxima Nova')
  })
})

describe('adobeBundleNote', () => {
  it('says why the file is absent and what to do, not merely that it is missing', () => {
    const note = adobeBundleNote(look('Proxima Nova')!)
    // "Not found" reads as a failure of the tool. The licence is the reason.
    expect(note).toMatch(/licence does not permit/i)
    expect(note).toMatch(/Creative Cloud/i)
    expect(note).toContain('https://fonts.adobe.com/fonts/')
  })
})
