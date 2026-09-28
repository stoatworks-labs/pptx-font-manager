import { useMemo, useState } from 'react'
import {
  hideSlides,
  mediaBytes,
  mediaFilenames,
  type EmbeddedMediaFile,
  type MediaPlacement,
  type MediaScanResult,
  type PlaybackSettings,
} from './core/media'
import { describeProbe, type Playback } from './core/mediaprobe'
import { storedZip } from './core/zipdir'

/**
 * The deck's video and sound: what is in it, whether it will play on the
 * show machine, what needs the internet, and two ways to take the media out
 * of PowerPoint's hands — save the files, and hide the slides that hold them.
 *
 * Everything here works on the deck already in memory. Nothing is uploaded,
 * and the saved files and the rewritten deck are views into the original
 * bytes wherever the zip format allows.
 */

type SaveParts = (parts: Uint8Array[], filename: string, type: string) => void

const PLAY_LABEL: Record<Playback, string> = {
  yes: 'plays',
  extension: 'needs codec pack',
  no: 'will not play',
  unknown: 'check it',
}
const PLAY_CLASS: Record<Playback, string> = { yes: 'ok', extension: 'warn', no: 'bad', unknown: 'warn' }

const VIA_LABEL: Record<string, string> = {
  'online-video': 'Online video',
  'add-in': 'Web add-in',
  flash: 'Flash object',
  hyperlink: 'Hyperlink',
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}

