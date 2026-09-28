import { inflateSync, deflateSync } from 'fflate'

/**
 * Just enough of the zip format to work on a deck in place.
 *
 * `scan.ts` gets away with `unzipSync` plus a filter because fonts live in
 * small XML parts. Media does not: a real show deck here is 2 GB holding 70
 * videos, and inflating a video to find out what it is — or to hand it back to
 * the user — would double the memory for bytes that PowerPoint stored
 * uncompressed in the first place. So this reads the central directory and
 * returns `subarray` views straight into the original file wherever the entry
 * is stored (method 0), which in every deck checked is every video.
 *
 * It also rewrites an archive by copying each entry's bytes verbatim and
 * re-deflating only the parts that changed, which is how slides get hidden
 * without touching a byte of media.
 *
 * Zip64 is read (a deck over 4 GB, or with over 65,535 parts, needs it) but not
 * written: `rewriteZip` refuses an output that would need it rather than write
 * a file PowerPoint cannot open.
 */

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflate. */
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  /** Offset of this entry's record in the central directory. */
  centralOffset: number
  /** Length of the central record (46 + name + extra + comment). */
  centralLength: number
  /** True when any size or offset had to come from a zip64 extra field. */
  zip64: boolean
}

export interface ZipDirectory {
  entries: ZipEntry[]
  byName: Map<string, ZipEntry>
  zip64: boolean
}

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_EOCD64 = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8)
const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x1_0000_0000

const utf8 = new TextDecoder('utf-8')

export function readZipDirectory(file: Uint8Array): ZipDirectory {
  // The end-of-central-directory record is 22 bytes plus a comment of up to
  // 65,535, so it is somewhere in the last 65,557 bytes.
  let eocd = -1
  for (let i = file.length - 22; i >= Math.max(0, file.length - 65_557); i--) {
    if (u32(file, i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('Not a zip archive (no end-of-central-directory record).')

  let count = u16(file, eocd + 10)
  let cdOffset = u32(file, eocd + 16)
  let zip64 = false

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || u32(file, loc) !== SIG_EOCD64_LOC) {
      throw new Error('Zip64 archive with no zip64 locator.')
    }
    const rec = u64(file, loc + 8)
    if (u32(file, rec) !== SIG_EOCD64) throw new Error('Zip64 end record not found.')
    count = u64(file, rec + 32)
    cdOffset = u64(file, rec + 48)
    zip64 = true
  }

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (u32(file, p) !== SIG_CENTRAL) throw new Error('Corrupt zip central directory.')
    const flags = u16(file, p + 8)
    const method = u16(file, p + 10)
    const crc = u32(file, p + 16)
    let compressedSize = u32(file, p + 20)
    let size = u32(file, p + 24)
    const nameLen = u16(file, p + 28)
    const extraLen = u16(file, p + 30)
    const commentLen = u16(file, p + 32)
    let localOffset = u32(file, p + 42)
    const name = utf8.decode(file.subarray(p + 46, p + 46 + nameLen))

    let entry64 = false
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      // The zip64 extra holds only the fields that overflowed, in this order.
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = u16(file, e)
        const len = u16(file, e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (size === 0xffffffff) (size = u64(file, q)), (q += 8)
          if (compressedSize === 0xffffffff) (compressedSize = u64(file, q)), (q += 8)
          if (localOffset === 0xffffffff) localOffset = u64(file, q)
          entry64 = true
          break
        }
        e += 4 + len
      }
      zip64 ||= entry64
    }

    const centralLength = 46 + nameLen + extraLen + commentLen
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      centralOffset: p,
      centralLength,
      zip64: entry64,
    })
    p += centralLength
  }

  return { entries, byName: new Map(entries.map((e) => [e.name, e])), zip64 }
}

