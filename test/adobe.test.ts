import { describe, it, expect } from 'vitest'
import {
  findAdobeFamily,
  adobeBundleNote,
  ADOBE_COUNT,
  ADOBE_LIBRARY_TOTAL,
} from '../src/core/adobe'
import { parseFontName } from '../src/core/names'

const look = (n: string) => findAdobeFamily(parseFontName(n))

/** A plain, unembedded deck font, as the scanner would report it. */
const deckFont = (name: string) => ({
  name,
  family: name,
  weight: 400,
  italic: false,
  tier: 'slide' as const,
  origins: [],
  count: 1,
})

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
    const installed = {
      families: new Set(['Times New Roman']),
      faces: new Set<string>(),
      method: 'local-font-access' as const,
    }
    const r = resolveFont(deckFont('Times New Roman'), installed as never)
    expect(r.state).toBe('installed')
    expect(r.adobe).toBeUndefined()
  })

  /**
   * The reason the flag keys on a file path and not on the catalogue: an
   * installed Adobe-only font is invisible without one. On the web build, and
   * on any desktop shell that reports no paths, this stays silent rather than
   * guessing — the alternative is the Times New Roman false alarm above.
   */
  it('and an installed font with no path information stays silent too', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const r = resolveFont(deckFont('Proxima Nova'), {
      families: new Set(['Proxima Nova']),
      faces: new Set<string>(),
      method: 'local-font-access' as const,
    } as never)
    expect(r.state).toBe('installed')
    expect(r.installedViaAdobeSync).toBe(false)
    expect(r.adobe).toBeUndefined()
  })

  it('but a missing one still gets its activation link', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const empty = {
      families: new Set<string>(),
      faces: new Set<string>(),
      method: 'local-font-access' as const,
    }
    const r = resolveFont(deckFont('Proxima Nova'), empty as never)
    expect(r.state).toBe('missing')
    expect(r.adobe?.family).toBe('Proxima Nova')
  })
})

/**
 * The warning §11 had to drop, and how it comes back.
 *
 * The dangerous deck is not the one with a missing font — the author can see
 * that. It is the one whose fonts are all present *because Creative Cloud syncs
 * them here*, which renders perfectly on the authoring machine and breaks at
 * the venue. The desktop shell now reports font file paths, so a face living in
 * Adobe's CoreSync store can be told from one the OS ships, and that — not a
 * catalogue hit — is what licences the warning.
 *
 * NOT VERIFIED against a real synced font: the CoreSync `.r` directory on the
 * machine this was written on is empty, because nothing is activated in
 * Creative Cloud. These tests drive `resolveFont` with an inventory of the
 * shape `nativeInventory` builds. Confirming the whole path end to end needs a
 * font activated in Creative Cloud and a rescan on the desktop build.
 */
describe('a Creative Cloud-synced font, which is installed AND cannot travel', () => {
  const nativeInventory = (families: string[], synced: string[]) =>
    ({
      families: new Set(families),
      faces: new Set<string>(),
      method: 'native' as const,
      adobeSynced: new Set(synced),
    }) as never

  it('is flagged even though it is installed', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const r = resolveFont(
      deckFont('Proxima Nova'),
      nativeInventory(['Proxima Nova'], ['Proxima Nova']),
    )
    expect(r.state).toBe('installed')
    expect(r.installedViaAdobeSync).toBe(true)
    expect(r.adobe?.family).toBe('Proxima Nova')
  })

  it('is flagged when the deck asked for a weight, not just the family', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const r = resolveFont(
      deckFont('Proxima Nova Bold'),
      nativeInventory(['Proxima Nova'], ['Proxima Nova']),
    )
    // family-installed, not installed — and just as absent at the venue.
    expect(r.state).toBe('family-installed')
    expect(r.installedViaAdobeSync).toBe(true)
    expect(r.adobe?.family).toBe('Proxima Nova')
  })

  it('matches the family through the OS spelling, not by string equality', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const r = resolveFont(deckFont('Proxima-Nova'), nativeInventory(['Proxima Nova'], ['Proxima Nova']))
    expect(r.installedViaAdobeSync).toBe(true)
  })

  it('leaves every other installed font alone', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    // Times New Roman is in the Adobe catalogue and installed here, but its
    // file is not in the sync store — so nothing is said about it.
    const r = resolveFont(
      deckFont('Times New Roman'),
      nativeInventory(['Times New Roman', 'Proxima Nova'], ['Proxima Nova']),
    )
    expect(r.installedViaAdobeSync).toBe(false)
    expect(r.adobe).toBeUndefined()
  })

  it('says nothing when the family is free to download anyway', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    // Plenty of Adobe Fonts families are also on Google Fonts under OFL —
    // Source Code Pro, Alegreya, and 1,200-odd others. Sending the user to a
    // subscription for a font the bundle can simply include would be actively
    // unhelpful, so the Adobe note stands down even here.
    const r = resolveFont(
      deckFont('Source Code Pro'),
      nativeInventory(['Source Code Pro'], ['Source Code Pro']),
    )
    expect(r.installedViaAdobeSync).toBe(true)
    expect(r.google?.downloadable).toBe(true)
    expect(r.adobe).toBeUndefined()
  })

  it('an embedded font is never flagged — it travels inside the deck', async () => {
    const { resolveFont } = await import('../src/lib/resolve')
    const font = { ...deckFont('Proxima Nova'), embedded: { extracted: [] } }
    const r = resolveFont(font as never, nativeInventory(['Proxima Nova'], ['Proxima Nova']))
    expect(r.state).toBe('embedded')
    expect(r.installedViaAdobeSync).toBe(false)
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
