import { strFromU8, strToU8 } from 'fflate'
import { walkTags, decodeEntities } from './xml'
import { parseRels, relsPathFor, type Relationship } from './opc'
import { readZipDirectory, entryData, rewriteZip, type ZipDirectory } from './zipdir'
import { probeMedia, assessCompat, type MediaProbe, type Compat } from './mediaprobe'

/**
 * Find every video and sound in a deck, and every one that will not play
 * without the internet.
 *
 * ## What PowerPoint actually writes
 *
 * An embedded video is a `<p:pic>` whose `<p:nvPr>` holds two references to
 * the same file — checked against real Office decks, not the spec:
 *
 * ```xml
 * <a:videoFile r:link="rId2"/>                  <!-- rel type .../video -->
 * <p14:media r:embed="rId1"/>                   <!-- rel type .../media -->
 * ```
 *
 * Both relationships point at `../media/media1.mp4`. Counting relationships
 * therefore counts every video twice; this groups by shape and dedupes by
 * target. The same file is also routinely reused on several slides (one real
 * deck puts `media1.mp4` on four), so files and placements are kept apart:
 * one file, many slides.
 *
 * An *online* video is the same shape with the relationship marked
 * `TargetMode="External"` and a URL for a target. A *linked* local video is
 * External with a file path — it is not in the deck at all, and has to travel
 * beside it.
 *
 * ## The other ways a deck reaches for the internet
 *
 * - Flash, through a ShockwaveFlash ActiveX control whose `Movie` property is
 *   a URL — the old way to put YouTube on a slide. Plays nowhere now.
 * - An Office add-in (Web Viewer and the like) on the slide, whose settings
 *   carry the URL it loads.
 * - A plain hyperlink to a video site. That opens a browser rather than
 *   playing on the slide, but it is just as dead without a connection, and an
 *   operator wants to know before the show, not during it.
 */

export type MediaKind = 'video' | 'audio'

export type OnlineService =
  | 'youtube'
  | 'vimeo'
  | 'onedrive'
  | 'onedrive-business'
  | 'sharepoint'
  | 'stream'
  | 'stream-classic'
  | 'web'

export interface OnlineInfo {
  service: OnlineService
  label: string
  /** Plays only for someone signed in with an account that can see it. */
  signIn: boolean
  /** The service is gone; this will not play for anyone. */
  retired?: boolean
}

export interface SlideRef {
  /** Position in the show, 1-based — what PowerPoint calls "slide 5". */
  number: number
  part: string
  title?: string
  hidden: boolean
}

export interface PlaybackSettings {
  /** How playback begins, from the slide's timing tree. */
  start?: 'automatically' | 'on-click' | 'when-clicked-on'
  loop?: boolean
  fullScreen?: boolean
  muted?: boolean
  /** 0–100. */
  volume?: number
  hideWhenStopped?: boolean
  /** Trim points in milliseconds. The file itself is never trimmed. */
  trimStartMs?: number
  trimEndMs?: number
}

interface PlacementBase {
  slide: number
  /** The shape's name in the selection pane. */
  shape: string
  kind: MediaKind
  playback: PlaybackSettings
  /** Set when the media sits on the slide's layout or master, not the slide. */
  inheritedFrom?: 'layout' | 'master'
}

export type MediaPlacement =
  | (PlacementBase & { source: 'embedded'; part: string })
  | (PlacementBase & { source: 'linked'; target: string })
  | (PlacementBase & {
      source: 'online'
      url: string
      online: OnlineInfo
      /** How the deck reaches it. */
      via: 'online-video' | 'add-in' | 'flash' | 'hyperlink'
    })

export interface EmbeddedMediaFile {
  part: string
  size: number
  kind: MediaKind
  probe: MediaProbe
  compat: Compat
  /** Slide numbers it appears on, in show order. */
  slides: number[]
  /** CRC-32 from the deck's zip directory, reused when re-zipping. */
  crc: number
}

export interface MediaScanResult {
  slides: SlideRef[]
  placements: MediaPlacement[]
  files: EmbeddedMediaFile[]
  warnings: string[]
}

// ---------------------------------------------------------------------------

