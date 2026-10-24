import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strFromU8 } from 'fflate'
import { scanMedia, mediaBytes } from '../src/core/media'
import { readZipDirectory, entryData, crc32 } from '../src/core/zipdir'
import {
  videosToFetch,
  youtubeId,
  downloadKey,
  startSeconds,
  embedOnlineVideos,
  type LocalVideo,
} from '../src/core/localvideo'

/**
 * test/fixtures/online-video.pptx was made in PowerPoint for Mac 16.x with
 * Insert ▸ Video ▸ Online Film, twice: Big Buck Bunny (CC-BY, Blender
 * Foundation) by its watch URL on slide 1, and by `youtu.be/…?t=95` on
 * slide 2. It is committed, unlike the private real-world fixtures.
 *
 * test/fixtures/media.pptx is the synthetic deck from make-media-deck.mjs,
 * whose online video also carries a `p15:webVideoPr` embed code.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) out.set(p, o), (o += p.length)
  return out
}
/** A real, tiny H.264/AAC clip to stand in for a download. */
const clip = () => mediaBytes(fixture('media.pptx'), 'ppt/media/media1.mp4')
const part = (deck: Uint8Array, name: string) => {
  const dir = readZipDirectory(deck)
  return strFromU8(entryData(deck, dir.byName.get(name)!))
}

/** Every entry's data matches the CRC its directory claims. */
function assertIntact(deck: Uint8Array) {
  const dir = readZipDirectory(deck)
  for (const e of dir.entries) {
    expect(crc32(entryData(deck, e)), e.name).toBe(e.crc)
  }
}

describe('links', () => {
  it('finds the YouTube id in every shape of link', () => {
    for (const url of [
      'https://www.youtube.com/embed/aqz-KE-bpKQ?feature=oembed',
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=95s',
      'https://youtu.be/aqz-KE-bpKQ?t=95',
      'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
      'https://m.youtube.com/shorts/aqz-KE-bpKQ',
      'http://www.youtube.com/v/aqz-KE-bpKQ',
    ]) {
      expect(youtubeId(url), url).toBe('aqz-KE-bpKQ')
    }
    expect(youtubeId('https://www.youtube.com/@blender')).toBeUndefined()
    expect(youtubeId('https://vimeo.com/76979871')).toBeUndefined()
  })

  it('makes one download of two links to one video', () => {
    expect(downloadKey('https://www.youtube.com/embed/aqz-KE-bpKQ?start=95&feature=oembed')).toEqual({
      key: 'youtube:aqz-KE-bpKQ',
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    })
    expect(downloadKey('https://vimeo.com/76979871#t=30s')).toEqual({
      key: 'https://vimeo.com/76979871',
      url: 'https://vimeo.com/76979871',
    })
  })

  it('reads start times however they are written', () => {
    expect(startSeconds('https://www.youtube.com/embed/x?start=95&feature=oembed')).toBe(95)
    expect(startSeconds('https://youtu.be/x?t=95')).toBe(95)
    expect(startSeconds('https://youtu.be/x?t=95s')).toBe(95)
    expect(startSeconds('https://www.youtube.com/watch?v=x&t=1m35s')).toBe(95)
    expect(startSeconds('https://www.youtube.com/watch?v=x&t=1h0m5s')).toBe(3605)
    expect(startSeconds('https://vimeo.com/1#t=1m35s')).toBe(95)
    expect(startSeconds('https://www.youtube.com/embed/x?feature=oembed')).toBeUndefined()
    expect(startSeconds('https://www.youtube.com/watch?v=x&t=0')).toBeUndefined()
    expect(startSeconds('https://www.youtube.com/watch?v=x&t=soon')).toBeUndefined()
  })
})

describe('what to fetch', () => {
  it('groups PowerPoint’s two links to one video into one download', () => {
    const { fetch, skipped } = videosToFetch(scanMedia(fixture('online-video.pptx')))
    expect(skipped).toEqual([])
    expect(fetch).toHaveLength(1)
    expect(fetch[0]).toMatchObject({
      key: 'youtube:aqz-KE-bpKQ',
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      label: 'YouTube',
      slides: [1, 2],
    })
    expect(fetch[0]!.targets).toEqual([
      'https://www.youtube.com/embed/aqz-KE-bpKQ?feature=oembed',
      'https://www.youtube.com/embed/aqz-KE-bpKQ?start=95&feature=oembed',
    ])
  })

  it('offers only online-video shapes, and says why the rest are left', () => {
    const { fetch, skipped } = videosToFetch(scanMedia(fixture('media.pptx')))
    // The YouTube shape. Not the Vimeo hyperlink, the Flash object or the add-in.
    expect(fetch.map((f) => f.key)).toEqual(['youtube:aqz-KE-bpKQ'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ label: 'Microsoft Stream' })
    expect(skipped[0]!.reason).toMatch(/sign-in/)
  })
})

