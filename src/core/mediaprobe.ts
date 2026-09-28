/**
 * What a media file actually is, and whether PowerPoint can play it.
 *
 * The file extension says almost nothing. `.mp4` holds H.264 that plays
 * everywhere, HEVC that needs a paid extension on Windows, or 10-bit H.264
 * that plays nowhere in PowerPoint at all — and they all look the same in the
 * Insert Video dialog. So this reads the container: box structure for
 * MP4/MOV, the header GUID for ASF, the RIFF chunks for AVI and WAV, and
 * magic numbers for the rest.
 *
 * ## Where the playback table comes from
 *
 * PowerPoint does not decode video itself. On Windows it hands the file to
 * Media Foundation, on the Mac to AVFoundation, so "can PowerPoint play it" is
 * "does that OS framework have a decoder for this codec in this container".
 * The verdicts below are that, cross-checked against Microsoft's published
 * list of formats PowerPoint accepts and its standing advice — MP4, H.264
 * video, AAC audio — which is the one combination that is `yes` on both.
 *
 * Where a verdict is not certain it says `unknown` rather than guessing, and
 * `extension` means "only with an optional codec pack installed", which on a
 * venue's playback machine is as good as `no` until someone checks.
 */

export type Playback = 'yes' | 'extension' | 'no' | 'unknown'

export type Container =
  | 'mp4'
  | 'mov'
  | 'asf'
  | 'avi'
  | 'mpeg-ps'
  | 'mpeg-ts'
  | 'mkv'
  | 'webm'
  | 'swf'
  | 'mp3'
  | 'wav'
  | 'aiff'
  | 'flac'
  | 'ogg'
  | 'midi'
  | 'unknown'

export interface VideoStream {
  /** FourCC as stored, e.g. `avc1`, `hvc1`, `apcn`. */
  fourcc: string
  codec: string
  profile?: string
  bitDepth?: number
  /** `4:2:0`, `4:2:2`, `4:4:4`, when the codec config says. */
  chroma?: string
  width?: number
  height?: number
  fps?: number
}

export interface AudioStream {
  fourcc: string
  codec: string
  channels?: number
  sampleRate?: number
}

export interface MediaProbe {
  container: Container
  /** Human label: "MPEG-4", "QuickTime", "Windows Media (ASF)". */
  containerLabel: string
  video?: VideoStream
  audio?: AudioStream
  durationSec?: number
}

export interface Compat {
  windows: Playback
  mac: Playback
  /** good: plays on both. caution: needs checking somewhere. bad: fails somewhere. */
  verdict: 'good' | 'caution' | 'bad'
  issues: string[]
}

const CONTAINER_LABEL: Record<Container, string> = {
  mp4: 'MPEG-4',
  mov: 'QuickTime',
  asf: 'Windows Media (ASF)',
  avi: 'AVI',
  'mpeg-ps': 'MPEG program stream',
  'mpeg-ts': 'MPEG transport stream',
  mkv: 'Matroska',
  webm: 'WebM',
  swf: 'Flash (SWF)',
  mp3: 'MP3',
  wav: 'WAV',
  aiff: 'AIFF',
  flac: 'FLAC',
  ogg: 'Ogg',
  midi: 'MIDI',
  unknown: 'Unknown',
}

const ascii = (b: Uint8Array, o: number, n: number) => {
  let s = ''
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]!)
  return s
}
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!
const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u64be = (b: Uint8Array, o: number) => u32be(b, o) * 0x1_0000_0000 + u32be(b, o + 4)
const u32le = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0

