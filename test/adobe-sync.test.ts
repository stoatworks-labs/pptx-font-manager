import { describe, it, expect } from 'vitest'
import { isAdobeSyncPath, adobeSyncedFamilies } from '../src/platform/adobe-sync'

/**
 * The whole point of this module is to separate two fonts that look identical
 * to the OS: one Windows and macOS both ship, and one Creative Cloud syncs onto
 * exactly this machine. Nothing but the file path distinguishes them, so these
 * tests are about paths and nothing else.
 *
 * NOT VERIFIED against a real synced font. The `.r` directory on the machine
 * this was written on exists and is empty — nothing is activated in Creative
 * Cloud — so the positive case here uses a hand-written path of the documented
 * shape. Confirming it end to end needs a font activated in Creative Cloud and
 * a rescan; see AGENTS.md §11.
 */

const MAC_SYNCED =
  '/Users/someone/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/2ZQVDGB'
const WIN_SYNCED =
  'C:\\Users\\someone\\AppData\\Roaming\\Adobe\\CoreSync\\plugins\\livetype\\r\\2ZQVDGB'

describe('isAdobeSyncPath', () => {
  it('recognises the macOS CoreSync store', () => {
    expect(isAdobeSyncPath(MAC_SYNCED)).toBe(true)
  })

  it('recognises the Windows CoreSync store, backslashes and all', () => {
    expect(isAdobeSyncPath(WIN_SYNCED)).toBe(true)
  })

  // The leaf is `.r` on macOS and `r` on Windows. Keying on the leaf would
  // therefore need two rules, and a bare `r` is far too generic to key on at
  // all — hence matching the four-directory chain above it.
  it('does not care whether the leaf is .r or r', () => {
    expect(isAdobeSyncPath('/x/Adobe/CoreSync/plugins/livetype/.r/AAA')).toBe(true)
    expect(isAdobeSyncPath('/x/Adobe/CoreSync/plugins/livetype/r/AAA')).toBe(true)
  })

  // Both platforms' default filesystems are case-insensitive, so a literal
  // prefix comparison would miss a path the OS considers the same one.
  it('matches regardless of case', () => {
    expect(isAdobeSyncPath(MAC_SYNCED.toLowerCase())).toBe(true)
    expect(isAdobeSyncPath(MAC_SYNCED.toUpperCase())).toBe(true)
  })

  it('is unmoved by a relocated or symlinked home directory', () => {
    // Building the expected prefix from $HOME is the obvious implementation
    // and the wrong one: /Volumes/Work is still the same CoreSync store.
    expect(
      isAdobeSyncPath('/Volumes/Work/me/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/AAA'),
    ).toBe(true)
  })

  describe('says no to an ordinary installed font', () => {
    it.each([
      '/Users/someone/Library/Fonts/ProximaNova-Regular.otf',
      '/System/Library/Fonts/Times.ttc',
      '/Library/Fonts/Microsoft/Calibri.ttf',
      'C:\\Windows\\Fonts\\times.ttf',
    ])('%s', (path) => {
      expect(isAdobeSyncPath(path)).toBe(false)
    })
  })

  it('is not fooled by Adobe elsewhere in the path', () => {
    // Adobe installs plenty of ordinary, redistributable fonts outside
    // CoreSync. Only the sync store means "this cannot travel".
    expect(isAdobeSyncPath('/Library/Application Support/Adobe/Fonts/SourceSansPro.otf')).toBe(false)
    expect(isAdobeSyncPath('/Users/someone/Library/Fonts/livetype.ttf')).toBe(false)
    expect(isAdobeSyncPath('/Users/someone/livetype/CoreSync/plugins/Adobe/x.otf')).toBe(false)
  })

  it('treats no path as no evidence', () => {
    expect(isAdobeSyncPath(null)).toBe(false)
    expect(isAdobeSyncPath(undefined)).toBe(false)
    expect(isAdobeSyncPath('')).toBe(false)
  })
})

describe('adobeSyncedFamilies', () => {
  it('names only the families backed by a synced file', () => {
    const synced = adobeSyncedFamilies([
      { family: 'Proxima Nova', path: MAC_SYNCED },
      { family: 'Times New Roman', path: '/System/Library/Fonts/Times.ttc' },
      { family: 'Poppins', path: null },
    ])
    expect([...synced]).toEqual(['Proxima Nova'])
  })

  it('counts every face of a family that only exists in the sync store', () => {
    const synced = adobeSyncedFamilies([
      { family: 'Proxima Nova', path: MAC_SYNCED },
      { family: 'Proxima Nova', path: WIN_SYNCED },
    ])
    expect(synced.has('Proxima Nova')).toBe(true)
  })

  /**
   * The trap this rule exists for. A subscriber can activate Times New Roman
   * on Adobe Fonts — Monotype really does sell it there — and end up with both
   * the synced file and the one the OS ships. Treating "has a synced file" as
   * "will break elsewhere" would then announce that Times New Roman cannot
   * travel, which is the §2.2 false alarm in a new costume.
   */
  it('stays quiet when the family also has an ordinary local file', () => {
    const synced = adobeSyncedFamilies([
      { family: 'Times New Roman', path: '/System/Library/Fonts/Supplemental/Times New Roman.ttf' },
      { family: 'Times New Roman', path: MAC_SYNCED },
    ])
    expect(synced.size).toBe(0)
  })

  it('does not let a path-less face silence a real warning', () => {
    const synced = adobeSyncedFamilies([
      { family: 'Proxima Nova', path: MAC_SYNCED },
      { family: 'Proxima Nova', path: null },
    ])
    expect(synced.has('Proxima Nova')).toBe(true)
  })
})
