import { describe, it, expect } from 'vitest'
import { findFontsourceFamily, fetchFontsourceFaces, FONTSOURCE_COUNT } from '../src/core/fontsource'
import { findGoogleFamily } from '../src/core/google'
import { parseFontName } from '../src/core/names'
import catalogue from '../src/data/fontsource-fonts.json'

interface RawFamily {
  n: string
  s: string
  u: string
  l: string
  w: number[]
}
const FAMILIES = (catalogue as { families: RawFamily[] }).families

describe('the Fontsource catalogue', () => {
  it('carries only families Google Fonts does not have', () => {
    // The whole point of this catalogue is to add coverage. Anything Google
    // also publishes should be fetched from the original repo files instead,
    // because Fontsource's republish is unicode-range subsetted.
    const overlap = FAMILIES.filter((f) => findGoogleFamily(parseFontName(f.n)) !== null)
    expect(overlap.map((f) => f.n)).toEqual([])
  })

  it('carries only redistributable licences', () => {
    const allowed = new Set(['OFL-1.1', 'Apache-2.0', 'UFL-1.0', 'CC0-1.0', 'MIT', 'Unlicense'])
    for (const f of FAMILIES) {
      expect(allowed.has(f.l), `${f.n} is ${f.l}`).toBe(true)
    }
  })

  it('gives every family a CDN id, a subset and at least one weight', () => {
    // A missing subset would build a URL like `undefined-400-normal.ttf`.
    for (const f of FAMILIES) {
      expect(f.s, `${f.n} has no id`).toBeTruthy()
      expect(f.u, `${f.n} has no subset`).toBeTruthy()
      expect(f.w.length, `${f.n} has no weights`).toBeGreaterThan(0)
    }
  })

  it('is not empty', () => {
    expect(FONTSOURCE_COUNT).toBeGreaterThan(50)
  })
})

describe('findFontsourceFamily', () => {
  it('matches a family Google does not publish', () => {
    const m = findFontsourceFamily(parseFontName('Aileron'))
    expect(m).toMatchObject({ family: 'Aileron', exact: true })
  })

  it('matches through a stripped style suffix', () => {
    expect(findFontsourceFamily(parseFontName('Aileron Bold'))?.family).toBe('Aileron')
  })

  it('returns null for fonts it does not have', () => {
    for (const n of ['Calibri', 'Poppins', 'Wingdings']) {
      expect(findFontsourceFamily(parseFontName(n))).toBeNull()
    }
  })
})

/**
 * Hits the real jsDelivr CDN, so it is opt-in via NETWORK_TESTS=1 — the default
 * suite stays offline and fast.
 */
describe.runIf(process.env.NETWORK_TESTS === '1')('fetchFontsourceFaces (network)', () => {
  it('downloads a real, complete sfnt', async () => {
    const faces = await fetchFontsourceFaces('Aileron', [400])
    expect(faces.length).toBeGreaterThan(0)
    const f = faces[0]!
    // sfnt magic: 0x00010000 for TrueType outlines.
    expect([...f.data.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00])
    expect(f.data.length).toBeGreaterThan(10_000)
  }, 30_000)

  it('renames CDN files to something meaningful', async () => {
    // The CDN calls it `latin-400-normal.ttf`, which tells a user nothing about
    // which font it is once it is sitting in their font folder.
    const [f] = await fetchFontsourceFaces('Aileron', [400])
    expect(f!.filename).toBe('Aileron-400.ttf')
  }, 30_000)

  it('falls back to the nearest published weight', async () => {
    const [f] = await fetchFontsourceFaces('Aileron', [450])
    expect(f!.weight).toBe(400)
  }, 30_000)
})