describe('embedding', () => {
  it('turns PowerPoint’s own online videos into an embedded file', () => {
    const deck = fixture('online-video.pptx')
    const { fetch } = videosToFetch(scanMedia(deck))
    const video: LocalVideo = { targets: fetch[0]!.targets, data: clip(), ext: 'mp4' }
    const r = embedOnlineVideos(deck, [video])
    const out = concat(r.parts)

    expect(r.notes).toEqual([])
    expect(r.added).toEqual([{ part: 'ppt/media/media1.mp4', targets: fetch[0]!.targets, shapes: 2 }])
    assertIntact(out)

    const after = scanMedia(out)
    expect(after.placements.filter((p) => p.source === 'online')).toEqual([])
    expect(after.files).toHaveLength(1)
    expect(after.files[0]).toMatchObject({ part: 'ppt/media/media1.mp4', slides: [1, 2], kind: 'video' })
    expect(after.files[0]!.compat.verdict).toBe('good')
    expect(after.warnings).toEqual([])

    // The link with ?t=95 starts at 95 s, as it did online; the other is untrimmed.
    const bySlide = (n: number) => after.placements.find((p) => p.slide === n)!
    expect(bySlide(1).playback.trimStartMs).toBeUndefined()
    expect(bySlide(2).playback.trimStartMs).toBe(95000)
    // The timing PowerPoint wrote for the online video still applies.
    expect(bySlide(1).playback.start).toBe('on-click')

    const rels = part(out, 'ppt/slides/_rels/slide2.xml.rels')
    expect(rels).not.toMatch(/External/)
    expect(rels).toContain(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/media1.mp4"/>',
    )
    expect(rels).toContain(
      '<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/media1.mp4"/>',
    )
    // The poster frame stays.
    expect(rels).toContain('Target="../media/image1.jpeg"')

    const slide2 = part(out, 'ppt/slides/slide2.xml')
    expect(slide2).toContain(
      '<a:videoFile r:link="rId1"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">' +
        '<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId4">' +
        '<p14:trim st="95000"/></p14:media></p:ext></p:extLst></p:nvPr>',
    )
    expect(part(out, '[Content_Types].xml')).toContain('<Default Extension="mp4" ContentType="video/mp4"/>')

    // Only the touched parts changed; the poster is the same bytes.
    const dirIn = readZipDirectory(deck)
    const dirOut = readZipDirectory(out)
    expect(dirOut.entries).toHaveLength(dirIn.entries.length + 1)
    expect(dirOut.byName.get('ppt/media/image1.jpeg')!.crc).toBe(dirIn.byName.get('ppt/media/image1.jpeg')!.crc)
    expect(part(out, 'ppt/slides/slide1.xml').length).toBeGreaterThan(part(deck, 'ppt/slides/slide1.xml').length)
    expect(part(out, 'ppt/presentation.xml')).toBe(part(deck, 'ppt/presentation.xml'))
  })

  it('removes the embed code and repoints p14:media, leaving everything else alone', () => {
    const deck = fixture('media.pptx')
    const { fetch } = videosToFetch(scanMedia(deck))
    const r = embedOnlineVideos(deck, [{ targets: fetch[0]!.targets, data: clip(), ext: 'mp4' }])
    const out = concat(r.parts)
    assertIntact(out)

    // media1–7 exist, so the new file is media8.
    expect(r.added).toEqual([{ part: 'ppt/media/media8.mp4', targets: fetch[0]!.targets, shapes: 1 }])
    const slide = part(out, 'ppt/slides/slide2.xml')
    expect(slide).not.toContain('webVideoPr')
    expect(slide).toMatch(/<p14:media [^>]*r:embed="rId1"\/?>/)
    expect(slide).not.toMatch(/<p14:media [^>]*r:link=/)

    const before = scanMedia(deck)
    const after = scanMedia(out)
    const online = (m: typeof before) =>
      m.placements.filter((p) => p.source === 'online').map((p) => `${p.slide} ${p.source === 'online' && p.via} ${p.source === 'online' && p.url}`)
    // The YouTube shape went; the hyperlink, Stream, Flash and add-in did not.
    expect(online(after)).toEqual(online(before).filter((s) => !s.startsWith('3 online-video https://www.youtube.com')))
    expect(after.files.map((f) => f.part)).toContain('ppt/media/media8.mp4')

    // Every media part that was there is byte for byte the same.
    const dirIn = readZipDirectory(deck)
    for (const e of dirIn.entries.filter((e) => e.name.startsWith('ppt/media/'))) {
      expect(mediaBytes(out, e.name)).toEqual(entryData(deck, e))
    }
    // mp4 was already declared; it is not declared twice.
    expect(part(out, '[Content_Types].xml').match(/Extension="mp4"/g)).toHaveLength(1)
  })

  it('adds nothing for a video the deck does not link to', () => {
    const deck = fixture('online-video.pptx')
    const r = embedOnlineVideos(deck, [{ targets: ['https://vimeo.com/1'], data: clip(), ext: 'mp4' }])
    expect(r.added).toEqual([])
    expect(r.notes).toHaveLength(1)
    expect(readZipDirectory(concat(r.parts)).entries).toHaveLength(readZipDirectory(deck).entries.length)
  })

  it('refuses a format PowerPoint cannot embed', () => {
    expect(() =>
      embedOnlineVideos(fixture('online-video.pptx'), [
        { targets: [], data: clip(), ext: 'webm' as LocalVideo['ext'] },
      ]),
    ).toThrow(/webm/)
  })
})