const VIDEO_EXT = /\.(mp4|m4v|mov|qt|wmv|asf|avi|mpe?g|mkv|webm|swf|flv|ts|m2ts|mts)$/i
const AUDIO_EXT = /\.(mp3|m4a|wav|wma|aiff?|aac|flac|ogg|mid|midi)$/i

export function classifyUrl(url: string): OnlineInfo {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    path = u.pathname.toLowerCase()
  } catch {
    return { service: 'web', label: 'Web', signIn: false }
  }
  const is = (d: string) => host === d || host.endsWith(`.${d}`)

  if (is('youtube.com') || is('youtu.be') || is('youtube-nocookie.com')) {
    return { service: 'youtube', label: 'YouTube', signIn: false }
  }
  if (is('vimeo.com')) return { service: 'vimeo', label: 'Vimeo', signIn: false }
  if (is('microsoftstream.com')) {
    return { service: 'stream-classic', label: 'Microsoft Stream (Classic)', signIn: true, retired: true }
  }
  if (is('sharepoint.com')) {
    if (path.includes('/stream.aspx')) return { service: 'stream', label: 'Microsoft Stream', signIn: true }
    // `contoso-my.sharepoint.com` is a person's OneDrive for work or school.
    if (host.includes('-my.')) return { service: 'onedrive-business', label: 'OneDrive for Business', signIn: true }
    return { service: 'sharepoint', label: 'SharePoint', signIn: true }
  }
  if (is('onedrive.live.com') || is('1drv.ms') || is('onedrive.com')) {
    return { service: 'onedrive', label: 'OneDrive', signIn: false }
  }
  if (is('dailymotion.com')) return { service: 'web', label: 'Dailymotion', signIn: false }
  if (is('wistia.com') || is('wistia.net')) return { service: 'web', label: 'Wistia', signIn: false }
  if (is('vidyard.com')) return { service: 'web', label: 'Vidyard', signIn: false }
  if (is('loom.com')) return { service: 'web', label: 'Loom', signIn: false }
  if (is('slideshare.net')) return { service: 'web', label: 'SlideShare', signIn: false }
  return { service: 'web', label: host || 'Web', signIn: false }
}

/** Only hyperlinks that plainly lead to a video are worth reporting. */
function isVideoLink(url: string, info: OnlineInfo): boolean {
  if (!/^https?:/i.test(url)) return false
  if (['youtube', 'vimeo', 'stream', 'stream-classic'].includes(info.service)) return true
  if (['Dailymotion', 'Wistia', 'Vidyard', 'Loom'].includes(info.label)) return true
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    /* keep the raw string */
  }
  return VIDEO_EXT.test(path)
}

const SHOCKWAVE_CLSID = '{D27CDB6E-AE6D-11CF-96B8-444553540000}'

interface ShapeMedia {
  id: string
  name: string
  kindHint?: MediaKind
  rids: string[]
  /** `src` of a `<p15:webVideoPr embeddedHtml>` iframe, when present. */
  webUrl?: string
}