/** Sniff the container from the first bytes. Needs at most 16. */
export function sniffContainer(head: Uint8Array): Container {
  if (head.length < 4) return 'unknown'
  const t4 = ascii(head, 4, 4)
  if (t4 === 'ftyp') return ascii(head, 8, 4) === 'qt  ' ? 'mov' : 'mp4'
  // QuickTime files from older tools start with a moov/mdat/wide/free box
  // and no ftyp at all.
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(t4)) return 'mov'
  if (u32be(head, 0) === 0x3026b275 && u32be(head, 4) === 0x8e66cf11) return 'asf'
  const t0 = ascii(head, 0, 4)
  if (t0 === 'RIFF') {
    const form = ascii(head, 8, 4)
    if (form === 'AVI ') return 'avi'
    if (form === 'WAVE') return 'wav'
  }
  if (t0 === 'FORM' && /^AIF[FC]$/.test(ascii(head, 8, 4))) return 'aiff'
  if (u32be(head, 0) === 0x000001ba) return 'mpeg-ps'
  if (head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return 'mpeg-ts'
  if (u32be(head, 0) === 0x1a45dfa3) {
    // EBML: WebM says so in its DocType; everything else is Matroska.
    return ascii(head, 0, Math.min(head.length, 64)).includes('webm') ? 'webm' : 'mkv'
  }
  if (/^[FCZ]WS$/.test(ascii(head, 0, 3))) return 'swf'
  if (t0 === 'fLaC') return 'flac'
  if (t0 === 'OggS') return 'ogg'
  if (t0 === 'MThd') return 'midi'
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return 'mp3'
  return 'unknown'
}

export function probeMedia(data: Uint8Array): MediaProbe {
  const container = sniffContainer(data.subarray(0, 256))
  const probe: MediaProbe = { container, containerLabel: CONTAINER_LABEL[container] }
  try {
    if (container === 'mp4' || container === 'mov') readIsoBmff(data, probe)
    else if (container === 'avi') readAvi(data, probe)
    else if (container === 'asf') {
      probe.video = { fourcc: '', codec: 'Windows Media Video' }
    }
  } catch {
    // A truncated or odd file still gets its container verdict; the codec
    // just stays unknown, and the compatibility check says so.
  }
  return probe
}

// ---------------------------------------------------------------------------
// MP4 / MOV

const VIDEO_CODECS: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC (H.265)',
  hev1: 'HEVC (H.265)',
  dvh1: 'HEVC (Dolby Vision)',
  dvhe: 'HEVC (Dolby Vision)',
  av01: 'AV1',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Part 2',
  apco: 'ProRes 422 Proxy',
  apcs: 'ProRes 422 LT',
  apcn: 'ProRes 422',
  apch: 'ProRes 422 HQ',
  ap4h: 'ProRes 4444',
  ap4x: 'ProRes 4444 XQ',
  aprn: 'ProRes RAW',
  Hap1: 'HAP',
  Hap5: 'HAP Alpha',
  HapY: 'HAP Q',
  HapM: 'HAP Q Alpha',
  HapA: 'HAP Alpha-only',
  AVdn: 'DNxHD',
  AVdh: 'DNxHR',
  jpeg: 'Motion JPEG',
  mjpa: 'Motion JPEG',
  mjpb: 'Motion JPEG',
  'png ': 'PNG sequence',
  'rle ': 'Animation (RLE)',
  'raw ': 'Uncompressed',
  '2vuy': 'Uncompressed 4:2:2',
  v210: 'Uncompressed 10-bit 4:2:2',
  cvid: 'Cinepak',
  'SVQ3': 'Sorenson Video 3',
  h263: 'H.263',
  s263: 'H.263',
  mp2v: 'MPEG-2',
  xdvc: 'XDCAM',
}

const AUDIO_CODECS: Record<string, string> = {
  mp4a: 'AAC',
  'ac-3': 'Dolby Digital (AC-3)',
  'ec-3': 'Dolby Digital Plus',
  alac: 'Apple Lossless',
  lpcm: 'PCM',
  sowt: 'PCM',
  twos: 'PCM',
  in24: 'PCM 24-bit',
  in32: 'PCM 32-bit',
  fl32: 'PCM float',
  fl64: 'PCM float',
  'raw ': 'PCM',
  Opus: 'Opus',
  fLaC: 'FLAC',
  '.mp3': 'MP3',
  ima4: 'IMA ADPCM',
  samr: 'AMR',
}

const AVC_PROFILES: Record<number, string> = {
  66: 'Baseline',
  77: 'Main',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  122: 'High 4:2:2',
  244: 'High 4:4:4',
  44: 'CAVLC 4:4:4',
}

interface Box {
  type: string
  start: number
  /** Payload start (after the header). */
  body: number
  end: number
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let p = from
  while (p + 8 <= to) {
    let size = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    let header = 8
    if (size === 1) {
      if (p + 16 > to) return
      size = u64be(b, p + 8)
      header = 16
    } else if (size === 0) {
      size = to - p
    }
    if (size < header) return
    const end = Math.min(p + size, to)
    yield { type, start: p, body: p + header, end }
    p = p + size
  }
}

