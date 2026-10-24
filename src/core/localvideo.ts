import { strFromU8, strToU8 } from 'fflate'
import { walkTags } from './xml'
import { parseRels, relsPathFor } from './opc'
import { readZipDirectory, entryData, rewriteZip, type StoredFile } from './zipdir'
import type { MediaScanResult } from './media'

/**
 * Turn a deck's online videos into embedded ones.
 *
 * The desktop build downloads the video (yt-dlp, on the Rust side); this
 * module decides what to download and then rewrites the deck so the slide
 * plays the file instead of the stream. DOM-free like the rest of `core/`.
 *
 * ## What PowerPoint writes, before and after
 *
 * Checked against a deck made in PowerPoint for Mac 16.x with Insert ▸ Video
 * ▸ Online Film (test/fixtures/online-video.pptx), and against what the same
 * PowerPoint writes for a video inserted from a file:
 *
 * ```xml
 * <!-- online -->
 * <p:nvPr><a:videoFile r:link="rId1"/></p:nvPr>
 * rId1  .../relationships/video  https://www.youtube.com/embed/ID?start=95&feature=oembed  External
 *
 * <!-- embedded -->
 * <p:nvPr><a:videoFile r:link="rId1"/>
 *   <p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">
 *     <p14:media r:embed="rId4"><p14:trim st="95000"/></p14:media>
 *   </p:ext></p:extLst></p:nvPr>
 * rId1  .../relationships/video          ../media/media1.mp4
 * rId4  .../2007/relationships/media     ../media/media1.mp4
 * ```
 *
 * So the conversion is: point the existing video relationship at a file in
 * the package, add the second (`media`) relationship PowerPoint expects beside
 * it, and add the `p14:media` extension. Everything else stays — the poster
 * frame (the YouTube thumbnail), the shape's position, and the play/pause
 * timing PowerPoint already wrote, which is the same for both kinds.
 *
 * Other producers also write a `p15:webVideoPr` extension holding the iframe
 * embed code; it is removed, since a shape carrying it is still an online
 * video as far as PowerPoint is concerned.
 *
 * A start time in the link (`?start=95`, from a `youtu.be/…?t=95`) becomes a
 * PowerPoint trim, which is what the online video did: start there. The file
 * itself is never cut, so the trim can be changed later in PowerPoint.
 */

export interface VideoToFetch {
  /** One per distinct video, however many slides or links reach it. */
  key: string
  /** What to hand the downloader. */
  url: string
  /** The service, for display: YouTube, Vimeo… */
  label: string
  slides: number[]
  shapes: string[]
  /**
   * Every relationship target in the deck this one download replaces. The
   * same YouTube video linked with and without a start time is two targets
   * and one file.
   */
  targets: string[]
}

export interface UnfetchableVideo {
  url: string
  label: string
  slides: number[]
  reason: string
}

/**
 * The online videos in a deck that can be downloaded and embedded, and the
 * ones that cannot, with the reason.
 *
 * Only `online-video` shapes are candidates. A hyperlink to YouTube opens a
 * browser and was never a video on the slide; Flash and web add-ins are
 * different objects altogether. Rewriting any of them into a video shape is
 * a layout decision this tool does not get to make silently.
 */
export function videosToFetch(media: MediaScanResult): { fetch: VideoToFetch[]; skipped: UnfetchableVideo[] } {
  const fetch = new Map<string, VideoToFetch>()
  const skipped = new Map<string, UnfetchableVideo>()
  const add = <T extends { slides: number[] }>(list: T, slide: number) => {
    if (!list.slides.includes(slide)) list.slides.push(slide)
  }

  for (const p of media.placements) {
    if (p.source !== 'online' || p.via !== 'online-video') continue
    const reason = !/^https?:\/\//i.test(p.url)
      ? 'Not a web address.'
      : p.embedCodeOnly
        ? 'Recorded only as an embed code, with no link to repoint. Download it and insert it as a file in PowerPoint.'
        : p.online.retired
          ? `${p.online.label} has been retired; there is nothing left to download.`
          : p.online.signIn
            ? `Needs a sign-in to ${p.online.label}. Download it from there and insert it as a file.`
            : null
    if (reason) {
      let s = skipped.get(p.url)
      if (!s) skipped.set(p.url, (s = { url: p.url, label: p.online.label, slides: [], reason }))
      add(s, p.slide)
      continue
    }
    const { key, url } = downloadKey(p.url)
    let f = fetch.get(key)
    if (!f) fetch.set(key, (f = { key, url, label: p.online.label, slides: [], shapes: [], targets: [] }))
    add(f, p.slide)
    if (p.shape && !f.shapes.includes(p.shape)) f.shapes.push(p.shape)
    if (!f.targets.includes(p.url)) f.targets.push(p.url)
  }

  const bySlide = (a: { slides: number[] }, b: { slides: number[] }) => (a.slides[0] ?? 0) - (b.slides[0] ?? 0)
  for (const f of fetch.values()) f.slides.sort((a, b) => a - b)
  for (const s of skipped.values()) s.slides.sort((a, b) => a - b)
  return { fetch: [...fetch.values()].sort(bySlide), skipped: [...skipped.values()].sort(bySlide) }
}

