import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { scanPptx } from '../src/core/scan'
import { embedPermission } from '../src/core/eot'
import { readCoverage, BASIC_LATIN_TOTAL } from '../src/core/sfnt'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const has = (name: string) => existsSync(fixture(name))
const load = (name: string) => new Uint8Array(readFileSync(fixture(name)))

const CANVA = 'canva-embedded.pptx'
const OFFICE = 'office-embedded.pptx'

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/*                                                                             */
/* The fixtures are private decks that are not committed, and between them     */
/* they cover only two of the four evidence outcomes. Building decks here      */
/* means the interesting cases — above all "declared full, measurably thin",   */
/* which no real fixture produces — are tested on a clean clone too.           */
/* -------------------------------------------------------------------------- */

/**
 * The smallest sfnt `readCoverage` can measure: a table directory, a `maxp`
 * carrying a glyph count, and a format-4 `cmap` covering exactly `ranges`.
 *
 * `idRangeOffset` is left at 0 throughout and `idDelta` maps the first
 * codepoint of each range to glyph 1, so every codepoint in a range resolves
 * to a non-zero glyph and coverage is exactly the ranges given.
 */
function makeSfnt(ranges: Array<[number, number]>, numGlyphs = 100): Uint8Array {
  const segs = [...ranges, [0xffff, 0xffff] as [number, number]]
  const segCount = segs.length
  const subLen = 16 + 8 * segCount
  const cmapLen = 12 + subLen
  const maxpLen = 6

  const dirLen = 12 + 2 * 16
  const cmapOff = dirLen
  const maxpOff = cmapOff + cmapLen
  const total = maxpOff + maxpLen

  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)

  // Offset table. searchRange and friends are not read by anything here.
  dv.setUint32(0, 0x00010000, false)
  dv.setUint16(4, 2, false)

  // Table records, sorted by tag as the spec requires: cmap, maxp.
  const rec = (i: number, tag: string, off: number, len: number) => {
    const at = 12 + i * 16
    for (let k = 0; k < 4; k++) buf[at + k] = tag.charCodeAt(k)
    dv.setUint32(at + 8, off, false)
    dv.setUint32(at + 12, len, false)
  }
  rec(0, 'cmap', cmapOff, cmapLen)
  rec(1, 'maxp', maxpOff, maxpLen)

  // cmap: one Windows-BMP encoding record pointing at a format 4 subtable.
  dv.setUint16(cmapOff, 0, false)
  dv.setUint16(cmapOff + 2, 1, false)
  dv.setUint16(cmapOff + 4, 3, false)
  dv.setUint16(cmapOff + 6, 1, false)
  dv.setUint32(cmapOff + 8, 12, false)

  const s = cmapOff + 12
  dv.setUint16(s, 4, false)
  dv.setUint16(s + 2, subLen, false)
  dv.setUint16(s + 4, 0, false)
  dv.setUint16(s + 6, segCount * 2, false)

  const endBase = s + 14
  const startBase = endBase + segCount * 2 + 2
  const deltaBase = startBase + segCount * 2
  const rangeBase = deltaBase + segCount * 2
  segs.forEach(([lo, hi], i) => {
    dv.setUint16(endBase + i * 2, hi, false)
    dv.setUint16(startBase + i * 2, lo, false)
    dv.setInt16(deltaBase + i * 2, ((1 - lo) << 16) >> 16, false)
    dv.setUint16(rangeBase + i * 2, 0, false)
  })

  // maxp 0.5 — enough for numGlyphs, which is all that is read.
  dv.setUint32(maxpOff, 0x00005000, false)
  dv.setUint16(maxpOff + 4, numGlyphs, false)

  return buf
}

const FULL_LATIN = (): Uint8Array => makeSfnt([[0x20, 0x7e]], 250)
/** Only "ABCDE" — a face cut down to the characters one deck happened to use. */
const CUT_DOWN = (): Uint8Array => makeSfnt([[0x41, 0x45]], 6)

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const rels = (entries: Array<[string, string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries
  .map(
    ([id, type, target]) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
  )
  .join('')}
</Relationships>`

/**
 * A one-slide deck naming "Test Sans", optionally embedding a face for it.
 *
 * `subsetAttr` is written verbatim so a test can assert on the exact spelling
 * a producer uses — Office writes `1`, Canva writes `true`.
 */
function makeDeck(opts: { subsetAttr?: string; fnt?: Uint8Array }): Uint8Array {
  const { subsetAttr, fnt } = opts
  const attr =
    subsetAttr === undefined
      ? ''
      : ` embedTrueTypeFonts="${subsetAttr}" saveSubsetFonts="${subsetAttr}"`

  const embedList = fnt
    ? '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Test Sans"/>' +
      '<p:regular r:id="rId9"/></p:embeddedFont></p:embeddedFontLst>'
    : ''

  const presRels: Array<[string, string, string]> = [['rId2', 'slide', 'slides/slide1.xml']]
  if (fnt) presRels.push(['rId9', 'font', 'fonts/font1.fntdata'])

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])),
    'ppt/presentation.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}${attr}>` +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
        embedList +
        '</p:presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(rels(presRels)),
    'ppt/slides/slide1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>` +
        '<p:sp><p:txBody><a:p><a:r><a:rPr lang="en-US">' +
        '<a:latin typeface="Test Sans"/></a:rPr><a:t>Hi</a:t></a:r></a:p></p:txBody></p:sp>' +
        '</p:spTree></p:cSld></p:sld>',
    ),
  }
  if (fnt) files['ppt/fonts/font1.fntdata'] = fnt

  return zipSync(files)
}