/** Where an entry's compressed bytes start, read from its local header. */
function dataStart(file: Uint8Array, e: ZipEntry): number {
  if (u32(file, e.localOffset) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${e.name}.`)
  // The local header's own name/extra lengths, which need not match the
  // central directory's.
  return e.localOffset + 30 + u16(file, e.localOffset + 26) + u16(file, e.localOffset + 28)
}

/** The raw (still-compressed) bytes of an entry — a view, not a copy. */
export function rawEntry(file: Uint8Array, e: ZipEntry): Uint8Array {
  const start = dataStart(file, e)
  return file.subarray(start, start + e.compressedSize)
}

/**
 * An entry's uncompressed bytes. For a stored entry this is a view into
 * `file` — no copy — so a 100 MB video costs nothing to look at.
 */
export function entryData(file: Uint8Array, e: ZipEntry): Uint8Array {
  const raw = rawEntry(file, e)
  if (e.method === 0) return raw
  if (e.method === 8) return inflateSync(raw, { out: new Uint8Array(e.size) })
  throw new Error(`${e.name} uses zip compression method ${e.method}, which is not supported.`)
}

// ---------------------------------------------------------------------------
// Writing

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function put16(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
}
function put32(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
  b[o + 2] = (v >>> 16) & 0xff
  b[o + 3] = (v >>> 24) & 0xff
}

const LIMIT_32 = 0xffffffff

/** Length of an entry's whole local record: header, data and any descriptor. */
function localRecordLength(file: Uint8Array, e: ZipEntry): number {
  const start = dataStart(file, e)
  let end = start + e.compressedSize
  if (e.flags & 0x8) {
    // Data descriptor: crc + two sizes, optionally preceded by a signature.
    end += u32(file, end) === SIG_DESCRIPTOR ? 16 : 12
  }
  return end - e.localOffset
}

/**
 * Rewrite an archive with some parts replaced.
 *
 * Every other entry is copied byte for byte — header, data, descriptor — so
 * media, fonts and everything PowerPoint put there come out identical.
 * Replaced entries are deflated afresh. The central directory is rebuilt from
 * the original records with offsets (and, for replaced parts, the CRC, sizes
 * and method) patched.
 *
 * Returns the archive as a list of chunks, most of them views into `file`,
 * because concatenating a 2 GB deck into one new buffer would double the
 * memory for no reason. `new Blob(chunks)` assembles it.
 */
export function rewriteZip(
  file: Uint8Array,
  dir: ZipDirectory,
  replace: Map<string, Uint8Array>,
): Uint8Array[] {
  if (dir.zip64) {
    throw new Error(
      'This presentation is stored in the zip64 format (over 4 GB, or a very large number of ' +
        'parts), which this tool can read but not rewrite.',
    )
  }
  for (const name of replace.keys()) {
    if (!dir.byName.has(name)) throw new Error(`No part named ${name} to replace.`)
  }

  const out: Uint8Array[] = []
  let offset = 0
  const newOffset = new Map<ZipEntry, number>()
  const patched = new Map<ZipEntry, { crc: number; csize: number; size: number; flags: number }>()

  // Copy in the order entries appear in the file, not directory order: they
  // usually agree, but nothing requires it.
  const byPosition = [...dir.entries].sort((a, b) => a.localOffset - b.localOffset)
  for (const e of byPosition) {
    newOffset.set(e, offset)
    const data = replace.get(e.name)
    if (!data) {
      const len = localRecordLength(file, e)
      out.push(file.subarray(e.localOffset, e.localOffset + len))
      offset += len
      continue
    }
    const deflated = deflateSync(data, { level: 6 })
    const crc = crc32(data)
    const nameBytes = file.subarray(e.centralOffset + 46, e.centralOffset + 46 + u16(file, e.centralOffset + 28))
    // Keep the UTF-8 name flag; drop the descriptor flag, since the sizes are
    // now known up front.
    const flags = e.flags & 0x0800
    const head = new Uint8Array(30 + nameBytes.length)
    put32(head, 0, SIG_LOCAL)
    put16(head, 4, 20)
    put16(head, 6, flags)
    put16(head, 8, 8)
    put16(head, 10, u16(file, e.centralOffset + 12)) // time
    put16(head, 12, u16(file, e.centralOffset + 14)) // date
    put32(head, 14, crc)
    put32(head, 18, deflated.length)
    put32(head, 22, data.length)
    put16(head, 26, nameBytes.length)
    put16(head, 28, 0)
    head.set(nameBytes, 30)
    out.push(head, deflated)
    offset += head.length + deflated.length
    patched.set(e, { crc, csize: deflated.length, size: data.length, flags })
  }

  const cdStart = offset
  for (const e of dir.entries) {
    const rec = new Uint8Array(file.subarray(e.centralOffset, e.centralOffset + e.centralLength))
    const at = newOffset.get(e)!
    if (at > LIMIT_32) throw new Error('The rewritten presentation would need zip64, which is not supported.')
    put32(rec, 42, at)
    const p = patched.get(e)
    if (p) {
      put16(rec, 6, 20)
      put16(rec, 8, p.flags)
      put16(rec, 10, 8)
      put32(rec, 16, p.crc)
      put32(rec, 20, p.csize)
      put32(rec, 24, p.size)
    }
    out.push(rec)
    offset += rec.length
  }

  out.push(endRecord(dir.entries.length, offset - cdStart, cdStart))
  return out
}

function endRecord(count: number, cdSize: number, cdStart: number): Uint8Array {
  if (count > 0xffff || cdStart > LIMIT_32) {
    throw new Error('The archive would need zip64, which is not supported.')
  }
  const end = new Uint8Array(22)
  put32(end, 0, SIG_EOCD)
  put16(end, 8, count)
  put16(end, 10, count)
  put32(end, 12, cdSize)
  put32(end, 16, cdStart)
  return end
}

/**
 * Build a zip of files stored without compression.
 *
 * For handing videos back: they are already compressed, deflating them again
 * gains nothing, and storing lets each file's bytes be a view into the deck.
 */
export function storedZip(
  files: Array<{ name: string; data: Uint8Array; crc?: number }>,
): Uint8Array[] {
  const enc = new TextEncoder()
  const out: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  for (const f of files) {
    const name = enc.encode(f.name)
    // A file lifted out of the deck already has its CRC in the deck's own
    // directory; recomputing it over 2 GB of video is seconds of nothing.
    const crc = f.crc ?? crc32(f.data)
    if (offset > LIMIT_32 || f.data.length > LIMIT_32) {
      throw new Error('Too much media for one zip (over 4 GB). Save the files one at a time.')
    }
    const head = new Uint8Array(30 + name.length)
    put32(head, 0, SIG_LOCAL)
    put16(head, 4, 20)
    put16(head, 6, 0x0800)
    put16(head, 8, 0)
    put16(head, 10, dosTime)
    put16(head, 12, dosDate)
    put32(head, 14, crc)
    put32(head, 18, f.data.length)
    put32(head, 22, f.data.length)
    put16(head, 26, name.length)
    head.set(name, 30)

    const cen = new Uint8Array(46 + name.length)
    put32(cen, 0, SIG_CENTRAL)
    put16(cen, 4, 20)
    put16(cen, 6, 20)
    put16(cen, 8, 0x0800)
    put16(cen, 10, 0)
    put16(cen, 12, dosTime)
    put16(cen, 14, dosDate)
    put32(cen, 16, crc)
    put32(cen, 20, f.data.length)
    put32(cen, 24, f.data.length)
    put16(cen, 28, name.length)
    put32(cen, 42, offset)
    cen.set(name, 46)

    out.push(head, f.data)
    central.push(cen)
    offset += head.length + f.data.length
  }
  const cdStart = offset
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  return [...out, ...central, endRecord(files.length, cdSize, cdStart)]
}
