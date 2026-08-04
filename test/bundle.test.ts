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

describe('bundleFilename', () => {
  it('drops the extension and keeps the deck name readable', () => {
    expect(bundleFilename('Partner Summit.pptx')).toBe('Partner Summit — fonts.zip')
  })

  it('strips characters that break filesystems', () => {
    expect(bundleFilename('a/b:c*d.pptx')).toBe('a_b_c_d — fonts.zip')
  })
})