const embedOf = (deck: Uint8Array) => {
  const r = scanPptx(deck)
  return { scan: r, ef: r.embedded[0] }
}

/* -------------------------------------------------------------------------- */

describe('embedPermission — fsType decoding', () => {
  it('maps each licence level', () => {
    expect(embedPermission(0x0000)).toBe('installable')
    expect(embedPermission(0x0002)).toBe('restricted')
    expect(embedPermission(0x0004)).toBe('preview-print')
    expect(embedPermission(0x0008)).toBe('editable')
    expect(embedPermission(undefined)).toBe('unknown')
  })

  it('ignores the no-subsetting and bitmap-only modifiers', () => {
    // 0x0100 / 0x0200 sit on top of the level and must not change it.
    expect(embedPermission(0x0004 | 0x0100)).toBe('preview-print')
    expect(embedPermission(0x0008 | 0x0200)).toBe('editable')
    expect(embedPermission(0x0000 | 0x0100)).toBe('installable')
  })

  it('takes the most restrictive bit when a font sets more than one', () => {
    expect(embedPermission(0x0002 | 0x0008)).toBe('restricted')
    expect(embedPermission(0x0004 | 0x0008)).toBe('preview-print')
  })
})

describe('readCoverage', () => {
  it('counts full printable ASCII', () => {
    const c = readCoverage(FULL_LATIN())!
    expect(c.basicLatin).toBe(BASIC_LATIN_TOTAL)
    expect(c.glyphs).toBe(250)
  })

  it('counts a cut-down face exactly', () => {
    const c = readCoverage(CUT_DOWN())!
    expect(c.basicLatin).toBe(5)
    expect(c.codepoints).toBe(5)
    expect(c.glyphs).toBe(6)
  })

  it('returns null rather than throwing on bytes that are not a font', () => {
    expect(readCoverage(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(readCoverage(new Uint8Array(200))).toBeNull()
    expect(readCoverage(strToU8('not a font at all, just some text'))).toBeNull()
  })
})

describe('scanPptx — embed mode', () => {
  it('reports none when the deck embeds nothing', () => {
    const r = scanPptx(makeDeck({}))
    expect(r.embedMode).toBe('none')
    expect(r.embedded).toHaveLength(0)
  })

  it('reports full and editable when saveSubsetFonts is absent', () => {
    const { scan, ef } = embedOf(makeDeck({ fnt: FULL_LATIN() }))
    expect(scan.embedMode).toBe('full')
    expect(ef!.mode).toBe('full')
    expect(ef!.editable).toBe(true)
    expect(ef!.evidence).toBe('confirmed')
  })

  it('reports subset and not editable when saveSubsetFonts is set', () => {
    const { scan, ef } = embedOf(makeDeck({ subsetAttr: '1', fnt: CUT_DOWN() }))
    expect(scan.embedMode).toBe('subset')
    expect(ef!.mode).toBe('subset')
    expect(ef!.editable).toBe(false)
    expect(ef!.evidence).toBe('confirmed')
  })

  it('reads every ST_OnOff spelling, not just "1"', () => {
    // Office writes "1", Canva writes "true". A === '1' test loses every Canva
    // deck silently, which is why this is spelled out rather than assumed.
    for (const on of ['1', 'true', 'on', 'TRUE', 'True']) {
      expect(scanPptx(makeDeck({ subsetAttr: on, fnt: CUT_DOWN() })).embedMode).toBe('subset')
    }
    for (const off of ['0', 'false', 'off']) {
      expect(scanPptx(makeDeck({ subsetAttr: off, fnt: FULL_LATIN() })).embedMode).toBe('full')
    }
  })

  it('attaches the embedded record to the deck font that uses it', () => {
    const r = scanPptx(makeDeck({ subsetAttr: '1', fnt: CUT_DOWN() }))
    const font = r.fonts.find((f) => f.name === 'Test Sans')!
    expect(font.embedded).toBeDefined()
    expect(font.embedded!.editable).toBe(false)
  })
})

describe('scanPptx — claim versus payload', () => {
  it('flags a subset claim that ships a complete Latin face', () => {
    const { ef } = embedOf(makeDeck({ subsetAttr: '1', fnt: FULL_LATIN() }))
    expect(ef!.evidence).toBe('fuller-than-claimed')
    expect(ef!.coverage!.basicLatin).toBe(BASIC_LATIN_TOTAL)
    // The mode still follows the flag: PowerPoint restricts editing on the
    // flag, whatever the glyphs turn out to be.
    expect(ef!.editable).toBe(false)
  })

  it('flags a full claim whose payload is measurably thin', () => {
    // The dangerous direction: editing is allowed and the glyphs are absent.
    const { ef } = embedOf(makeDeck({ fnt: CUT_DOWN() }))
    expect(ef!.evidence).toBe('thinner-than-claimed')
    expect(ef!.editable).toBe(true)
    expect(ef!.coverage!.basicLatin).toBe(5)
  })

  it('reports the weakest face of a family, not the first', () => {
    // Regular is complete, bold was cut down. The family is only as usable as
    // its worst face, so that is the one that must be reported.
    const deck = zipSync({
      '_rels/.rels': strToU8(rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])),
      'ppt/presentation.xml': strToU8(
        `<?xml version="1.0"?><p:presentation ${NS}>` +
          '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
          '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Test Sans"/>' +
          '<p:regular r:id="rId9"/><p:bold r:id="rId10"/>' +
          '</p:embeddedFont></p:embeddedFontLst></p:presentation>',
      ),
      'ppt/_rels/presentation.xml.rels': strToU8(
        rels([
          ['rId2', 'slide', 'slides/slide1.xml'],
          ['rId9', 'font', 'fonts/regular.fntdata'],
          ['rId10', 'font', 'fonts/bold.fntdata'],
        ]),
      ),
      'ppt/slides/slide1.xml': strToU8(
        `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`,
      ),
      'ppt/fonts/regular.fntdata': FULL_LATIN(),
      'ppt/fonts/bold.fntdata': CUT_DOWN(),
    })
    const ef = scanPptx(deck).embedded[0]!
    expect(ef.coverage!.basicLatin).toBe(5)
    expect(ef.coverage!.part).toBe('ppt/fonts/bold.fntdata')
    expect(ef.evidence).toBe('thinner-than-claimed')
  })
})

