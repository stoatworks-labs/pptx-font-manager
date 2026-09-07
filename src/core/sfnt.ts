/**
 * Minimal sfnt (TTF/OTF) table reading, for measuring how much of a face
 * actually travels inside a deck.
 *
 * ## Why this exists
 *
 * `<p:presentation saveSubsetFonts="1">` is a *claim* by whoever wrote the
 * file, not a property of the bytes. Both fixture decks assert it, and they
 * mean different things by it:
 *
 *   office-embedded.pptx  saveSubsetFonts="1"  MTX-compressed, unmeasurable
 *   canva-embedded.pptx   saveSubsetFonts="1"  606 glyphs, full printable ASCII
 *
 * Canva sets the flag and then ships a complete Latin face anyway. A tool that
 * reads the flag alone would tell you that deck's text cannot be edited and
 * that adding a character will break it — wrong on the second count, and
 * exactly the confident-wrong-answer this project exists to avoid.
 *
 * So where the payload can be recovered at all we measure it, and report the
 * measurement next to the claim rather than in place of it.
 *
 * Deliberately not a font library: no shaping, no outlines, no name table
 * beyond what `eot.ts` already does. Table directory, `maxp`, `cmap`.
 *
 * Every read is bounds-checked and the whole thing returns null rather than
 * throwing — these are bytes out of a file a user dropped on the page.
 */

/** What a recovered face actually covers. */
export interface SfntCoverage {
  /** `maxp.numGlyphs`. */
  glyphs: number
  /**
   * Codepoints the cmap declares, summed across ranges.
   *
   * Approximate by design: format 4 segments can contain holes that only a
   * per-codepoint lookup would find. It is a scale indicator, nothing more —
   * `basicLatin` is the number to reason with.
   */
  codepoints: number
  /**
   * How many of the 95 printable ASCII characters (U+0020..U+007E) resolve to
   * a real glyph. Resolved one codepoint at a time, so this one is exact.
   *
   * This is the discriminator that matters. Glyph counts vary by two orders of
   * magnitude between typefaces and tell you nothing on their own, but a face
   * cut down to the characters one deck happens to use will be missing most of
   * printable ASCII, while any intact text font has all 95.
   *
   * Caveat: a symbol font mapped outside ASCII would score low without having
   * been subsetted. In practice the ones that get embedded (Wingdings and
   * relatives) map into the ASCII range too, and for the question being asked —
   * can someone type new text in this font — a low score is the right answer
   * either way.
   */
  basicLatin: number
}

const ASCII_FIRST = 0x20
const ASCII_LAST = 0x7e
export const BASIC_LATIN_TOTAL = ASCII_LAST - ASCII_FIRST + 1

/** Preference order for cmap subtables; higher wins. */
function cmapRank(platformId: number, encodingId: number): number {
  if (platformId === 3 && encodingId === 10) return 5 // Windows UCS-4
  if (platformId === 0 && encodingId >= 4) return 4 // Unicode full repertoire
  if (platformId === 3 && encodingId === 1) return 3 // Windows BMP
  if (platformId === 0) return 2 // Unicode BMP
  if (platformId === 3 && encodingId === 0) return 1 // Windows symbol
  return 0
}

/**
 * Read coverage from a bare sfnt.
 *
 * Returns null for anything that is not a single sfnt — including `ttcf`
 * collections, which never appear in `.fntdata` and are not worth the code.
 */
export function readCoverage(sfnt: Uint8Array): SfntCoverage | null {
  try {
    if (sfnt.length < 12) return null
    const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)

    const tag = dv.getUint32(0, false)
    // 0x00010000 TrueType, 'OTTO' CFF, 'true' legacy Apple.
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null

    const numTables = dv.getUint16(4, false)
    if (numTables === 0 || numTables > 512) return null

    const tables = new Map<string, { off: number; len: number }>()
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      if (rec + 16 > sfnt.length) break
      const name = String.fromCharCode(
        sfnt[rec]!,
        sfnt[rec + 1]!,
        sfnt[rec + 2]!,
        sfnt[rec + 3]!,
      )
      const off = dv.getUint32(rec + 8, false)
      const len = dv.getUint32(rec + 12, false)
      if (off + len > sfnt.length) continue
      tables.set(name, { off, len })
    }

    const maxp = tables.get('maxp')
    const glyphs = maxp && maxp.len >= 6 ? dv.getUint16(maxp.off + 4, false) : 0

    const cmap = tables.get('cmap')
    if (!cmap || cmap.len < 4) return { glyphs, codepoints: 0, basicLatin: 0 }

    const numSubtables = dv.getUint16(cmap.off + 2, false)
    let best = -1
    let bestRank = -1
    for (let i = 0; i < numSubtables; i++) {
      const rec = cmap.off + 4 + i * 8
      if (rec + 8 > sfnt.length) break
      const platformId = dv.getUint16(rec, false)
      const encodingId = dv.getUint16(rec + 2, false)
      const offset = dv.getUint32(rec + 4, false)
      const sub = cmap.off + offset
      if (sub + 4 > sfnt.length) continue
      const rank = cmapRank(platformId, encodingId)
      if (rank > bestRank) {
        bestRank = rank
        best = sub
      }
    }
    if (best < 0) return { glyphs, codepoints: 0, basicLatin: 0 }

    const format = dv.getUint16(best, false)
    if (format === 4) return { glyphs, ...walkFormat4(dv, best, sfnt.length) }
    if (format === 12) return { glyphs, ...walkFormat12(dv, best, sfnt.length) }
    if (format === 6) return { glyphs, ...walkFormat6(dv, best, sfnt.length) }
    if (format === 0) return { glyphs, ...walkFormat0(dv, best, sfnt.length) }
    return { glyphs, codepoints: 0, basicLatin: 0 }
  } catch {
    // Malformed input is an expected outcome here, not an error.
    return null
  }
}

