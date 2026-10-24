import { useEffect, useMemo, useRef, useState } from 'react'
import type { MediaScanResult } from './core/media'
import { probeMedia, assessCompat, describeProbe, type Compat, type MediaProbe } from './core/mediaprobe'
import { videosToFetch, embedOnlineVideos, type LocalVideo, type VideoToFetch } from './core/localvideo'
import {
  videoTools,
  fetchVideoTool,
  downloadVideo,
  cancelDownload,
  readVideo,
  discardVideo,
  onVideoProgress,
  type ToolInfo,
  type ToolName,
  type ToolsReport,
  type VideoProgress,
} from './platform/video'

/**
 * Desktop only: download a deck's online videos and save a copy of the deck
 * with them embedded, so it plays with no network at all.
 *
 * yt-dlp does the downloading, with ffmpeg to join YouTube's separate picture
 * and sound and Deno to answer its script challenges — see
 * `src-tauri/src/video.rs` for what each one buys. The deck itself is
 * rewritten by `embedOnlineVideos`, and the original is never touched.
 */

type SaveParts = (parts: Uint8Array[], filename: string, type: string) => Promise<string | null | void>

const TOOL_LABEL: Record<ToolName, string> = { 'yt-dlp': 'yt-dlp', ffmpeg: 'ffmpeg', deno: 'Deno' }
const TOOL_WHY: Record<ToolName, string> = {
  'yt-dlp': 'Does the downloading.',
  ffmpeg:
    'Joins the picture and sound, which YouTube sends separately. Without it there is nothing PowerPoint can play from YouTube.',
  deno: 'Answers YouTube’s script checks. Without it you get 360p or less, and yt-dlp calls that way of working deprecated.',
}
const TOOL_SIZE: Record<ToolName, string> = { 'yt-dlp': 'about 37 MB', ffmpeg: 'about 30–200 MB', deno: 'about 40 MB' }
const ORDER: ToolName[] = ['yt-dlp', 'ffmpeg', 'deno']