function child(b: Uint8Array, box: Box, type: string): Box | undefined {
  for (const c of boxes(b, box.body, box.end)) if (c.type === type) return c
  return undefined
}

function readIsoBmff(b: Uint8Array, probe: MediaProbe) {
  let moov: Box | undefined
  for (const top of boxes(b, 0, b.length)) {
    if (top.type === 'moov') {
      moov = top
      break
    }
  }
  if (!moov) return

  const mvhd = child(b, moov, 'mvhd')
  if (mvhd) {
    const v = b[mvhd.body]!
    const timescale = v === 1 ? u32be(b, mvhd.body + 20) : u32be(b, mvhd.body + 12)
    const duration = v === 1 ? u64be(b, mvhd.body + 24) : u32be(b, mvhd.body + 16)
    if (timescale > 0) probe.durationSec = duration / timescale
  }

  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = child(b, trak, 'mdia')
    if (!mdia) continue
    const hdlr = child(b, mdia, 'hdlr')
    const handler = hdlr ? ascii(b, hdlr.body + 8, 4) : ''
    const mdhd = child(b, mdia, 'mdhd')
    const minf = child(b, mdia, 'minf')
    const stbl = minf && child(b, minf, 'stbl')
    const stsd = stbl && child(b, stbl, 'stsd')
    if (!stsd) continue
    // stsd: version/flags(4) entry_count(4), then the first sample entry.
    const entry = stsd.body + 8
    if (entry + 8 > stsd.end) continue
    const entrySize = u32be(b, entry)
    const fourcc = ascii(b, entry + 4, 4)
    const entryEnd = Math.min(entry + entrySize, stsd.end)

    if (handler === 'vide' && !probe.video) {
      const video: VideoStream = { fourcc, codec: VIDEO_CODECS[fourcc] ?? `unrecognised (${fourcc.trim()})` }
      // VisualSampleEntry: 8 header + 16 reserved/predefined, then w, h.
      video.width = u16be(b, entry + 32)
      video.height = u16be(b, entry + 34)
      // Codec configuration boxes follow the 78-byte visual fields.
      for (const c of boxes(b, entry + 86, entryEnd)) {
        if (c.type === 'avcC') readAvcC(b, c, video)
        else if (c.type === 'hvcC') readHvcC(b, c, video)
      }
      if (fourcc.startsWith('ap')) video.chroma = fourcc.startsWith('ap4') ? '4:4:4' : '4:2:2'
      const fps = frameRate(b, stbl!, mdhd)
      if (fps) video.fps = fps
      probe.video = video
    } else if (handler === 'soun' && !probe.audio) {
      const audio: AudioStream = { fourcc, codec: AUDIO_CODECS[fourcc] ?? `unrecognised (${fourcc.trim()})` }
      // AudioSampleEntry: 8 header + 8 reserved/dataref + 8 version/vendor,
      // then channels(2) samplesize(2) predefined(2) reserved(2) rate(16.16).
      audio.channels = u16be(b, entry + 24)
      audio.sampleRate = u16be(b, entry + 32)
      if (fourcc === 'mp4a') {
        // The ES descriptor's object type separates AAC (0x40) from MP3 in MP4
        // (0x69 / 0x6B). Search for it rather than parse the descriptor tree.
        const oti = esdsObjectType(b, entry + 36, entryEnd)
        if (oti === 0x69 || oti === 0x6b) audio.codec = 'MP3'
      }
      probe.audio = audio
    }
  }
}

function readAvcC(b: Uint8Array, box: Box, v: VideoStream) {
  const profile = b[box.body + 1]!
  v.profile = AVC_PROFILES[profile] ?? `profile ${profile}`
  v.bitDepth = profile === 110 || profile === 122 || profile === 244 ? 10 : 8
  v.chroma = profile === 122 ? '4:2:2' : profile === 244 || profile === 44 ? '4:4:4' : '4:2:0'
  if (profile >= 100) {
    // High-profile avcC carries the real chroma format and bit depth after
    // the SPS/PPS lists; a High 10 stream may well be 8-bit in practice.
    let p = box.body + 5
    const nSps = b[p]! & 0x1f
    p++
    for (let i = 0; i < nSps; i++) p += 2 + u16be(b, p)
    const nPps = b[p]!
    p++
    for (let i = 0; i < nPps; i++) p += 2 + u16be(b, p)
    if (p + 3 <= box.end) {
      v.chroma = ['4:0:0', '4:2:0', '4:2:2', '4:4:4'][b[p]! & 3]
      v.bitDepth = (b[p + 1]! & 7) + 8
    }
  }
}