export function scanMedia(file: Uint8Array): MediaScanResult {
  const dir = readZipDirectory(file)
  const warnings: string[] = []
  const text = (part: string): string | null => {
    const e = dir.byName.get(part)
    if (!e) return null
    try {
      return strFromU8(entryData(file, e))
    } catch {
      return null
    }
  }
  const rels = (part: string): Relationship[] => {
    const xml = text(relsPathFor(part))
    return xml ? parseRels(xml, part) : []
  }

  const slides = slideOrder(dir, text, rels)

  const placements: MediaPlacement[] = []
  const filesByPart = new Map<string, EmbeddedMediaFile>()

  /*
   * Media on a layout or master plays on every slide built from it — one real
   * deck carries a looping .mov on a layout. So each slide is read together
   * with its layout and master, and anything found there is reported against
   * the slide, marked as inherited. Parsed once per part, however many slides
   * share it.
   */
  const parsedParts = new Map<string, { parsed: ParsedSlide; rels: Map<string, Relationship> }>()
  const parse = (part: string) => {
    let hit = parsedParts.get(part)
    if (!hit) {
      const xml = text(part)
      if (xml === null) return undefined
      hit = { parsed: parseSlide(xml), rels: new Map(rels(part).map((r) => [r.id, r])) }
      parsedParts.set(part, hit)
    }
    return hit
  }

  for (const slide of slides) {
    const own = parse(slide.part)
    if (!own) continue
    slide.hidden = own.parsed.hidden
    slide.title = own.parsed.title

    const layout = [...own.rels.values()].find((r) => r.type === 'slideLayout' && !r.external)?.target
    const master = layout
      ? [...(parse(layout)?.rels.values() ?? [])].find((r) => r.type === 'slideMaster' && !r.external)?.target
      : undefined

    const sources: Array<[string | undefined, 'layout' | 'master' | undefined]> = [
      [slide.part, undefined],
      [layout, 'layout'],
      [master, 'master'],
    ]
    for (const [part, inheritedFrom] of sources) {
      const hit = part ? parse(part) : undefined
      if (!hit) continue
      collect(slide.number, hit.parsed, hit.rels, inheritedFrom)
    }
  }

  function collect(
    slideNumber: number,
    parsed: ParsedSlide,
    relById: Map<string, Relationship>,
    inheritedFrom: 'layout' | 'master' | undefined,
  ) {
    const extra = inheritedFrom ? { inheritedFrom } : {}
    for (const shape of parsed.shapes) {
      const playback = parsed.playback.get(shape.id) ?? {}
      const seen = new Set<string>()
      let placed = false
      for (const rid of shape.rids) {
        const rel = relById.get(rid)
        if (!rel || seen.has(rel.target)) continue
        seen.add(rel.target)
        const kind = shape.kindHint ?? kindFromName(rel.target) ?? 'video'
        const base = { slide: slideNumber, shape: shape.name, kind, playback, ...extra }
        if (!rel.external) {
          placements.push({ ...base, source: 'embedded', part: rel.target })
          let f = filesByPart.get(rel.target)
          if (!f) {
            f = describeFile(file, dir, rel.target, kind, warnings)
            if (f) filesByPart.set(rel.target, f)
          }
          if (f && !f.slides.includes(slideNumber)) f.slides.push(slideNumber)
        } else if (/^https?:/i.test(rel.target)) {
          placements.push({
            ...base,
            kind: 'video',
            source: 'online',
            url: rel.target,
            online: classifyUrl(rel.target),
            via: 'online-video',
          })
        } else {
          placements.push({ ...base, source: 'linked', target: rel.target })
        }
        placed = true
      }
      // An online video can be recorded only as an embed code, with no
      // relationship to follow.
      if (!placed && shape.webUrl) {
        placements.push({
          slide: slideNumber,
          shape: shape.name,
          kind: 'video',
          playback,
          ...extra,
          source: 'online',
          url: shape.webUrl,
          online: classifyUrl(shape.webUrl),
          via: 'online-video',
        })
      }
    }

    for (const { rid, shape } of parsed.controls) {
      const rel = relById.get(rid)
      if (!rel || rel.external) continue
      const ax = text(rel.target)
      if (!ax) continue
      const flash = readFlashControl(ax)
      if (!flash) continue
      placements.push({
        slide: slideNumber,
        shape,
        kind: 'video',
        playback: {},
        ...extra,
        source: 'online',
        url: flash,
        online: classifyUrl(flash),
        via: 'flash',
      })
    }

    for (const { rid, shape } of parsed.addins) {
      const rel = relById.get(rid)
      if (!rel || rel.external) continue
      const we = text(rel.target)
      if (!we) continue
      for (const url of addinUrls(we)) {
        placements.push({
          slide: slideNumber,
          shape,
          kind: 'video',
          playback: {},
          ...extra,
          source: 'online',
          url,
          online: classifyUrl(url),
          via: 'add-in',
        })
      }
    }

    const linked = new Set<string>()
    for (const { rid, shape } of parsed.links) {
      const rel = relById.get(rid)
      if (!rel || !rel.external || linked.has(rel.target)) continue
      const info = classifyUrl(rel.target)
      if (!isVideoLink(rel.target, info)) continue
      linked.add(rel.target)
      placements.push({
        slide: slideNumber,
        shape,
        kind: 'video',
        playback: {},
        ...extra,
        source: 'online',
        url: rel.target,
        online: info,
        via: 'hyperlink',
      })
    }
  }

  for (const f of filesByPart.values()) f.slides.sort((a, b) => a - b)
  const files = [...filesByPart.values()].sort(
    (a, b) => (a.slides[0] ?? 0) - (b.slides[0] ?? 0) || a.part.localeCompare(b.part),
  )
  return { slides, placements, files, warnings }
}

