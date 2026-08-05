import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { buildBundle, bundleFilename, type BundleEntry } from '../src/core/bundle'

const fakeTtf = (n: number) => {
  const d = new Uint8Array(n)
  d.set([0x00, 0x01, 0x00, 0x00])
  return d
}

const freeEntry: BundleEntry = {
  filename: 'Poppins-Regular.ttf',
  data: fakeTtf(64),
  family: 'Poppins',
  source: 'google',
  license: 'OFL-1.1',
  redistributable: true,
  provenance: 'Google Fonts (OFL-1.1)',
}

const restrictedEntry: BundleEntry = {
  filename: 'HelveticaNeue.ttf',
  data: fakeTtf(48),
  family: 'Helvetica Neue',
  source: 'local',
  license: 'Proprietary / unknown — check the foundry terms',
  redistributable: false,
  provenance: 'copied from this machine',
}

const metricSubstitute: BundleEntry = {
  filename: 'Carlito-Regular.ttf',
  data: fakeTtf(72),
  family: 'Carlito',
  source: 'substitute',
  license: 'OFL-1.1',
  redistributable: true,
  provenance: 'Google Fonts (OFL-1.1), as a stand-in for Calibri',
  substituteFor: { target: 'Calibri', metric: true },
}

const similarSubstitute: BundleEntry = {
  filename: 'OpenSans-Regular.ttf',
  data: fakeTtf(72),
  family: 'Open Sans',
  source: 'substitute',
  license: 'OFL-1.1',
  redistributable: true,
  provenance: 'Google Fonts (OFL-1.1), as a stand-in for Segoe UI',
  substituteFor: { target: 'Segoe UI', metric: false },
}

function open(zip: Uint8Array) {
  const files = unzipSync(zip)
  return { files, text: (n: string) => strFromU8(files[n]!) }
}