function readHvcC(b: Uint8Array, box: Box, v: VideoStream) {
  const idc = b[box.body + 1]! & 0x1f
  v.profile = idc === 1 ? 'Main' : idc === 2 ? 'Main 10' : idc === 3 ? 'Main Still' : idc === 4 ? 'Range Extensions' : `profile ${idc}`
  v.chroma = ['4:0:0', '4:2:0', '4:2:2', '4:4:4'][b[box.body + 16]! & 3]
  v.bitDepth = (b[box.body + 17]! & 7) + 8
}

function esdsObjectType(b: Uint8Array, from: number, to: number): number | undefined {
  const at = findAscii(b, 'esds', from, to)
  if (at === -1) return undefined
  // Full box header (4) after the type, then an ES_Descriptor (tag 3).
  let p = at + 8
  const skipSize = () => {
    while (p < to && b[p]! & 0x80) p++
    p++
  }
  if (b[p] !== 0x03) return undefined
  p++
  skipSize()
  const flags = b[p + 2]!
  p += 3 // ES_ID(2) + flags(1)
  if (flags & 0x80) p += 2 // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + b[p]! // URL
  if (flags & 0x20) p += 2 // OCR_ES_Id
  if (b[p] !== 0x04) return undefined // DecoderConfigDescriptor
  p++
  skipSize()
  return p < to ? b[p] : undefined
}

/** Average frame rate from the sample-time table: frames / seconds. */
function frameRate(b: Uint8Array, stbl: Box, mdhd: Box | undefined): number | undefined {
  if (!mdhd) return undefined
  const v = b[mdhd.body]!
  const timescale = v === 1 ? u32be(b, mdhd.body + 20) : u32be(b, mdhd.body + 12)
  const stts = child(b, stbl, 'stts')
  if (!stts || !timescale) return undefined
  const n = u32be(b, stts.body + 4)
  let frames = 0
  let ticks = 0
  for (let i = 0; i < n; i++) {
    const at = stts.body + 8 + i * 8
    if (at + 8 > stts.end) break
    const count = u32be(b, at)
    frames += count
    ticks += count * u32be(b, at + 4)
  }
  if (!frames || !ticks) return undefined
  return Math.round((frames / (ticks / timescale)) * 100) / 100
}

// ---------------------------------------------------------------------------
// AVI: the video stream's handler FourCC, from the first `strh` of type vids.

const AVI_CODECS: Record<string, string> = {
  xvid: 'Xvid (MPEG-4 Part 2)',
  divx: 'DivX (MPEG-4 Part 2)',
  dx50: 'DivX (MPEG-4 Part 2)',
  mp42: 'Microsoft MPEG-4 v2',
  mp43: 'Microsoft MPEG-4 v3',
  h264: 'H.264',
  x264: 'H.264',
  avc1: 'H.264',
  mjpg: 'Motion JPEG',
  dvsd: 'DV',
  cvid: 'Cinepak',
  iv50: 'Indeo 5',
  wmv3: 'Windows Media Video 9',
}

function readAvi(b: Uint8Array, probe: MediaProbe) {
  const limit = Math.min(b.length, 64 * 1024)
  for (let p = 12; p + 64 < limit; p++) {
    if (b[p] === 0x73 && ascii(b, p, 4) === 'strh' && ascii(b, p + 8, 4) === 'vids') {
      const fcc = ascii(b, p + 12, 4)
      probe.video = {
        fourcc: fcc,
        codec: AVI_CODECS[fcc.toLowerCase()] ?? `unrecognised (${fcc.trim() || 'none'})`,
      }
      // avih (the main header) sits before the streams: width/height at +40/+44.
      const avih = findAscii(b, 'avih', 12, limit)
      if (avih !== -1) {
        probe.video.width = u32le(b, avih + 8 + 32)
        probe.video.height = u32le(b, avih + 8 + 36)
        const usPerFrame = u32le(b, avih + 8)
        if (usPerFrame) probe.video.fps = Math.round((1e6 / usPerFrame) * 100) / 100
      }
      return
    }
  }
}