type Status =
  | { state: 'waiting' }
  | { state: 'downloading'; progress?: VideoProgress }
  | { state: 'done'; title: string | null; size: number; probe: MediaProbe; compat: Compat; warnings: string[] }
  | { state: 'failed'; error: string }

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`)

function progressText(p?: VideoProgress): string {
  if (!p) return 'Starting…'
  const part = p.audio ? 'Sound' : 'Picture'
  if (p.downloaded != null && p.total) {
    const pct = Math.min(100, Math.round((p.downloaded / p.total) * 100))
    if (pct >= 100 && p.audio) return 'Joining picture and sound…'
    return `${part}: ${pct}% of ${mb(p.total)}`
  }
  if (p.downloaded != null) return `${part}: ${mb(p.downloaded)}`
  return `${part}…`
}

export function VideoFetchPanel({
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
  const { fetch: wanted, skipped } = useMemo(() => videosToFetch(media), [media])
  const [tools, setTools] = useState<ToolsReport | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [fetching, setFetching] = useState<ToolName | null>(null)
  const [height, setHeight] = useState(1080)
  const [pick, setPick] = useState<Set<string>>(() => new Set(wanted.map((w) => w.key)))
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [running, setRunning] = useState(false)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const cancelled = useRef(false)
  const current = useRef<string | null>(null)
  const jobKey = useRef(new Map<string, string>())

  useEffect(() => {
    let live = true
    videoTools()
      .then((t) => live && setTools(t))
      .catch((e) => live && setToolsError(String(e)))
    const unlisten = onVideoProgress((p) => {
      const key = jobKey.current.get(p.job)
      if (key) setStatus((s) => ({ ...s, [key]: { state: 'downloading', progress: p } }))
    })
    return () => {
      live = false
      void unlisten.then((u) => u())
    }
  }, [])

  const info = (t: ToolName): ToolInfo | undefined => tools?.tools.find((x) => x.tool === t)
  const have = (t: ToolName) => !!info(t)?.path
  const missing = ORDER.filter((t) => tools && !have(t))

  const getTools = async (list: ToolName[]) => {
    setError(null)
    for (const t of list) {
      setFetching(t)
      try {
        const got = await fetchVideoTool(t)
        setTools((r) => (r ? { ...r, tools: r.tools.map((x) => (x.tool === t ? got : x)) } : r))
      } catch (e) {
        setError(`Could not get ${TOOL_LABEL[t]}: ${String(e)}`)
        break
      }
    }
    setFetching(null)
  }

  const run = async () => {
    const chosen = wanted.filter((w) => pick.has(w.key))
    if (chosen.length === 0) return
    setError(null)
    setSavedTo(null)
    setRunning(true)
    cancelled.current = false
    setStatus(Object.fromEntries(chosen.map((w) => [w.key, { state: 'waiting' } as Status])))

    const videos: LocalVideo[] = []
    for (const [i, w] of chosen.entries()) {
      if (cancelled.current) break
      const job = `v${Date.now().toString(36)}${i}`
      jobKey.current.set(job, w.key)
      current.current = job
      setStatus((s) => ({ ...s, [w.key]: { state: 'downloading' } }))
      try {
        const got = await downloadVideo(job, w.url, height)
        const data = await readVideo(job)
        await discardVideo(job)
        const ext = (got.ext ?? '').toLowerCase()
        if (!['mp4', 'm4v', 'mov'].includes(ext)) {
          throw new Error(`It came back as .${ext || '?'}, which PowerPoint cannot play.`)
        }
        const probe = probeMedia(data)
        videos.push({ targets: w.targets, data, ext: ext === 'mov' ? 'mov' : 'mp4' })
        setStatus((s) => ({
          ...s,
          [w.key]: { state: 'done', title: got.title, size: data.length, probe, compat: assessCompat(probe), warnings: got.warnings },
        }))
      } catch (e) {
        setStatus((s) => ({ ...s, [w.key]: { state: 'failed', error: String(e).replace(/^Error: /, '') } }))
      } finally {
        current.current = null
      }
    }

    if (videos.length > 0 && !cancelled.current) {
      setBusy(`Writing a copy with ${videos.length} video${videos.length === 1 ? '' : 's'} embedded…`)
      try {
        const stem = deckName.replace(/\.(pptx|potx|ppsx)$/i, '')
        const ext = deckName.match(/\.(pptx|potx|ppsx)$/i)?.[0] ?? '.pptx'
        const r = embedOnlineVideos(deck, videos)
        if (r.notes.length) setError(r.notes.join(' '))
        const where = await save(
          r.parts,
          `${stem} (videos embedded)${ext}`,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        )
        if (where) setSavedTo(where)
      } catch (e) {
        setError(`Could not write the deck: ${String(e)}`)
      } finally {
        setBusy(null)
      }
    }
    setRunning(false)
  }

  const cancel = () => {
    cancelled.current = true
    if (current.current) void cancelDownload(current.current)
  }

  const ready = have('yt-dlp')
  const chosenCount = wanted.filter((w) => pick.has(w.key)).length

  return (
    <div className="video-fetch">
      <h3>Download them and embed them in a copy</h3>
      <p className="quiet">
        Downloads each video and saves a copy of this deck that plays it from inside the file, with
        no network at all. Your original deck is not changed. Download only videos you have the
        right to show: YouTube’s terms do not allow downloading except where YouTube itself offers
        a download link.
      </p>

      <div className="fonts">
        {!tools && !toolsError && (
          <div className="row">
            <div className="meta">
              <span className="spin" />
              Looking for yt-dlp, ffmpeg and Deno…
            </div>
          </div>
        )}
        {toolsError && (
          <div className="row">
            <div className="sub sub-media-bad">Could not check for the download tools: {toolsError}</div>
          </div>
        )}
        {tools &&
          ORDER.map((t) => {
            const i = info(t)
            return (
              <div className="row" key={t}>
                <div>
                  <div className="name">{TOOL_LABEL[t]}</div>
                  <div className="meta">{TOOL_WHY[t]}</div>
                  {i?.path && (
                    <div className="meta">
                      {i.version ? `${i.version} · ` : ''}
                      {i.managed ? 'this app’s own copy' : <code>{i.path}</code>}
                    </div>
                  )}
                </div>
                <div className="actions">
                  {i?.path ? (
                    <span className={`pill ${i.version ? 'ok' : 'warn'}`}>{i.version ? 'ready' : 'will not run'}</span>
                  ) : (
                    <span className={`pill ${t === 'deno' ? 'warn' : 'bad'}`}>missing</span>
                  )}
                  {tools.canFetch && (!i?.path || i.managed) && (
                    <button
                      onClick={() => void getTools([t])}
                      disabled={!!fetching || running}
                      title={`From the official release, ${TOOL_SIZE[t]}`}
                    >
                      {fetching === t ? (
                        <>
                          <span className="spin" />
                          Getting…
                        </>
                      ) : i?.path ? (
                        'Update'
                      ) : (
                        `Get ${TOOL_LABEL[t]}`
                      )}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
      </div>
      {tools && missing.length > 1 && tools.canFetch && (
        <div className="bar" style={{ marginTop: 10 }}>
          <button onClick={() => void getTools(missing)} disabled={!!fetching || running}>
            Get all {missing.length}
          </button>
          <span className="quiet">
            Each comes from its publisher’s own release and is checked against the checksum
            published beside it. They are installed for this app only, in {tools.managedDir}.
          </span>
        </div>
      )}

      <div className="pick" style={{ marginTop: 14 }}>
        {wanted.map((w) => (
          <FetchRow
            key={w.key}
            w={w}
            checked={pick.has(w.key)}
            disabled={running}
            status={status[w.key]}
            onToggle={() =>
              setPick((prev) => {
                const next = new Set(prev)
                if (next.has(w.key)) next.delete(w.key)
                else next.add(w.key)
                return next
              })
            }
          />
        ))}
      </div>

      <div className="bar">
        <button className="primary" onClick={() => void run()} disabled={!ready || running || busy || chosenCount === 0}>
          {running ? (
            <>
              <span className="spin" />
              Downloading…
            </>
          ) : (
            `Download ${chosenCount} and save a copy with ${chosenCount === 1 ? 'it' : 'them'} embedded`
          )}
        </button>
        {running && <button onClick={cancel}>Cancel</button>}
        <label className="quiet">
          Up to{' '}
          <select value={height} onChange={(e) => setHeight(Number(e.target.value))} disabled={running}>
            <option value={1080}>1080p</option>
            <option value={720}>720p</option>
            <option value={480}>480p</option>
          </select>
        </label>
        {!ready && tools && <span className="quiet">Get yt-dlp first.</span>}
      </div>
      <p className="quiet">
        1080p is the most YouTube offers in H.264, the one format every PowerPoint plays; above that
        it is VP9 or AV1, which PowerPoint for Mac cannot decode. A link with a start time becomes a
        trim, so the slide starts where the online video did.
      </p>

      {savedTo && (
        <div className="note info">
          <strong>Saved.</strong> {savedTo}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="note warn">
          <strong>Left as they are:</strong>
          <ul className="online">
            {skipped.map((s) => (
              <li key={s.url}>
                {s.label} · slide{s.slides.length === 1 ? '' : 's'} {s.slides.join(', ')}
                <div className="why">{s.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function FetchRow({
  w,
  checked,
  disabled,
  status,
  onToggle,
}: {
  w: VideoToFetch
  checked: boolean
  disabled: boolean
  status?: Status
  onToggle: () => void
}) {
  return (
    <label>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span>
        <strong>{w.label}</strong> · slide{w.slides.length === 1 ? '' : 's'} {w.slides.join(', ')}
        {w.shapes.length > 0 && <span className="quiet"> · {w.shapes.slice(0, 2).join(', ')}</span>}
        <div className="quiet">
          <code>{w.url}</code>
        </div>
        {status?.state === 'waiting' && <div className="quiet">Waiting…</div>}
        {status?.state === 'downloading' && (
          <div className="quiet">
            <span className="spin" />
            {progressText(status.progress)}
          </div>
        )}
        {status?.state === 'done' && (
          <div className="quiet">
            <span className={`pill ${status.compat.verdict === 'good' ? 'ok' : status.compat.verdict === 'bad' ? 'bad' : 'warn'}`}>
              {status.compat.verdict === 'good' ? 'plays on Windows and Mac' : 'check it'}
            </span>{' '}
            {status.title ? `“${status.title}” · ` : ''}
            {mb(status.size)} · {describeProbe(status.probe)}
            {status.compat.issues.map((s, i) => (
              <div key={i}>{s}</div>
            ))}
            {status.warnings.map((s, i) => (
              <div key={`w${i}`}>{s}</div>
            ))}
          </div>
        )}
        {status?.state === 'failed' && <div className="sub sub-media-bad">{status.error}</div>}
      </span>
    </label>
  )
}
