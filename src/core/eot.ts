/**
 * Embedded OpenType (EOT) header reading, for `ppt/fonts/*.fntdata`.
 *
 * PowerPoint's "embed fonts in the file" option does NOT store a plain
 * TTF/OTF. Verified against real decks:
 *
 *   ppt/fonts/Garamond-boldItalic.fntdata
 *     len=79089  EOTSize=79089  FontDataSize=78883
 *     Version=0x00020002  Flags=0x00000004  Magic=0x504C
 *     -> TTCOMPRESSED set, and no sfnt signature (0x00010000 / 'OTTO' /
 *        'true') occurs anywhere in the part.
 *
 * Flag 0x4 is TTEMBED_TTCOMPRESSED: the tables are MicroType Express
 * compressed. Undoing that needs a full MTX decompressor, which is a project
 * in itself — so we read the header for reporting and do not attempt to
 * recover an installable font file.
 *
 * There is a licensing reason as well as a technical one. `fsType` records
 * what the foundry permitted, and permission to *embed* a font in a document
 * is not permission to extract and install it. Reporting "this font travels
 * with the deck" is the useful and lawful answer.
 */

export const EOT_MAGIC = 0x504c

export interface EotInfo {
  eotSize: number
  fontDataSize: number
  version: number
  flags: number
  /** MicroType Express compressed (TTEMBED_TTCOMPRESSED). */
  compressed: boolean
  /** Bytes are XOR-obfuscated with 0x50 (TTEMBED_XORENCRYPTDATA). */
  xorEncrypted: boolean
  fsType: number
  /** Family name from the EOT name records, when present. */
  familyName?: string
}

const TTEMBED_TTCOMPRESSED = 0x00000004
const TTEMBED_XORENCRYPTDATA = 0x10000000

/**
 * Parse an EOT header. Returns null when the bytes are not EOT — in which
 * case the caller should check for a bare sfnt signature, since a handful of
 * producers do write plain TTF into `.fntdata`.
 */
export function parseEot(bytes: Uint8Array): EotInfo | null {
  if (bytes.length < 82) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const eotSize = dv.getUint32(0, true)
  const fontDataSize = dv.getUint32(4, true)
  const version = dv.getUint32(8, true)
  const flags = dv.getUint32(12, true)
  // 10 bytes PANOSE, 1 charset, 1 italic, 4 weight, 2 fsType, 2 magic
  const fsType = dv.getUint16(32, true)
  const magic = dv.getUint16(34, true)

  if (magic !== EOT_MAGIC) return null
  // A sane EOT declares its own size.
  if (eotSize !== bytes.length && eotSize !== 0) {
    // Tolerate a mismatch but only if the rest still looks like EOT.
    if (fontDataSize > bytes.length) return null
  }

  return {
    eotSize,
    fontDataSize,
    version,
    flags,
    compressed: (flags & TTEMBED_TTCOMPRESSED) !== 0,
    xorEncrypted: (flags & TTEMBED_XORENCRYPTDATA) !== 0,
    fsType,
    familyName: readFamilyName(dv, version),
  }
}

/**
 * Best-effort family name from the EOT name records.
 *
 * Layout after the fixed header differs between versions and the records are
 * UTF-16LE with a 2-byte length and 2 bytes of padding between them. This is
 * cosmetic — the authoritative name comes from `<p:embeddedFontLst>` — so any
 * surprise just yields undefined rather than throwing.
 */
function readFamilyName(dv: DataView, version: number): string | undefined {
  try {
    let off = 36
    off += 4 // UnicodeRange1..4 -> actually 16 bytes; walk explicitly below
    off = 36 + 16 + 16 + 4 + 4 // UnicodeRange(16) CodePage(8)... conservative
    // The reliable route: version-dependent offsets are fiddly, so scan for
    // the first plausible UTF-16LE run instead.
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    for (let i = 60; i < Math.min(bytes.length - 4, 400); i += 2) {
      const len = dv.getUint16(i, true)
      if (len < 2 || len > 128 || len % 2 !== 0) continue
      if (i + 2 + len > bytes.length) continue
      let ok = true
      let out = ''
      for (let k = 0; k < len; k += 2) {
        const code = dv.getUint16(i + 2 + k, true)
        if (code < 0x20 || code > 0x2fff) {
          ok = false
          break
        }
        out += String.fromCharCode(code)
      }
      if (ok && /^[\x20-\x7e -⿿]{2,}$/.test(out) && /[A-Za-z]/.test(out)) {
        return out
      }
    }
    void version
    void off
  } catch {
    /* cosmetic only */
  }
  return undefined
}

/**
 * Recover an installable sfnt (TTF/OTF) from a `.fntdata` part, when possible.
 *
 * Two of the three producers seen in the wild are recoverable:
 *
 *   - **Uncompressed EOT** (Canva, LibreOffice): flags 0x0. The sfnt is simply
 *     the last `FontDataSize` bytes; the variable-length name records sit
 *     between the fixed header and the font data, so seeking from the *end* is
 *     what makes this reliable. Verified: a Canva deck yields a valid TTF,
 *     18 tables, family "Canva Sans".
 *   - **Bare sfnt**: a few producers skip the EOT wrapper entirely.
 *
 * MicroType-Express-compressed EOT (PowerPoint's own embedder) returns null —
 * undoing MTX needs a real decompressor and is out of scope.
 *
 * Returns null rather than throwing so callers can fall back to reporting.
 */
export function extractSfnt(bytes: Uint8Array): Uint8Array | null {
  if (isBareSfnt(bytes)) return bytes

  const info = parseEot(bytes)
  if (!info) return null
  if (info.compressed || info.xorEncrypted) return null
  if (info.fontDataSize <= 0 || info.fontDataSize > bytes.length) return null

  const start = bytes.length - info.fontDataSize
  const candidate = bytes.subarray(start)
  if (!isBareSfnt(candidate)) return null
  return candidate
}

/** True when the bytes start with a real sfnt signature. */
export function isBareSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const b = bytes
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true
  const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!)
  return tag === 'OTTO' || tag === 'true' || tag === 'ttcf'
}