function findAscii(b: Uint8Array, s: string, from: number, to: number): number {
  outer: for (let p = from; p + s.length <= to; p++) {
    for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) continue outer
    return p
  }
  return -1
}

// ---------------------------------------------------------------------------
// Verdict

const worst = (a: Playback, b: Playback): Playback => {
  const rank: Record<Playback, number> = { yes: 0, unknown: 1, extension: 2, no: 3 }
  return rank[a] >= rank[b] ? a : b
}

export function assessCompat(p: MediaProbe): Compat {
  const issues: string[] = []
  let windows: Playback = 'unknown'
  let mac: Playback = 'unknown'

  switch (p.container) {
    case 'mp4':
    case 'mov': {
      windows = 'yes'
      mac = 'yes'
      const v = p.video
      if (v) {
        const [w, m] = videoInIsoBmff(v, issues)
        windows = w
        mac = m
      }
      if (p.audio) {
        const [w, m] = audioInIsoBmff(p.audio, issues)
        windows = worst(windows, w)
        mac = worst(mac, m)
      }
      if (!v && !p.audio) {
        windows = mac = 'unknown'
        issues.push('No playable track could be read from this file.')
      }
      break
    }
    case 'asf':
      windows = 'yes'
      mac = 'no'
      issues.push('Windows Media (WMV/WMA) does not play in PowerPoint for Mac. Re-encode to MP4 (H.264 + AAC).')
      break
    case 'avi':
      windows = p.video && /H\.264|Motion JPEG|DV|MPEG-4/.test(p.video.codec) ? 'yes' : 'unknown'
      mac = 'no'
      issues.push('AVI does not play in PowerPoint for Mac. Re-encode to MP4 (H.264 + AAC).')
      break
    case 'mpeg-ps':
      windows = 'yes'
      mac = 'unknown'
      issues.push('MPEG-1/2 files play on Windows; on a Mac it depends on the codec. MP4 (H.264) is safer.')
      break
    case 'mpeg-ts':
    case 'mkv':
    case 'webm':
    case 'ogg':
      windows = 'unknown'
      mac = 'no'
      issues.push(`${p.containerLabel} is not a format PowerPoint supports. Re-encode to MP4 (H.264 + AAC).`)
      break
    case 'swf':
      windows = mac = 'no'
      issues.push('Flash is retired and no current PowerPoint plays it.')
      break
    case 'mp3':
    case 'wav':
    case 'aiff':
      windows = mac = 'yes'
      break
    case 'flac':
      windows = 'yes'
      mac = 'unknown'
      break
    case 'midi':
      windows = 'yes'
      mac = 'unknown'
      issues.push('MIDI sounds different on every machine — it is played by the local synthesizer.')
      break
    case 'unknown':
      issues.push('The file format was not recognised.')
      break
  }

  const verdict: Compat['verdict'] =
    windows === 'no' || mac === 'no'
      ? 'bad'
      : windows === 'yes' && mac === 'yes'
        ? 'good'
        : 'caution'
  return { windows, mac, verdict, issues }
}

