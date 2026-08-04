import { describe, it, expect } from 'vitest'
import { findGoogleFamily, suggestGoogleFamilies, nearestWeight, licenseUrl } from '../src/core/google'
import { parseFontName } from '../src/core/names'

describe('findGoogleFamily', () => {
  it('matches a family named exactly', () => {
    const m = findGoogleFamily(parseFontName('Poppins'))
    expect(m).toMatchObject({ family: 'Poppins', exact: true, license: 'OFL-1.1', downloadable: true })
  })

  it('matches through a stripped style suffix', () => {
    // "Poppins Regular" appears in a real deck; the family is what Google has.
    const m = findGoogleFamily(parseFontName('Poppins Regular'))
    expect(m?.family).toBe('Poppins')
  })

  it('carries the real licence, not a guess', () => {
    expect(findGoogleFamily(parseFontName('Ubuntu'))?.license).toBe('UFL-1.0')
    expect(findGoogleFamily(parseFontName('Roboto'))?.license).toBe('OFL-1.1')
  })

  it('returns null for fonts Google does not publish', () => {
    for (const n of ['Calibri', 'Corbel', 'Helvetica Neue', 'Canva Sans']) {
      expect(findGoogleFamily(parseFontName(n))).toBeNull()
    }
  })
})

describe('suggestGoogleFamilies', () => {
  it('suggests the Garamonds for a missing Garamond', () => {
    const s = suggestGoogleFamilies(parseFontName('Garamond')).map((x) => x.family)
    expect(s).toContain('EB Garamond')
    expect(s).toContain('Cormorant Garamond')
  })

  it('returns nothing useful for a name with no shared tokens', () => {
    expect(suggestGoogleFamilies(parseFontName('Zzzqqq'))).toHaveLength(0)
  })
})

describe('nearestWeight', () => {
  it('picks the closest published weight', () => {
    const m = findGoogleFamily(parseFontName('Poppins'))!
    expect(nearestWeight(m, 500)).toBe(500)
    expect(nearestWeight(m, 550)).toBe(500)
  })
})

describe('licenseUrl', () => {
  it('points at the licence that actually ships with the family', () => {
    expect(licenseUrl('Poppins')).toMatch(/ofl\/poppins\/OFL\.txt$/)
    expect(licenseUrl('Ubuntu')).toMatch(/ufl\/ubuntu\/UFL\.txt$/)
  })
})

/**
 * Network test. Proves the download path returns a real, complete sfnt rather
 * than the subsetted woff2 the CSS API would hand back. Skipped unless
 * NETWORK_TESTS=1 so the default suite stays offline and fast.
 */
describe.runIf(process.env.NETWORK_TESTS === '1')('fetchGoogleFaces (network)', () => {
  it('downloads a complete static TTF', async () => {
    const { fetchGoogleFaces } = await import('../src/core/google')
    const faces = await fetchGoogleFaces('Poppins', [400])
    expect(faces).toHaveLength(1)
    const f = faces[0]!
    expect(f.filename).toBe('Poppins-Regular.ttf')
    expect(f.license).toBe('OFL-1.1')
    // sfnt signature, and a real font is far bigger than a latin subset.
    expect([...f.data.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00])
    expect(f.data.length).toBeGreaterThan(100_000)
  }, 30_000)

  it('picks the variable file when there is no matching static face', async () => {
    const { fetchGoogleFaces } = await import('../src/core/google')
    const faces = await fetchGoogleFaces('EB Garamond', [400])
    expect(faces[0]!.variable).toBe(true)
    expect(faces[0]!.filename).toMatch(/\[wght\]\.ttf$/)
  }, 30_000)
})