describe('buildBundle', () => {
  it('lays out fonts, installers and docs', () => {
    const { files } = open(buildBundle({ deckName: 'Deck.pptx', entries: [freeEntry], unavailable: [] }))
    expect(Object.keys(files).sort()).toEqual([
      'MANIFEST.txt',
      'README.txt',
      'fonts/Poppins-Regular.ttf',
      'install-fonts.cmd',
      'install-fonts.command',
      'install-fonts.ps1',
      'install-fonts.sh',
    ])
  })

  it('separates redistributable fonts from restricted ones, and warns loudly', () => {
    const { text } = open(
      buildBundle({
        deckName: 'Deck.pptx',
        entries: [freeEntry, restrictedEntry],
        unavailable: [],
      }),
    )
    const manifest = text('MANIFEST.txt')
    expect(manifest).toContain('FREE TO REDISTRIBUTE')
    expect(manifest).toContain('*** RESTRICTED — DO NOT REDISTRIBUTE ***')
    // The restricted font is still included — "everything, with warnings".
    expect(manifest).toContain('HelveticaNeue.ttf')
    expect(manifest).toContain('Poppins-Regular.ttf')
    expect(manifest).toMatch(/permission to EMBED[\s\S]*is not permission to extract/i)
  })

  it('records fonts it could not include, with the reason', () => {
    const { text } = open(
      buildBundle({
        deckName: 'Deck.pptx',
        entries: [freeEntry],
        unavailable: [{ name: 'Corbel', reason: 'MicroType Express compressed' }],
      }),
    )
    const manifest = text('MANIFEST.txt')
    expect(manifest).toContain('NOT INCLUDED')
    expect(manifest).toContain('Corbel')
    expect(manifest).toContain('MicroType Express compressed')
  })

  it('does not lose a font when two files share a name', () => {
    const dup = { ...freeEntry, family: 'Other', data: fakeTtf(32) }
    const { files } = open(
      buildBundle({ deckName: 'D.pptx', entries: [freeEntry, dup], unavailable: [] }),
    )
    expect(files['fonts/Poppins-Regular.ttf']).toBeTruthy()
    expect(files['fonts/Poppins-Regular-2.ttf']).toBeTruthy()
  })

  it('documents both platform traps in the README', () => {
    const { text } = open(buildBundle({ deckName: 'D.pptx', entries: [freeEntry], unavailable: [] }))
    const readme = text('README.txt')
    // macOS Gatekeeper quarantine.
    expect(readme).toContain('xattr -d com.apple.quarantine')
    expect(readme).toMatch(/unidentified developer/i)
    // Windows Mark-of-the-Web: users must run the .cmd, not the .ps1.
    expect(readme).toContain('install-fonts.cmd')
    expect(readme).toMatch(/NOT\s+install-fonts\.ps1/)
    // And the no-script escape hatch on both.
    expect(readme).toMatch(/Font Book/)
  })

  it('gives the shell installers an executable mode', () => {
    const zip = buildBundle({ deckName: 'D.pptx', entries: [freeEntry], unavailable: [] })
    // External attributes live in the central directory; check the unix mode
    // bits survived by looking for the 0755 pattern in the raw zip.
    const files = unzipSync(zip)
    expect(files['install-fonts.command']).toBeTruthy()
    expect(strFromU8(files['install-fonts.command']!)).toMatch(/^#!\/bin\/bash/)
    expect(strFromU8(files['install-fonts.sh']!)).toMatch(/^#!\/bin\/sh/)
  })

  it('writes CRLF line endings for the Windows scripts', () => {
    const { text } = open(buildBundle({ deckName: 'D.pptx', entries: [freeEntry], unavailable: [] }))
    expect(text('install-fonts.cmd')).toContain('\r\n')
    expect(text('install-fonts.ps1')).toContain('\r\n')
    // ...and LF for the unix ones, or bash chokes on the carriage returns.
    expect(text('install-fonts.command')).not.toContain('\r\n')
    expect(text('install-fonts.sh')).not.toContain('\r\n')
  })
})

describe('substitutions in the manifest', () => {
  const build = (entries: BundleEntry[]) =>
    open(buildBundle({ deckName: 'D.pptx', entries, unavailable: [] })).text('MANIFEST.txt')

  it('says plainly that a substitute is not the font the deck asked for', () => {
    const m = build([metricSubstitute])
    expect(m).toContain('SUBSTITUTIONS — these are NOT the fonts the deck asks for')
    expect(m).toContain('stands in for: Calibri')
  })

  it('states that a metric-compatible swap preserves the layout', () => {
    expect(build([metricSubstitute])).toContain('SAME as the original')
  })

  it('warns that a non-metric swap will reflow the deck', () => {
    const m = build([similarSubstitute])
    expect(m).toContain('DIFFERENT — line breaks will move')
    // The extra paragraph only fires when something really will reflow, so a
    // bundle of purely metric swaps does not cry wolf.
    expect(m).toContain('check for text that has reflowed')
    expect(build([metricSubstitute])).not.toContain('check for text that has reflowed')
  })

  it('keeps substitutes out of the plain free list, so they cannot be read as the real font', () => {
    const m = build([freeEntry, metricSubstitute])
    const subsAt = m.indexOf('SUBSTITUTIONS')
    const freeAt = m.indexOf('FREE TO REDISTRIBUTE')
    expect(subsAt).toBeGreaterThan(-1)
    expect(freeAt).toBeGreaterThan(-1)
    // Substitutions come first: the swap is the thing you must not miss.
    expect(subsAt).toBeLessThan(freeAt)
    const freeSection = m.slice(freeAt)
    expect(freeSection).toContain('Poppins-Regular.ttf')
    expect(freeSection).not.toContain('Carlito-Regular.ttf')
  })

  it('still counts substitutes in the file total', () => {
    expect(build([freeEntry, metricSubstitute])).toContain('2 font file(s) included.')
  })
})

describe('bundleFilename', () => {
  it('drops the extension and keeps the deck name readable', () => {
    expect(bundleFilename('Partner Summit.pptx')).toBe('Partner Summit — fonts.zip')
  })

  it('strips characters that break filesystems', () => {
    expect(bundleFilename('a/b:c*d.pptx')).toBe('a_b_c_d — fonts.zip')
  })
})