/* -------------------------------------------------------------------------- */
/* Real decks. Skipped on a clean clone; these are the measurements the whole  */
/* design is built on, so they are asserted exactly.                           */
/* -------------------------------------------------------------------------- */

describe('scanPptx — embedding on real decks', () => {
  it.runIf(has(CANVA))('Canva declares a subset and ships a full Latin face', () => {
    const r = scanPptx(load(CANVA))
    expect(r.embedMode).toBe('subset')

    const ef = r.embedded.find((e) => e.typeface === 'Canva Sans')!
    expect(ef.mode).toBe('subset')
    expect(ef.editable).toBe(false)
    expect(ef.compressed).toBe(false)

    // Uncompressed EOT, so the payload can be measured — and it contradicts
    // the flag. 606 glyphs, 550 codepoints, all of printable ASCII.
    expect(ef.evidence).toBe('fuller-than-claimed')
    expect(ef.coverage).toBeDefined()
    expect(ef.coverage!.glyphs).toBe(606)
    expect(ef.coverage!.basicLatin).toBe(BASIC_LATIN_TOTAL)
    expect(ef.permission).toBe('installable')
  })

  it.runIf(has(OFFICE))('PowerPoint declares a subset that can never be verified', () => {
    const r = scanPptx(load(OFFICE))
    expect(r.embedMode).toBe('subset')

    for (const name of ['Garamond', 'Corbel']) {
      const ef = r.embedded.find((e) => e.typeface === name)!
      expect(ef.mode).toBe('subset')
      expect(ef.editable).toBe(false)
      // MicroType Express: nothing can be recovered, so the flag is the only
      // evidence that will ever exist for this deck.
      expect(ef.compressed).toBe(true)
      expect(ef.coverage).toBeUndefined()
      expect(ef.evidence).toBe('unverifiable')
      // Both faces carry fsType 0x0008 — the foundry permits editing even
      // though PowerPoint's subsetting is what actually prevents it.
      expect(ef.permission).toBe('editable')
    }
  })
})