function kindFromName(name: string): MediaKind | undefined {
  if (VIDEO_EXT.test(name)) return 'video'
  if (AUDIO_EXT.test(name)) return 'audio'
  return undefined
}

function describeFile(
  file: Uint8Array,
  dir: ZipDirectory,
  part: string,
  kind: MediaKind,
  warnings: string[],
): EmbeddedMediaFile | undefined {
  const entry = dir.byName.get(part)
  if (!entry) {
    warnings.push(`${part} is referenced by a slide but missing from the file — that clip will not play.`)
    return undefined
  }
  let probe: MediaProbe
  try {
    probe = probeMedia(entryData(file, entry))
  } catch (e) {
    warnings.push(`${part} could not be read: ${(e as Error).message}`)
    probe = { container: 'unknown', containerLabel: 'Unknown' }
  }
  // The container is the better witness than the shape: a "video" whose only
  // track is sound is an audio clip wearing a poster frame.
  const actual: MediaKind =
    probe.video ? 'video' : probe.audio || ['mp3', 'wav', 'aiff', 'flac', 'midi'].includes(probe.container) ? 'audio' : kind
  return {
    part,
    size: entry.size,
    kind: actual,
    probe,
    compat: assessCompat(probe),
    slides: [],
    crc: entry.crc,
  }
}

/** Slides in show order, from `presentation.xml`'s `<p:sldIdLst>`. */
function slideOrder(
  dir: ZipDirectory,
  text: (p: string) => string | null,
  rels: (p: string) => Relationship[],
): SlideRef[] {
  const pres = text('ppt/presentation.xml')
  const ordered: string[] = []
  if (pres) {
    const byId = new Map(rels('ppt/presentation.xml').map((r) => [r.id, r.target]))
    for (const tag of walkTags(pres)) {
      if (tag.local !== 'sldId' || tag.close) continue
      const target = byId.get(tag.attrs['r:id'] ?? '')
      if (target) ordered.push(target)
    }
  }
  // Any slide part the list does not mention (a damaged deck) goes last, in
  // file-name order, rather than vanishing.
  const listed = new Set(ordered)
  const stray = dir.entries
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) && !listed.has(n))
    .sort((a, b) => partNumber(a) - partNumber(b))
  return [...ordered, ...stray]
    .filter((p) => dir.byName.has(p))
    .map((part, i) => ({ number: i + 1, part, hidden: false }))
}

const partNumber = (p: string) => parseInt(p.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)

// ---------------------------------------------------------------------------
// One slide

interface ParsedSlide {
  hidden: boolean
  title?: string
  shapes: ShapeMedia[]
  playback: Map<string, PlaybackSettings>
  controls: Array<{ rid: string; shape: string }>
  addins: Array<{ rid: string; shape: string }>
  links: Array<{ rid: string; shape: string }>
}

const onOff = (v: string | undefined, dflt: boolean) => {
  if (v === undefined) return dflt
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'on'
}

