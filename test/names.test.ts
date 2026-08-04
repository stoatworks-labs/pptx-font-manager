import { describe, it, expect } from 'vitest'
import { parseFontName, resolveInstalled, normalizeKey } from '../src/core/names'

/**
 * The cases here are the ones measured against real decks and real CoreText
 * output on macOS — see the repo AGENTS.md. Each represents a false "missing"
 * report that a naive exact-string comparison produces.
 */
describe('parseFontName', () => {
  it('splits a face name into family and weight', () => {
    expect(parseFontName('Helvetica Neue Medium')).toMatchObject({
      family: 'Helvetica Neue',
      weight: 500,
      italic: false,
    })
    expect(parseFontName('Poppins Regular')).toMatchObject({ family: 'Poppins', weight: 400 })
    expect(parseFontName('Open Sans SemiBold Italic')).toMatchObject({
      family: 'Open Sans',
      weight: 600,
      italic: true,
    })
  })

  it('handles PostScript-style hyphenated names', () => {
    expect(parseFontName('Garamond-BoldItalic')).toMatchObject({
      family: 'Garamond',
      weight: 700,
      italic: true,
    })
  })

  it('applies aliases for legacy PostScript names', () => {
    expect(parseFontName('Times Roman').family).toBe('Times New Roman')
    expect(parseFontName('ArialMT').family).toBe('Arial')
  })

  it('does not strip style words that are part of the family name', () => {
    // Arial Black is its own installed family, not a 900 weight of Arial.
    expect(parseFontName('Arial Black')).toMatchObject({ family: 'Arial Black', weight: 400 })
    expect(parseFontName('Franklin Gothic Medium').family).toBe('Franklin Gothic Medium')
  })

  it('keeps a name that is entirely style words', () => {
    expect(parseFontName('Black').family).toBe('Black')
    expect(parseFontName('Medium').family).toBe('Medium')
  })

  it('leaves plain family names alone', () => {
    expect(parseFontName('Calibri')).toMatchObject({ family: 'Calibri', weight: 400, italic: false })
  })
})

describe('normalizeKey', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalizeKey('Helvetica-Neue')).toBe(normalizeKey('helvetica neue'))
    expect(normalizeKey('Gill  Sans')).toBe('gill sans')
  })
})

describe('resolveInstalled', () => {
  // Ground truth from CoreText on a stock Mac.
  const families = ['Arial', 'Arial Black', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Poppins', 'Times New Roman']
  const faces = ['HelveticaNeue-Medium', 'Helvetica Neue Medium', 'Poppins-Regular']

  it('reports a plain installed family as installed', () => {
    expect(resolveInstalled(parseFontName('Arial'), families)).toMatchObject({ state: 'installed' })
  })

  it('resolves a face name against the installed family', () => {
    // The false-alarm case: naive comparison says missing.
    const r = resolveInstalled(parseFontName('Helvetica Neue Medium'), families, faces)
    expect(r.state).toBe('installed')
  })

  it('reports family-installed when the weight is absent', () => {
    const r = resolveInstalled(parseFontName('Gill Sans Bold'), families)
    expect(r).toMatchObject({ state: 'family-installed', matchedFamily: 'Gill Sans' })
  })

  it('treats a Regular request as satisfied by the family', () => {
    expect(resolveInstalled(parseFontName('Poppins Regular'), families)).toMatchObject({
      state: 'installed',
      matchedFamily: 'Poppins',
    })
  })

  it('resolves an aliased legacy name', () => {
    expect(resolveInstalled(parseFontName('Times Roman'), families)).toMatchObject({
      state: 'installed',
      matchedFamily: 'Times New Roman',
    })
  })

  it('reports genuinely absent fonts as missing', () => {
    for (const name of ['Calibri', 'Corbel', 'Garamond', 'Canva Sans']) {
      expect(resolveInstalled(parseFontName(name), families).state).toBe('missing')
    }
  })

  it('does not confuse Arial Black with Arial', () => {
    expect(resolveInstalled(parseFontName('Arial Black'), families)).toMatchObject({
      state: 'installed',
      matchedFamily: 'Arial Black',
    })
  })
})