function videoInIsoBmff(v: VideoStream, issues: string[]): [Playback, Playback] {
  const f = v.fourcc
  if (f === 'avc1' || f === 'avc3') {
    const tenBit = (v.bitDepth ?? 8) > 8
    const notFourTwoZero = v.chroma !== undefined && v.chroma !== '4:2:0' && v.chroma !== '4:0:0'
    if (tenBit || notFourTwoZero) {
      issues.push(
        `H.264 ${v.profile ?? ''} (${v.bitDepth ?? '?'}-bit ${v.chroma ?? ''}) is a camera or ` +
          'editing format that neither Windows nor macOS can play back. Re-encode as 8-bit 4:2:0 ' +
          'H.264 (High profile).',
      )
      return ['no', 'no']
    }
    if ((v.width ?? 0) > 4096 || (v.height ?? 0) > 2304) {
      // Microsoft documents 4096×2304 as the limit of the Windows H.264
      // decoder. Some GPUs decode past it, so this is "test it", not "no".
      issues.push(
        `${v.width}×${v.height} is larger than the 4096×2304 that Microsoft documents for the ` +
          'Windows H.264 decoder. It may play on some graphics hardware and not on others — test ' +
          'it on the show machine, or split it into pieces no wider than 4096.',
      )
      return ['unknown', 'yes']
    }
    return ['yes', 'yes']
  }
  if (f === 'hvc1' || f === 'hev1' || f === 'dvh1' || f === 'dvhe') {
    issues.push(
      'HEVC plays on Windows only with the “HEVC Video Extensions” installed from the Microsoft ' +
        'Store — many machines do not have it. H.264 plays everywhere.',
    )
    if (f === 'hev1' || f === 'dvhe') {
      issues.push(
        `Tagged ${f}, which the Mac will not play; it needs to be tagged hvc1 ` +
          '(a remux, not a re-encode: ffmpeg -c copy -tag:v hvc1).',
      )
      return ['extension', 'no']
    }
    return ['extension', 'yes']
  }
  if (f.startsWith('ap')) {
    issues.push('ProRes is a Mac editing format. Windows has no ProRes decoder, so this will not play there.')
    return ['no', f === 'aprn' ? 'no' : 'yes']
  }
  if (f.startsWith('Hap')) {
    issues.push('HAP is a media-server codec. PowerPoint cannot play it on either platform.')
    return ['no', 'no']
  }
  if (f === 'AVdn' || f === 'AVdh') {
    issues.push('DNxHD/DNxHR is an editing format and does not play on Windows. Deliver H.264.')
    return ['no', 'unknown']
  }
  if (f === 'av01') {
    issues.push('AV1 needs the “AV1 Video Extension” on Windows and recent Apple hardware on a Mac.')
    return ['extension', 'unknown']
  }
  if (f === 'vp09') {
    issues.push('VP9 in MP4 needs the “VP9 Video Extensions” on Windows and does not play in PowerPoint for Mac.')
    return ['extension', 'no']
  }
  if (f === 'mp4v') return ['yes', 'yes']
  if (f === 'jpeg' || f.startsWith('mjp')) return ['unknown', 'yes']
  if (VIDEO_CODECS[f]) {
    issues.push(`${VIDEO_CODECS[f]} is not a delivery codec. Re-encode to H.264.`)
    return ['unknown', 'unknown']
  }
  issues.push(`Video codec ${v.codec} was not recognised.`)
  return ['unknown', 'unknown']
}

function audioInIsoBmff(a: AudioStream, issues: string[]): [Playback, Playback] {
  switch (a.fourcc) {
    case 'mp4a':
    case '.mp3':
    case 'ac-3':
    case 'ec-3':
    case 'alac':
      return ['yes', 'yes']
    case 'lpcm':
    case 'sowt':
    case 'twos':
    case 'in24':
    case 'in32':
    case 'fl32':
    case 'fl64':
    case 'raw ':
      // Uncompressed audio in a QuickTime wrapper is normal for ProRes
      // masters and fine on a Mac; Windows is not reliable with it.
      issues.push('Uncompressed (PCM) audio in a QuickTime file may not play on Windows. AAC is safe.')
      return ['unknown', 'yes']
    default:
      issues.push(`Audio codec ${a.codec} may not play. AAC is safe.`)
      return ['unknown', 'unknown']
  }
}

/** "H.264 High · 1920×1080 · 25 fps · AAC stereo · 1:32" */
export function describeProbe(p: MediaProbe): string {
  const bits: string[] = [p.containerLabel]
  const v = p.video
  if (v) {
    let s = v.codec
    if (v.profile) s += ` ${v.profile}`
    if (v.bitDepth && v.bitDepth > 8 && !v.profile?.includes(String(v.bitDepth))) s += ` ${v.bitDepth}-bit`
    if (v.chroma && v.chroma !== '4:2:0' && !v.codec.startsWith('ProRes')) s += ` ${v.chroma}`
    bits.push(s)
    if (v.width && v.height) bits.push(`${v.width}×${v.height}`)
    if (v.fps) bits.push(`${v.fps} fps`)
  }
  const a = p.audio
  if (a) {
    const ch = a.channels === 1 ? ' mono' : a.channels === 2 ? ' stereo' : a.channels ? ` ${a.channels}ch` : ''
    bits.push(`${a.codec}${ch}`)
  }
  if (p.durationSec !== undefined) bits.push(formatDuration(p.durationSec))
  return bits.join(' · ')
}

export function formatDuration(sec: number): string {
  if (sec < 10) return `${Math.round(sec * 10) / 10} s`
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}
