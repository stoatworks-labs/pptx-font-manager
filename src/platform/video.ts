/**
 * Desktop only: yt-dlp and its helpers, and saving through a native dialog.
 *
 * The Rust side (`src-tauri/src/video.rs`) finds, fetches and runs the tools;
 * `src/core/localvideo.ts` rewrites the deck. Nothing here works in a browser
 * tab — call `isDesktop()` first.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type ToolName = 'yt-dlp' | 'deno' | 'ffmpeg'

export interface ToolInfo {
  tool: ToolName
  path: string | null
  version: string | null
  /** This app's own copy, fetched from the publisher. Anything else is the user's. */
  managed: boolean
}

export interface ToolsReport {
  tools: ToolInfo[]
  managedDir: string
  canFetch: boolean
}

export const videoTools = () => invoke<ToolsReport>('video_tools')

/** Fetch the official release, check its checksum, install it for this app only. */
export const fetchVideoTool = (tool: ToolName) => invoke<ToolInfo>('fetch_video_tool', { tool })

export interface Downloaded {
  job: string
  size: number
  filepath: string | null
  title: string | null
  id: string | null
  duration: number | null
  width: number | null
  height: number | null
  vcodec: string | null
  acodec: string | null
  ext: string | null
  warnings: string[]
}

export const downloadVideo = (job: string, url: string, maxHeight: number) =>
  invoke<Downloaded>('download_video', { job, url, maxHeight })

export const cancelDownload = (job: string) => invoke<void>('cancel_download', { job })

/** A finished download's bytes, over the raw IPC response rather than as JSON. */
export async function readVideo(job: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer | number[]>('read_video', { job })
  return buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf)
}

export const discardVideo = (job: string) => invoke<void>('discard_video', { job })

export interface VideoProgress {
  job: string
  downloaded: number | null
  total: number | null
  format: string | null
  /** The stream in flight is the sound, which YouTube serves separately. */
  audio: boolean
}

export const onVideoProgress = (cb: (p: VideoProgress) => void): Promise<UnlistenFn> =>
  listen<VideoProgress>('video-progress', (e) => cb(e.payload))

/**
 * Debug builds only: the deck `PFM_DEBUG_OPEN` names, so an end-to-end run can
 * skip the Open panel, which UI automation cannot reach. Always null in a
 * release build.
 */
export async function debugOpenDeck(): Promise<File | null> {
  const got = await invoke<[string, number[]] | null>('debug_open_deck')
  return got ? new File([new Uint8Array(got[1])], got[0]) : null
}

/** Small pieces are gathered to this size before crossing; big ones are cut to the next. */
const GATHER = 4 << 20
const SLICE = 32 << 20

/**
 * Save a file assembled from chunks, through the platform's own Save dialog.
 *
 * A web view's download link is a poor fit for a desktop app: it cannot ask
 * where, and a 2 GB deck is a lot to hand to it. The chunks — most of them
 * views into the deck already in memory — cross to Rust a slice at a time
 * and go into a temporary file beside the destination, which replaces it
 * only when the last one has arrived.
 *
 * Returns where the file went, or `null` if the user cancelled.
 */
export async function saveFile(
  parts: Uint8Array[],
  filename: string,
  filter: { name: string; ext: string },
): Promise<string | null> {
  const token = await invoke<string | null>('save_begin', {
    suggested: filename,
    filterName: filter.name,
    ext: filter.ext,
  })
  if (!token) return null
  const headers = { 'x-save-token': token }
  const send = (bytes: Uint8Array) => invoke<void>('save_chunk', bytes, { headers })
  try {
    let pending: Uint8Array[] = []
    let pendingLength = 0
    const flush = async () => {
      if (pendingLength === 0) return
      const joined = new Uint8Array(pendingLength)
      let at = 0
      for (const p of pending) joined.set(p, at), (at += p.length)
      pending = []
      pendingLength = 0
      await send(joined)
    }
    for (const part of parts) {
      if (part.length < GATHER) {
        pending.push(part)
        pendingLength += part.length
        if (pendingLength >= GATHER) await flush()
        continue
      }
      await flush()
      for (let at = 0; at < part.length; at += SLICE) await send(part.subarray(at, at + SLICE))
    }
    await flush()
    return await invoke<string>('save_finish', { token })
  } catch (e) {
    await invoke('save_abort', { token }).catch(() => {})
    throw e
  }
}
