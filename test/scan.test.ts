import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scanPptx } from '../src/core/scan'

/**
 * Fixtures are real presentations and are deliberately NOT committed (see
 * .gitignore) — they are private decks. Tests that need them skip when absent
 * so the suite still passes on a clean clone and in CI.
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const has = (name: string) => existsSync(fixture(name))
const load = (name: string) => new Uint8Array(readFileSync(fixture(name)))

const CANVA = 'canva-embedded.pptx'
const OFFICE = 'office-embedded.pptx'
const THEMEREF = 'themeref-heavy.pptx'

describe('scanPptx — theme fallback filtering', () => {
  it.runIf(has(CANVA))('does not report script-fallback fonts as used', () => {
    const r = scanPptx(load(CANVA))
    const names = r.fonts.map((f) => f.name)

    // These live only in <a:font script="..."> and must never surface.
    for (const noise of ['Mongolian Baiti', 'DokChampa', 'Iskoola Pota', 'MoolBoran', 'Nyala']) {
      expect(names).not.toContain(noise)
    }
    // A naive grep finds 39 typefaces in this deck.
    expect(r.fonts.length).toBeLessThan(8)
    expect(r.ignoredFallbacks.length).toBeGreaterThan(20)
  })

  it.runIf(has(OFFICE))('keeps a fallback-table name if it is also genuinely used', () => {
    const r = scanPptx(load(OFFICE))
    const names = r.fonts.map((f) => f.name)
    // Arial is in the fallback table AND is the theme + slide font here.
    expect(names).toContain('Arial')
    expect(r.ignoredFallbacks).not.toContain('Arial')
  })
})

describe('scanPptx — theme reference resolution', () => {
  it.runIf(has(THEMEREF))('resolves +mn-lt / +mj-lt through the theme', () => {
    const r = scanPptx(load(THEMEREF))
    const names = r.fonts.map((f) => f.name)
    // 45 +mn-* references in this deck, all resolving to the theme face.
    expect(names).toContain('Helvetica Neue')
    const hn = r.fonts.find((f) => f.name === 'Helvetica Neue')!
    expect(hn.origins.some((o) => o.viaThemeRef?.startsWith('+mn-'))).toBe(true)
  })

  it.runIf(has(THEMEREF))('reports explicit slide fonts at slide tier', () => {
    const r = scanPptx(load(THEMEREF))
    const slideTier = r.fonts.filter((f) => f.tier === 'slide').map((f) => f.name)
    expect(slideTier).toContain('Poppins Regular')
    expect(slideTier).toContain('Helvetica Neue Medium')
  })

  it.runIf(has(THEMEREF))('never emits a raw +mn-lt token as a font name', () => {
    const r = scanPptx(load(THEMEREF))
    for (const f of r.fonts) expect(f.name.startsWith('+')).toBe(false)
  })
})

describe('scanPptx — embedded fonts', () => {
  it.runIf(has(CANVA))('detects a Canva-embedded face', () => {
    const r = scanPptx(load(CANVA))
    expect(r.embedded.map((e) => e.typeface)).toContain('Canva Sans')
    const cs = r.fonts.find((f) => f.name === 'Canva Sans')
    expect(cs?.embedded).toBeTruthy()
  })

  it.runIf(has(OFFICE))('detects EOT-compressed embedded faces', () => {
    const r = scanPptx(load(OFFICE))
    const names = r.embedded.map((e) => e.typeface).sort()
    expect(names).toEqual(['Corbel', 'Garamond'])
    // Verified against the real bytes: EOT v2.2 with TTCOMPRESSED set.
    expect(r.embedded.every((e) => e.compressed)).toBe(true)
    expect(r.embedded.every((e) => e.parts.length > 0)).toBe(true)
  })
})

describe('scanPptx — robustness', () => {
  it('rejects legacy binary .ppt with a useful message', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    expect(() => scanPptx(ole)).toThrow(/not a \.pptx/i)
  })

  it('rejects arbitrary non-zip bytes', () => {
    expect(() => scanPptx(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it.runIf(has(THEMEREF))('handles a 331 MB deck without inflating its media', () => {
    const t0 = Date.now()
    const r = scanPptx(load(THEMEREF))
    expect(r.slideCount).toBeGreaterThan(0)
    // Media filtering keeps this fast; without it the inflate alone is seconds.
    expect(Date.now() - t0).toBeLessThan(15_000)
  })
})

describe('embedded font extraction', () => {
  it.runIf(has(CANVA))('recovers an installable TTF from uncompressed EOT', () => {
    const r = scanPptx(load(CANVA))
    const cs = r.embedded.find((e) => e.typeface === 'Canva Sans')!
    expect(cs.compressed).toBe(false)
    expect(cs.extracted?.length).toBe(1)
    const face = cs.extracted![0]!
    // Valid sfnt signature 0x00010000.
    expect([...face.data.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00])
    expect(face.filename).toMatch(/\.ttf$/)
  })

  it.runIf(has(OFFICE))('does not claim to extract MTX-compressed faces', () => {
    const r = scanPptx(load(OFFICE))
    for (const e of r.embedded) {
      expect(e.compressed).toBe(true)
      expect(e.extracted ?? []).toHaveLength(0)
    }
  })
})