/** Segment-mapping format, the common BMP case. */
function walkFormat4(
  dv: DataView,
  off: number,
  limit: number,
): { codepoints: number; basicLatin: number } {
  const segCountX2 = dv.getUint16(off + 6, false)
  const segCount = segCountX2 >> 1
  if (segCount === 0) return { codepoints: 0, basicLatin: 0 }

  const endBase = off + 14
  const startBase = endBase + segCountX2 + 2
  const deltaBase = startBase + segCountX2
  const rangeBase = deltaBase + segCountX2
  if (rangeBase + segCountX2 > limit) return { codepoints: 0, basicLatin: 0 }

  let codepoints = 0
  const covered = new Set<number>()

  for (let s = 0; s < segCount; s++) {
    const end = dv.getUint16(endBase + s * 2, false)
    const start = dv.getUint16(startBase + s * 2, false)
    if (start > end) continue
    // The mandatory final segment 0xFFFF..0xFFFF is padding, not coverage.
    if (start === 0xffff && end === 0xffff) continue
    codepoints += end - start + 1

    // Resolve the ASCII overlap exactly: a segment may be present while
    // individual codepoints inside it map to glyph 0.
    const lo = Math.max(start, ASCII_FIRST)
    const hi = Math.min(end, ASCII_LAST)
    if (lo > hi) continue

    const idDelta = dv.getInt16(deltaBase + s * 2, false)
    const idRangeOffsetAddr = rangeBase + s * 2
    const idRangeOffset = dv.getUint16(idRangeOffsetAddr, false)

    for (let c = lo; c <= hi; c++) {
      let glyph: number
      if (idRangeOffset === 0) {
        glyph = (c + idDelta) & 0xffff
      } else {
        const addr = idRangeOffsetAddr + idRangeOffset + (c - start) * 2
        if (addr + 2 > limit) continue
        glyph = dv.getUint16(addr, false)
        if (glyph !== 0) glyph = (glyph + idDelta) & 0xffff
      }
      if (glyph !== 0) covered.add(c)
    }
  }

  return { codepoints, basicLatin: covered.size }
}

/** Segmented coverage, used once a font goes beyond the BMP. */
function walkFormat12(
  dv: DataView,
  off: number,
  limit: number,
): { codepoints: number; basicLatin: number } {
  const nGroups = dv.getUint32(off + 12, false)
  if (nGroups > 200_000) return { codepoints: 0, basicLatin: 0 }

  let codepoints = 0
  let basicLatin = 0

  for (let g = 0; g < nGroups; g++) {
    const rec = off + 16 + g * 12
    if (rec + 12 > limit) break
    const start = dv.getUint32(rec, false)
    const end = dv.getUint32(rec + 4, false)
    const startGlyph = dv.getUint32(rec + 8, false)
    if (start > end) continue
    codepoints += end - start + 1
    // Format 12 has no hole mechanism: a group maps every codepoint in it, so
    // a run that starts at glyph 0 is the only unmapped case.
    if (startGlyph === 0) continue
    const lo = Math.max(start, ASCII_FIRST)
    const hi = Math.min(end, ASCII_LAST)
    if (lo <= hi) basicLatin += hi - lo + 1
  }

  return { codepoints, basicLatin }
}

/** Trimmed table mapping, a small contiguous run. */
function walkFormat6(
  dv: DataView,
  off: number,
  limit: number,
): { codepoints: number; basicLatin: number } {
  const first = dv.getUint16(off + 6, false)
  const count = dv.getUint16(off + 8, false)
  let codepoints = 0
  let basicLatin = 0
  for (let i = 0; i < count; i++) {
    const addr = off + 10 + i * 2
    if (addr + 2 > limit) break
    if (dv.getUint16(addr, false) === 0) continue
    const c = first + i
    codepoints++
    if (c >= ASCII_FIRST && c <= ASCII_LAST) basicLatin++
  }
  return { codepoints, basicLatin }
}

/** Byte encoding, single-byte legacy fonts. */
function walkFormat0(
  dv: DataView,
  off: number,
  limit: number,
): { codepoints: number; basicLatin: number } {
  if (off + 6 + 256 > limit) return { codepoints: 0, basicLatin: 0 }
  let codepoints = 0
  let basicLatin = 0
  for (let c = 0; c < 256; c++) {
    if (dv.getUint8(off + 6 + c) === 0) continue
    codepoints++
    if (c >= ASCII_FIRST && c <= ASCII_LAST) basicLatin++
  }
  return { codepoints, basicLatin }
}