function parseSlide(xml: string): ParsedSlide {
  const out: ParsedSlide = {
    hidden: false,
    shapes: [],
    playback: new Map(),
    controls: [],
    addins: [],
    links: [],
  }
  const byId = new Map<string, ShapeMedia>()
  let current: ShapeMedia | null = null
  let sawRoot = false

  // Timing-tree state.
  let mediaNode: { spid?: string; settings: PlaybackSettings } | null = null
  let mediaTag = ''
  let effectNodeType: string | undefined
  let playCall = false
  const starts = new Map<string, PlaybackSettings['start']>()
  const trims = new Map<string, Pick<PlaybackSettings, 'trimStartMs' | 'trimEndMs'>>()

  const settingsFor = (id: string) => {
    let s = out.playback.get(id)
    if (!s) out.playback.set(id, (s = {}))
    return s
  }

  for (const tag of walkTags(xml)) {
    const { local, attrs } = tag
    if (!sawRoot && local === 'sld' && !tag.close) {
      out.hidden = !onOff(attrs.show, true)
      sawRoot = true
      continue
    }
    if (tag.close) {
      if (local === 'cmd') playCall = false
      if ((local === 'video' || local === 'audio') && mediaTag === local) {
        if (mediaNode?.spid) Object.assign(settingsFor(mediaNode.spid), mediaNode.settings)
        mediaNode = null
        mediaTag = ''
      }
      continue
    }

    switch (local) {
      case 'cNvPr':
        current = { id: attrs.id ?? '', name: attrs.name ?? '', rids: [] }
        byId.set(current.id, current)
        break
      case 'videoFile':
      case 'quickTimeFile':
      case 'audioFile':
      case 'wavAudioFile':
      case 'media': {
        const rid = attrs['r:link'] ?? attrs['r:embed']
        if (current && rid) {
          current.rids.push(rid)
          if (local !== 'media') current.kindHint = /video|quickTime/.test(local) ? 'video' : 'audio'
        }
        break
      }
      case 'trim':
        if (current) {
          const st = parseFloat(attrs.st ?? '')
          const end = parseFloat(attrs.end ?? '')
          trims.set(current.id, {
            trimStartMs: st > 0 ? st : undefined,
            trimEndMs: end > 0 ? end : undefined,
          })
        }
        break
      case 'webVideoPr':
        if (current && attrs.embeddedHtml) {
          const src = /src\s*=\s*["']([^"']+)["']/i.exec(decodeEntities(attrs.embeddedHtml))?.[1]
          if (src) current.webUrl = src.startsWith('//') ? `https:${src}` : src
        }
        break
      case 'control': {
        const rid = attrs['r:id']
        if (rid) out.controls.push({ rid, shape: attrs.name ?? current?.name ?? '' })
        break
      }
      case 'webextensionref': {
        const rid = attrs['r:id']
        if (rid) out.addins.push({ rid, shape: current?.name ?? '' })
        break
      }
      case 'hlinkClick':
      case 'hlinkHover': {
        const rid = attrs['r:id']
        if (rid) out.links.push({ rid, shape: current?.name ?? '' })
        break
      }

      // ---- timing ----
      case 'video':
      case 'audio':
        mediaTag = local
        mediaNode = { settings: {} }
        if (local === 'video') mediaNode.settings.fullScreen = onOff(attrs.fullScrn, false)
        break
      case 'cMediaNode':
        if (mediaNode) {
          const vol = attrs.vol !== undefined ? parseInt(attrs.vol, 10) : 100_000
          mediaNode.settings.volume = Math.round(vol / 1000)
          mediaNode.settings.muted = onOff(attrs.mute, false)
          mediaNode.settings.hideWhenStopped = !onOff(attrs.showWhenStopped, true)
        }
        break
      case 'cTn':
        if (mediaNode) {
          if (attrs.repeatCount === 'indefinite') mediaNode.settings.loop = true
          else if (mediaNode.settings.loop === undefined) mediaNode.settings.loop = false
        }
        if (attrs.presetClass === 'mediacall') effectNodeType = attrs.nodeType
        break
      case 'cmd':
        playCall = attrs.type === 'call' && /^playFrom/.test(attrs.cmd ?? '')
        break
      case 'spTgt':
        if (mediaNode) mediaNode.spid = attrs.spid
        else if (playCall && attrs.spid && !starts.has(attrs.spid)) {
          starts.set(
            attrs.spid,
            effectNodeType === 'clickEffect'
              ? 'on-click'
              : effectNodeType === 'afterEffect' || effectNodeType === 'withEffect'
                ? 'automatically'
                : 'when-clicked-on',
          )
        }
        break
    }
  }

  for (const shape of byId.values()) {
    if (shape.rids.length === 0 && !shape.webUrl) continue
    out.shapes.push(shape)
    const s = settingsFor(shape.id)
    // No playFrom anywhere means the only way to start it is to click it.
    s.start = starts.get(shape.id) ?? 'when-clicked-on'
    Object.assign(s, trims.get(shape.id))
  }
  out.title = slideTitle(xml)
  return out
}