/** The 11-character id from any of the shapes a YouTube link comes in. */
export function youtubeId(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const host = u.hostname.toLowerCase()
  const is = (d: string) => host === d || host.endsWith(`.${d}`)
  const seg = u.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (is('youtu.be')) id = seg[0]
  else if (is('youtube.com') || is('youtube-nocookie.com')) {
    if (seg[0] === 'watch') id = u.searchParams.get('v') ?? undefined
    else if (['embed', 'v', 'shorts', 'live', 'e'].includes(seg[0] ?? '')) id = seg[1]
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined
}

/**
 * What to download for a link, and what makes two links the same download.
 *
 * YouTube links are reduced to the plain watch page: an embed URL carries
 * `feature=oembed` and start times that mean nothing to a downloader, and
 * two links to one video should be one download. Anything else is used as
 * written, minus a `#t=` fragment.
 */
export function downloadKey(url: string): { key: string; url: string } {
  const yt = youtubeId(url)
  if (yt) return { key: `youtube:${yt}`, url: `https://www.youtube.com/watch?v=${yt}` }
  const plain = url.replace(/#.*$/, '')
  return { key: plain, url: plain }
}

/**
 * Where an online video was set to start, in seconds.
 *
 * YouTube embeds carry `start=95`; watch and short links carry `t=95`,
 * `t=95s` or `t=1m35s`; Vimeo puts `#t=1m35s` in the fragment.
 */
export function startSeconds(url: string): number | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const fragment = new URLSearchParams(u.hash.replace(/^#/, ''))
  for (const raw of [u.searchParams.get('start'), u.searchParams.get('t'), fragment.get('t')]) {
    if (!raw) continue
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/i.exec(raw.trim())
    if (!m || (!m[1] && !m[2] && !m[3])) continue
    const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
    if (s > 0) return s
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Rewriting the deck

export interface LocalVideo {
  /** The online targets (relationship Targets, as `scanMedia` reports them) this file replaces. */
  targets: string[]
  data: Uint8Array
  /** File extension, without the dot. */
  ext: 'mp4' | 'mov'
  crc?: number
}

export interface EmbedResult {
  /** The new deck, as chunks — see `rewriteZip`. */
  parts: Uint8Array[]
  added: Array<{ part: string; targets: string[]; shapes: number }>
  notes: string[]
}

const CONTENT_TYPE: Record<LocalVideo['ext'], string> = { mp4: 'video/mp4', mov: 'video/quicktime' }
const MEDIA_REL = 'http://schemas.microsoft.com/office/2007/relationships/media'
const EXT_MEDIA = '{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}'
const EXT_WEBVIDEO = '{C809E66F-F1BF-436E-B5F7-EEA9579F0CBA}'
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const SHOW_PART = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/

/**
 * A copy of the deck with these online videos embedded.
 *
 * Every slide, layout and master whose relationships link to one of the
 * targets is rewritten; every other part, including every byte of existing
 * media, is copied through unchanged. A video none of whose targets is in the
 * deck is not added, and a note says so.
 */
export function embedOnlineVideos(file: Uint8Array, videos: LocalVideo[]): EmbedResult {
  const dir = readZipDirectory(file)
  const text = (name: string) => strFromU8(entryData(file, dir.byName.get(name)!))
  const replace = new Map<string, Uint8Array>()
  const notes: string[] = []

  for (const v of videos) {
    if (!CONTENT_TYPE[v.ext]) throw new Error(`PowerPoint cannot embed a .${v.ext} file this way.`)
  }

  // Name the new files after the highest mediaN already in the package.
  let next =
    Math.max(0, ...dir.entries.map((e) => Number(/^ppt\/media\/media(\d+)\./.exec(e.name)?.[1] ?? 0))) + 1
  const partFor = new Map<LocalVideo, string>()
  const byTarget = new Map<string, LocalVideo>()
  for (const v of videos) {
    let name: string
    do name = `ppt/media/media${next++}.${v.ext}`
    while (dir.byName.has(name))
    partFor.set(v, name)
    for (const t of v.targets) byTarget.set(t, v)
  }

  const shapes = new Map<LocalVideo, number>()
  const found = new Set<string>()

  for (const entry of dir.entries) {
    if (!SHOW_PART.test(entry.name)) continue
    const relsName = relsPathFor(entry.name)
    if (!dir.byName.has(relsName)) continue
    const relsXml = text(relsName)
    const hits = parseRels(relsXml, entry.name).filter(
      (r) => r.external && r.type === 'video' && byTarget.has(r.target),
    )
    if (hits.length === 0) continue

    // One `media` relationship per video per part, however many shapes on it
    // play that video.
    const used = new Set([...walkTags(relsXml)].filter((t) => t.local === 'Relationship').map((t) => t.attrs.Id ?? ''))
    let n = 1
    const freshId = () => {
      while (used.has(`rId${n}`)) n++
      used.add(`rId${n}`)
      return `rId${n}`
    }
    const mediaRid = new Map<LocalVideo, string>()
    const forLink = new Map<string, { video: LocalVideo; mediaRid: string; startMs?: number }>()
    for (const r of hits) {
      const video = byTarget.get(r.target)!
      found.add(r.target)
      let rid = mediaRid.get(video)
      if (!rid) mediaRid.set(video, (rid = freshId()))
      const start = startSeconds(r.target)
      forLink.set(r.id, { video, mediaRid: rid, startMs: start ? Math.round(start * 1000) : undefined })
    }

    const target = (v: LocalVideo) => `../media/${partFor.get(v)!.slice('ppt/media/'.length)}`
    let rels = relsXml.replace(/<(\w+:)?Relationship\b[^>]*>/g, (tag, prefix: string | undefined) => {
      const attrs = [...walkTags(tag)][0]?.attrs ?? {}
      const hit = forLink.get(attrs.Id ?? '')
      if (!hit) return tag
      return `<${prefix ?? ''}Relationship Id="${attrs.Id}" Type="${xmlAttr(attrs.Type ?? '')}" Target="${target(hit.video)}"/>`
    })
    const close = /<\/(\w+:)?Relationships>\s*$/.exec(rels)
    if (!close) throw new Error(`${relsName} is not a relationships part.`)
    const prefix = close[1] ?? ''
    const added = [...mediaRid]
      .map(([v, id]) => `<${prefix}Relationship Id="${id}" Type="${MEDIA_REL}" Target="${target(v)}"/>`)
      .join('')
    rels = rels.slice(0, close.index) + added + rels.slice(close.index)
    replace.set(relsName, strToU8(rels))

    const { xml, converted } = embedInPart(text(entry.name), forLink)
    for (const [v, count] of converted) shapes.set(v, (shapes.get(v) ?? 0) + count)
    replace.set(entry.name, strToU8(xml))
  }

  const add: StoredFile[] = []
  const result: EmbedResult['added'] = []
  for (const v of videos) {
    const targets = v.targets.filter((t) => found.has(t))
    if (targets.length === 0) {
      notes.push(`Nothing in this deck links to ${v.targets.join(', ')}, so that file was not added.`)
      continue
    }
    const part = partFor.get(v)!
    add.push({ name: part, data: v.data, crc: v.crc })
    result.push({ part, targets, shapes: shapes.get(v) ?? 0 })
  }

  if (add.length > 0) {
    const types = text('[Content_Types].xml')
    let updated = types
    for (const ext of new Set(videos.filter((v) => add.some((a) => a.name === partFor.get(v))).map((v) => v.ext))) {
      if (new RegExp(`<(\\w+:)?Default\\b[^>]*\\bExtension="${ext}"`, 'i').test(updated)) continue
      const open = /<(\w+:)?Types\b[^>]*>/.exec(updated)
      if (!open) throw new Error('[Content_Types].xml has no <Types> element.')
      const at = open.index + open[0].length
      updated =
        updated.slice(0, at) +
        `<${open[1] ?? ''}Default Extension="${ext}" ContentType="${CONTENT_TYPE[ext]}"/>` +
        updated.slice(at)
    }
    if (updated !== types) replace.set('[Content_Types].xml', strToU8(updated))
  }

  return { parts: rewriteZip(file, dir, replace, add), added: result, notes }
}

const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Add the embedded-media extension to every shape whose `videoFile` links
 * through one of `forLink`'s relationships.
 *
 * Works on the text rather than a parsed tree, like `setShowFalse`: the rest
 * of the part has to come out exactly as it went in.
 */
export function embedInPart(
  xml: string,
  forLink: Map<string, { video: LocalVideo; mediaRid: string; startMs?: number }>,
): { xml: string; converted: Map<LocalVideo, number> } {
  const converted = new Map<LocalVideo, number>()
  let out = ''
  let pos = 0
  const videoFile = /<(\w+:)?videoFile\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = videoFile.exec(xml)) !== null) {
    const tag = [...walkTags(m[0])][0]
    if (!tag) continue
    const linkAttr = Object.keys(tag.attrs).find((k) => k === 'link' || k.endsWith(':link'))
    const hit = linkAttr ? forLink.get(tag.attrs[linkAttr]!) : undefined
    if (!hit) continue
    const r = linkAttr!.includes(':') ? `${linkAttr!.slice(0, linkAttr!.indexOf(':'))}:` : ''

    // The element may have children (an extLst of its own); skip past them.
    let after = m.index + m[0].length
    if (!tag.selfClose) {
      const close = xml.indexOf(`</${m[1] ?? ''}videoFile>`, after)
      if (close === -1) continue
      after = close + `</${m[1] ?? ''}videoFile>`.length
    }
    const nvPr = /<\/(\w+:)?nvPr>/g
    nvPr.lastIndex = after
    const end = nvPr.exec(xml)
    if (!end) continue
    const p = end[1] ?? ''

    out += xml.slice(pos, after) + withMediaExt(xml.slice(after, end.index), p, r, hit.mediaRid, hit.startMs)
    pos = end.index
    videoFile.lastIndex = end.index
    converted.set(hit.video, (converted.get(hit.video) ?? 0) + 1)
  }
  return { xml: out + xml.slice(pos), converted }
}

/** The tail of an `<p:nvPr>` after its `videoFile`, carrying `p14:media r:embed`. */
function withMediaExt(seg: string, p: string, r: string, rid: string, startMs?: number): string {
  const P = reEscape(p)
  const ext = (uri: string) =>
    new RegExp(`<${P}ext\\s+uri="${reEscape(uri)}"[^>]*>[\\s\\S]*?</${P}ext>`, 'i')
  const trim = startMs ? `<p14:trim st="${startMs}"/>` : ''

  seg = seg.replace(ext(EXT_WEBVIDEO), '')

  const existing = ext(EXT_MEDIA).exec(seg)
  if (existing) {
    // Repoint the media element that is there, keeping any trim the author set.
    const fixed = existing[0].replace(/<((\w+:)?media)\b([^>]*?)(\/?)>/, (_all, name: string, mp: string | undefined, attrs: string, self: string) => {
      const kept = attrs.replace(/\s[\w]+:(?:link|embed)\s*=\s*"[^"]*"/g, '')
      const open = `<${name}${kept} ${r}embed="${rid}"`
      const hasTrim = new RegExp(`<${reEscape(mp ?? '')}trim\\b`).test(existing[0])
      const ownTrim = startMs && !hasTrim ? `<${mp ?? ''}trim st="${startMs}"/>` : ''
      if (self) return ownTrim ? `${open}>${ownTrim}</${name}>` : `${open}/>`
      return `${open}>${ownTrim}`
    })
    return seg.slice(0, existing.index) + fixed + seg.slice(existing.index + existing[0].length)
  }

  const media =
    `<${p}ext uri="${EXT_MEDIA}"><p14:media xmlns:p14="${P14}" ${r}embed="${rid}"` +
    (trim ? `>${trim}</p14:media>` : '/>') +
    `</${p}ext>`
  const list = new RegExp(`<${P}extLst\\s*>`).exec(seg)
  if (list) return seg.slice(0, list.index + list[0].length) + media + seg.slice(list.index + list[0].length)
  // After any custDataLst: extLst is the last child of nvPr.
  return `${seg}<${p}extLst>${media}</${p}extLst>`
}
