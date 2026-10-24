import type { MediaScanResult, PlaybackSettings } from './media'
import { describeProbe, type Playback } from './mediaprobe'

/**
 * MEDIA.txt, and the words it is made of: which file goes with which slide,
 * and how PowerPoint played it. DOM-free like the rest of `core/`, so the
 * media panel here and the Advanced Exporter add-in write the same file.
 */

export const PLAY_LABEL: Record<Playback, string> = {
  yes: 'plays',
  extension: 'needs codec pack',
  no: 'will not play',
  unknown: 'check it',
}

export const VIA_LABEL: Record<string, string> = {
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

export function playbackText(p: PlaybackSettings): string[] {
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

export const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`

export function slideList(ns: number[]): string {
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

/**
 * MEDIA.txt for a set of saved files. `media` may be a filtered scan (only
 * some slides, say): every file and placement in it is listed, and nothing
 * else. `names` is what each part was saved as (mediaFilenames).
 */
export function mediaManifest(
  media: MediaScanResult,
  names: Map<string, string>,
  deckName: string,
  saved: Date = new Date(),
): string {
  const lines: string[] = [
    `Media from ${deckName}`,
    `Saved ${saved.toISOString().slice(0, 16).replace('T', ' ')}`,
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