/** Text of the title placeholder, if the slide has one. */
function slideTitle(xml: string): string | undefined {
  for (const sp of xml.split(/<(?:\w+:)?sp>/).slice(1)) {
    if (!/<(?:\w+:)?ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp.split(/<\/(?:\w+:)?nvSpPr>/)[0] ?? '')) continue
    const runs = [...sp.matchAll(/<(?:\w+:)?t>([^<]*)<\/(?:\w+:)?t>/g)].map((m) => decodeEntities(m[1]!))
    const t = runs.join('').replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  return undefined
}

function readFlashControl(xml: string): string | undefined {
  let flash = false
  let movie: string | undefined
  for (const tag of walkTags(xml)) {
    if (tag.local === 'ocx' && (tag.attrs['ax:classid'] ?? tag.attrs.classid)?.toUpperCase() === SHOCKWAVE_CLSID) {
      flash = true
    }
    if (tag.local === 'ocxPr') {
      const name = tag.attrs['ax:name'] ?? tag.attrs.name
      const value = tag.attrs['ax:value'] ?? tag.attrs.value
      if (name && /^movie$/i.test(name) && value) movie = value
    }
  }
  return flash ? (movie ?? 'Flash object (no movie address recorded)') : undefined
}

/** Any web address in an add-in's saved settings. */
function addinUrls(xml: string): string[] {
  const urls = new Set<string>()
  for (const tag of walkTags(xml)) {
    if (tag.local !== 'property') continue
    for (const m of (tag.attrs.value ?? '').matchAll(/https?:\/\/[^\s"'\\<>]+/g)) urls.add(m[0])
  }
  return [...urls]
}

// ---------------------------------------------------------------------------
// Changing the deck

/**
 * A copy of the deck with the given slides hidden (`<p:sld show="0">`).
 *
 * Hidden, not deleted: the slide stays exactly where it was for anyone
 * editing the deck, the slideshow just steps over it. Everything but the
 * touched slide XML is copied through byte for byte — see `rewriteZip`.
 */
export function hideSlides(file: Uint8Array, slideParts: string[]): Uint8Array[] {
  const dir = readZipDirectory(file)
  const replace = new Map<string, Uint8Array>()
  for (const part of slideParts) {
    const e = dir.byName.get(part)
    if (!e) throw new Error(`No slide ${part} in this file.`)
    replace.set(part, strToU8(setShowFalse(strFromU8(entryData(file, e)))))
  }
  return rewriteZip(file, dir, replace)
}

export function setShowFalse(xml: string): string {
  const m = /<((?:\w+:)?sld)(\s[^>]*)?>/.exec(xml)
  if (!m) throw new Error('Not a slide part.')
  const attrs = m[2] ?? ''
  const next = /\sshow\s*=\s*"[^"]*"/.test(attrs)
    ? attrs.replace(/\sshow\s*=\s*"[^"]*"/, ' show="0"')
    : `${attrs} show="0"`
  return xml.slice(0, m.index) + `<${m[1]}${next}>` + xml.slice(m.index + m[0].length)
}

/** The bytes of one embedded file — a view into the deck when stored. */
export function mediaBytes(file: Uint8Array, part: string): Uint8Array {
  const dir = readZipDirectory(file)
  const e = dir.byName.get(part)
  if (!e) throw new Error(`${part} is not in this file.`)
  return entryData(file, e)
}

/**
 * Friendly names for extracted files: `Slide 05 - Intro film.mp4`, not
 * `media3.mp4`. Keyed by part; unique within the set.
 */
export function mediaFilenames(result: MediaScanResult): Map<string, string> {
  const width = String(result.slides.length).length
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const f of result.files) {
    const ext = f.part.match(/\.[A-Za-z0-9]+$/)?.[0]?.toLowerCase() ?? ''
    const first = result.placements.find(
      (p) => p.source === 'embedded' && p.part === f.part && p.slide === f.slides[0],
    )
    const slide = f.slides[0]
    // Shapes are often named after the file they were inserted from.
    const label = clean(first?.shape ?? '').replace(/\.[A-Za-z0-9]{2,4}$/, '') || f.part.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
    let base = slide ? `Slide ${String(slide).padStart(width, '0')} - ${label}` : label
    if (used.has(base.toLowerCase())) base += ` (${f.part.replace(/^.*\//, '').replace(/\.[^.]+$/, '')})`
    used.add(base.toLowerCase())
    names.set(f.part, base + ext)
  }
  return names
}

const clean = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