function playbackText(p: PlaybackSettings): string[] {
  const out: string[] = []
  if (p.start === 'automatically') out.push('starts automatically')
  else if (p.start === 'on-click') out.push('starts on click (in the click sequence)')
  else if (p.start === 'when-clicked-on') out.push('starts when clicked on')
  if (p.loop) out.push('loops')
  if (p.fullScreen) out.push('full screen')
  if (p.muted) out.push('muted')
  else if (p.volume !== undefined && p.volume < 100) out.push(`volume ${p.volume}%`)
  if (p.hideWhenStopped) out.push('hidden while not playing')
  return out
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`

function slideList(ns: number[]): string {
  if (ns.length === 0) return 'no slide'
  // 4, 5, 6, 9 -> "4–6, 9"
  const runs: string[] = []
  for (let i = 0; i < ns.length; ) {
    let j = i
    while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++
    runs.push(j - i >= 2 ? `${ns[i]}–${ns[j]}` : ns.slice(i, j + 1).join(', '))
    i = j + 1
  }
  return `${ns.length === 1 ? 'slide' : 'slides'} ${runs.join(', ')}`
}

export function MediaPanel({
  media,
  deck,
  deckName,
  busy,
  setBusy,
  setError,
  save,
}: {
  media: MediaScanResult
  deck: Uint8Array
  deckName: string
  busy: boolean
  setBusy: (s: string | null) => void
  setError: (s: string | null) => void
  save: SaveParts
}) {
  const names = useMemo(() => mediaFilenames(media), [media])
  const videos = media.files.filter((f) => f.kind === 'video')
  const sounds = media.files.filter((f) => f.kind === 'audio')
  const online = media.placements.filter(
    (p): p is Extract<MediaPlacement, { source: 'online' }> => p.source === 'online',
  )
  const linked = media.placements.filter(
    (p): p is Extract<MediaPlacement, { source: 'linked' }> => p.source === 'linked',
  )
  const problems = media.files.filter((f) => f.compat.verdict !== 'good')
  const totalSize = media.files.reduce((n, f) => n + f.size, 0)

  /** Slides with something that plays on them, for the hide list. */
  const mediaSlides = useMemo(() => {
    const by = new Map<number, { kinds: Set<string>; shapes: string[] }>()
    for (const p of media.placements) {
      if (p.source === 'online' && p.via === 'hyperlink') continue
      let e = by.get(p.slide)
      if (!e) by.set(p.slide, (e = { kinds: new Set(), shapes: [] }))
      e.kinds.add(p.source === 'online' ? 'online video' : p.kind)
      if (p.shape && !e.shapes.includes(p.shape)) e.shapes.push(p.shape)
    }
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, e]) => ({ slide: media.slides[n - 1]!, ...e }))
  }, [media])

  const defaultPick = () =>
    new Set(
      mediaSlides
        .filter((s) => !s.slide.hidden && (s.kinds.has('video') || s.kinds.has('online video')))
        .map((s) => s.slide.number),
    )
  const [pick, setPick] = useState<Set<number>>(defaultPick)

  const toggle = (n: number) =>
    setPick((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  const stem = deckName.replace(/\.(pptx|potx|ppsx)$/i, '')
  const ext = deckName.match(/\.(pptx|potx|ppsx)$/i)?.[0] ?? '.pptx'

  const saveOne = (f: EmbeddedMediaFile) => {
    setError(null)
    try {
      save([mediaBytes(deck, f.part)], names.get(f.part)!, 'application/octet-stream')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const saveAll = () => {
    setError(null)
    setBusy(`Packing ${media.files.length} file${media.files.length === 1 ? '' : 's'}…`)
    // Let the busy line paint before the synchronous work starts.
    setTimeout(() => {
      try {
        const files: Array<{ name: string; data: Uint8Array; crc?: number }> = media.files.map((f) => ({
          name: names.get(f.part)!,
          data: mediaBytes(deck, f.part),
          crc: f.crc,
        }))
        files.push({ name: 'MEDIA.txt', data: new TextEncoder().encode(manifest(media, names, deckName)) })
        save(storedZip(files), `${stem} - media.zip`, 'application/zip')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    }, 30)
  }

  const saveHidden = () => {
    setError(null)
    const parts = mediaSlides.filter((s) => pick.has(s.slide.number)).map((s) => s.slide.part)
    if (parts.length === 0) return
    setBusy(`Hiding ${parts.length} slide${parts.length === 1 ? '' : 's'}…`)
    setTimeout(() => {
      try {
        save(
          hideSlides(deck, parts),
          `${stem} (media slides hidden)${ext}`,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        )
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    }, 30)
  }

  if (media.placements.length === 0 && media.warnings.length === 0) {
    return (
      <section className="media">
        <h2>Video &amp; audio</h2>
        <p className="quiet">No video, sound or online media in this deck.</p>
      </section>
    )
  }

  // Group online references by address: a layout video, or one link pasted
  // on every slide, is one thing to check, not twenty.
  const onlineByUrl = new Map<string, typeof online>()
  for (const p of online) {
    const list = onlineByUrl.get(p.url) ?? []
    list.push(p)
    onlineByUrl.set(p.url, list)
  }

  return (
    <section className="media">
      <h2>Video &amp; audio</h2>

      <div className="summary">
        <div className="stat">
          <div className="n">{videos.length}</div>
          <div className="l">video file{videos.length === 1 ? '' : 's'} embedded</div>
        </div>
        {sounds.length > 0 && (
          <div className="stat">
            <div className="n">{sounds.length}</div>
            <div className="l">sound file{sounds.length === 1 ? '' : 's'}</div>
          </div>
        )}
        <div className={`stat ${problems.length ? 'warn' : 'ok'}`}>
          <div className="n">{problems.length}</div>
          <div className="l">may not play</div>
        </div>
        <div className={`stat ${onlineByUrl.size ? 'bad' : 'ok'}`}>
          <div className="n">{onlineByUrl.size}</div>
          <div className="l">need the internet</div>
        </div>
        {linked.length > 0 && (
          <div className="stat bad">
            <div className="n">{linked.length}</div>
            <div className="l">linked, not in the file</div>
          </div>
        )}
      </div>

      {onlineByUrl.size > 0 && (
        <div className="note bad">
          <strong>
            {onlineByUrl.size === 1 ? 'One thing' : `${onlineByUrl.size} things`} in this deck will
            not play without an internet connection.
          </strong>{' '}
          Venue networks often block streaming sites, or have no internet at all. Download the
          video, insert it as a file, and it travels with the deck.
          <ul className="online">
            {[...onlineByUrl.entries()].map(([url, ps]) => {
              const p = ps[0]!
              const slides = [...new Set(ps.map((x) => x.slide))].sort((a, b) => a - b)
              return (
                <li key={url}>
                  <strong>{p.online.label}</strong> · {VIA_LABEL[p.via]} · {slideList(slides)}
                  {p.inheritedFrom && ` (from the slide ${p.inheritedFrom})`}
                  {p.shape && <> · “{p.shape}”</>}
                  <div className="url">
                    {/^https?:/i.test(url) ? (
                      <a href={url} target="_blank" rel="noreferrer noopener">
                        {url}
                      </a>
                    ) : (
                      url
                    )}
                  </div>
                  {onlineNote(p)}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {linked.length > 0 && (
        <div className="note bad">
          <strong>
            {linked.length === 1 ? 'One video is' : `${linked.length} videos are`} linked, not
            embedded.
          </strong>{' '}
          The deck only records where the file was on the author&rsquo;s computer. Unless the file
          is copied to the same place on the show machine, the slide shows a blank frame.
          <ul className="online">
            {linked.map((p, i) => (
              <li key={i}>
                Slide {p.slide} · “{p.shape}”<div className="url">{p.target}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {media.files.length > 0 && (
        <>
          <div className="bar">
            <button onClick={saveAll} disabled={busy}>
              Save all {media.files.length} file{media.files.length === 1 ? '' : 's'} (.zip,{' '}
              {formatBytes(totalSize)})
            </button>
          </div>
          <div className="fonts">
            {media.files.map((f) => (
              <MediaRow
                key={f.part}
                f={f}
                name={names.get(f.part)!}
                placements={media.placements.filter((p) => p.source === 'embedded' && p.part === f.part)}
                busy={busy}
                onSave={() => saveOne(f)}
              />
            ))}
          </div>
        </>
      )}

      {mediaSlides.length > 0 && (
        <details className="hide-slides" open>
          <summary>Hide the slides that play media</summary>
          <p>
            For a show where the video runs from a media server or playback machine rather than
            PowerPoint: save the files above, then download a copy of the deck with these slides
            hidden. Hidden, not deleted — they stay in the deck and the slideshow steps over them.
            Your original file is not changed.
          </p>
          <div className="pick">
            {mediaSlides.map(({ slide, kinds, shapes }) => (
              <label key={slide.number} className={slide.hidden ? 'already' : ''}>
                <input
                  type="checkbox"
                  checked={pick.has(slide.number)}
                  disabled={slide.hidden}
                  onChange={() => toggle(slide.number)}
                />
                <span>
                  <strong>Slide {slide.number}</strong>
                  {slide.title && <> — {slide.title}</>}
                  <span className="quiet">
                    {' '}
                    · {[...kinds].join(', ')}
                    {shapes.length > 0 && ` · ${shapes.slice(0, 3).join(', ')}${shapes.length > 3 ? '…' : ''}`}
                    {slide.hidden && ' · already hidden'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="bar">
            <button className="primary" onClick={saveHidden} disabled={busy || pick.size === 0}>
              Download copy with {pick.size} slide{pick.size === 1 ? '' : 's'} hidden
            </button>
            <button onClick={() => setPick(defaultPick())} disabled={busy}>
              Video slides
            </button>
            <button
              onClick={() => setPick(new Set(mediaSlides.filter((s) => !s.slide.hidden).map((s) => s.slide.number)))}
              disabled={busy}
            >
              All media slides
            </button>
            <button onClick={() => setPick(new Set())} disabled={busy}>
              None
            </button>
          </div>
        </details>
      )}

      {media.warnings.length > 0 && (
        <div className="note warn">
          {media.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
    </section>
  )
}

function onlineNote(p: Extract<MediaPlacement, { source: 'online' }>) {
  if (p.via === 'flash') {
    return <div className="why">Flash is retired — this will not play anywhere, online or not.</div>
  }
  if (p.online.retired) {
    return <div className="why">{p.online.label} has been retired. This will not play for anyone.</div>
  }
  const bits: string[] = []
  if (p.online.signIn) {
    bits.push(
      'Plays only if PowerPoint is signed in to an account in that organisation with access to the file.',
    )
  }
  if (p.via === 'add-in') bits.push('The add-in itself also has to load, which some networks and IT policies block.')
  if (p.via === 'hyperlink') bits.push('Opens a web browser rather than playing on the slide.')
  return bits.length ? <div className="why">{bits.join(' ')}</div> : null
}

function MediaRow({
  f,
  name,
  placements,
  busy,
  onSave,
}: {
  f: EmbeddedMediaFile
  name: string
  placements: MediaPlacement[]
  busy: boolean
  onSave: () => void
}) {
  const { compat } = f
  const trims = placements.filter((p) => p.playback.trimStartMs || p.playback.trimEndMs)
  const inherited = placements.find((p) => p.inheritedFrom)
  // Playback settings are per placement; show the first slide's, and say so
  // when others differ.
  const first = placements[0]
  const how = first ? playbackText(first.playback) : []
  const differs =
    placements.length > 1 &&
    placements.some((p) => JSON.stringify(p.playback) !== JSON.stringify(first!.playback))

  return (
    <div className="row">
      <div>
        <div className="name">{name}</div>
        <div className="meta">
          <span className="pill tier">{f.kind}</span> {slideList(f.slides)}
          {inherited && ` (on the slide ${inherited.inheritedFrom})`} · {formatBytes(f.size)} ·{' '}
          <code>{f.part.replace(/^ppt\//, '')}</code>
        </div>
        <div className="meta">{describeProbe(f.probe)}</div>
        {how.length > 0 && (
          <div className="meta">
            {first!.slide === f.slides[0] && placements.length > 1 ? `On slide ${first!.slide}: ` : ''}
            {how.join(' · ')}
            {differs && ' — set differently on other slides'}
          </div>
        )}
        {compat.issues.length > 0 && (
          <div className={`sub ${compat.verdict === 'bad' ? 'sub-media-bad' : 'sub-similar'}`}>
            {compat.issues.map((s, i) => (
              <div key={i}>{s}</div>
            ))}
          </div>
        )}
        {trims.length > 0 && (
          <div className="sub sub-embed-subset">
            Trimmed in PowerPoint
            {trims[0]!.playback.trimStartMs ? ` (start ${secs(trims[0]!.playback.trimStartMs)}` : ' ('}
            {trims[0]!.playback.trimEndMs
              ? `${trims[0]!.playback.trimStartMs ? ', ' : ''}end ${secs(trims[0]!.playback.trimEndMs)})`
              : ')'}
            . The saved file is the untrimmed original.
          </div>
        )}
      </div>
      <div className="actions">
        <span className={`pill ${PLAY_CLASS[compat.windows]}`} title="PowerPoint for Windows">
          Windows: {PLAY_LABEL[compat.windows]}
        </span>
        <span className={`pill ${PLAY_CLASS[compat.mac]}`} title="PowerPoint for Mac">
          Mac: {PLAY_LABEL[compat.mac]}
        </span>
        <button onClick={onSave} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  )
}

/** MEDIA.txt: which file goes with which slide, and how PowerPoint played it. */
function manifest(media: MediaScanResult, names: Map<string, string>, deckName: string): string {
  const lines: string[] = [
    `Media from ${deckName}`,
    `Saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    'Each file is exactly as embedded in the deck. Trims, volume and looping are',
    'PowerPoint settings, not part of the file; they are listed here so the',
    'playback machine can match them.',
    '',
  ]
  for (const f of media.files) {
    lines.push(names.get(f.part)!)
    lines.push(`  ${slideList(f.slides)} · ${formatBytes(f.size)} · ${f.part}`)
    lines.push(`  ${describeProbe(f.probe)}`)
    lines.push(`  PowerPoint for Windows: ${PLAY_LABEL[f.compat.windows]} · Mac: ${PLAY_LABEL[f.compat.mac]}`)
    for (const issue of f.compat.issues) lines.push(`  ! ${issue}`)
    for (const p of media.placements) {
      if (p.source !== 'embedded' || p.part !== f.part) continue
      const how = playbackText(p.playback)
      if (p.playback.trimStartMs) how.push(`trim start ${secs(p.playback.trimStartMs)}`)
      if (p.playback.trimEndMs) how.push(`trim end ${secs(p.playback.trimEndMs)}`)
      lines.push(`  slide ${p.slide}${p.inheritedFrom ? ` (${p.inheritedFrom})` : ''} “${p.shape}”: ${how.join(', ') || 'default settings'}`)
    }
    lines.push('')
  }
  const online = media.placements.filter((p) => p.source === 'online')
  if (online.length) {
    lines.push('NEEDS THE INTERNET — not included here', '')
    for (const p of online) {
      if (p.source !== 'online') continue
      lines.push(`  slide ${p.slide} · ${p.online.label} · ${VIA_LABEL[p.via]} · ${p.url}`)
    }
    lines.push('')
  }
  const linked = media.placements.filter((p) => p.source === 'linked')
  if (linked.length) {
    lines.push('LINKED FROM THE AUTHOR’S DISK — not in the deck, not included here', '')
    for (const p of linked) if (p.source === 'linked') lines.push(`  slide ${p.slide} · ${p.target}`)
    lines.push('')
  }
  return lines.join('\r\n')
}
