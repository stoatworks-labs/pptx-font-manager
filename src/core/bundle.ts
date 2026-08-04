import { zipSync, strToU8 } from 'fflate'
import {
  MACOS_INSTALLER,
  WINDOWS_CMD,
  WINDOWS_PS1,
  LINUX_INSTALLER,
  readmeText,
} from './installers'
import type { DeckFont, GoogleMatch } from './types'

/**
 * Build the sidecar .zip.
 *
 * Layout:
 *   fonts/                    the font files themselves
 *   install-fonts.command     macOS
 *   install-fonts.cmd         Windows  (run this)
 *   install-fonts.ps1         Windows  (called by the .cmd)
 *   install-fonts.sh          Linux
 *   README.txt                how to run them, and the two Gatekeeper/MOTW traps
 *   MANIFEST.txt              per-font provenance and licence
 *
 * Licence handling follows the "include everything, warn loudly" policy: a
 * font the user already has locally goes in the bundle whatever its licence,
 * but the manifest marks it RESTRICTED and the README says not to pass it on.
 * That keeps the tool useful for the common case — moving a deck between your
 * own machines — without pretending a foundry font is free to hand around.
 */

export type FontSource = 'google' | 'embedded' | 'local'

export interface BundleEntry {
  /** Filename inside fonts/. */
  filename: string
  data: Uint8Array
  /** Font family this file belongs to. */
  family: string
  source: FontSource
  /** SPDX id where known, else a human note. */
  license: string
  /** True when the licence permits redistribution. */
  redistributable: boolean
  /** Where it came from, for the manifest. */
  provenance: string
}

export interface BundleReport {
  deckName: string
  entries: BundleEntry[]
  /** Fonts that were wanted but could not be included, with the reason. */
  unavailable: Array<{ name: string; reason: string }>
}

const UNIX_MODE = 0o755 << 16
const FILE_MODE = 0o644 << 16

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim() || 'bundle'
}

function manifestText(report: BundleReport, generated: string): string {
  const lines: string[] = []
  lines.push(`FONT MANIFEST — ${report.deckName}`)
  lines.push(`Generated ${generated} by PowerPoint Font Manager`)
  lines.push('')

  const restricted = report.entries.filter((e) => !e.redistributable)
  const free = report.entries.filter((e) => e.redistributable)

  lines.push(`${report.entries.length} font file(s) included.`)
  lines.push('')

  if (free.length > 0) {
    lines.push('─'.repeat(72))
    lines.push('FREE TO REDISTRIBUTE')
    lines.push('─'.repeat(72))
    lines.push('These carry licences that permit sharing this bundle onward.')
    lines.push('')
    for (const e of free) {
      lines.push(`  ${e.filename}`)
      lines.push(`      family:     ${e.family}`)
      lines.push(`      licence:    ${e.license}`)
      lines.push(`      source:     ${e.provenance}`)
      lines.push('')
    }
  }

  if (restricted.length > 0) {
    lines.push('─'.repeat(72))
    lines.push('*** RESTRICTED — DO NOT REDISTRIBUTE ***')
    lines.push('─'.repeat(72))
    lines.push('These were taken from a machine that already had them installed, or')
    lines.push('extracted from the presentation itself. They are here so YOU can move')
    lines.push('this deck between YOUR OWN machines where you already hold a licence.')
    lines.push('')
    lines.push('Sending this bundle to someone who does not already hold a licence for')
    lines.push('these fonts is very likely a breach of their terms. Font licences')
    lines.push('almost never permit redistribution, and permission to EMBED a font in')
    lines.push('a document is not permission to extract and install it elsewhere.')
    lines.push('')
    for (const e of restricted) {
      lines.push(`  ${e.filename}`)
      lines.push(`      family:     ${e.family}`)
      lines.push(`      licence:    ${e.license}`)
      lines.push(`      source:     ${e.provenance}`)
      lines.push('')
    }
  }

  if (report.unavailable.length > 0) {
    lines.push('─'.repeat(72))
    lines.push('NOT INCLUDED')
    lines.push('─'.repeat(72))
    for (const u of report.unavailable) {
      lines.push(`  ${u.name}`)
      lines.push(`      ${u.reason}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Assemble the zip. Returns the bytes; the caller triggers the download.
 *
 * Installer scripts get mode 0755 in the zip so they survive a round-trip
 * through `unzip` on macOS and Linux as executable. macOS Archive Utility
 * honours this; Windows ignores modes entirely, which is fine because the
 * .cmd does not need one.
 */
export function buildBundle(report: BundleReport, generated = new Date().toISOString().slice(0, 10)): Uint8Array {
  const files: Record<string, [Uint8Array, { attrs?: number }] | Uint8Array> = {}

  const used = new Set<string>()
  for (const entry of report.entries) {
    let name = entry.filename
    // Two families can ship a file of the same name; keep both.
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.')
      const stem = dot === -1 ? name : name.slice(0, dot)
      const ext = dot === -1 ? '' : name.slice(dot)
      let i = 2
      while (used.has(`${stem}-${i}${ext}`.toLowerCase())) i++
      name = `${stem}-${i}${ext}`
    }
    used.add(name.toLowerCase())
    files[`fonts/${name}`] = [entry.data, { attrs: FILE_MODE }]
  }

  files['install-fonts.command'] = [strToU8(MACOS_INSTALLER), { attrs: UNIX_MODE }]
  files['install-fonts.sh'] = [strToU8(LINUX_INSTALLER), { attrs: UNIX_MODE }]
  files['install-fonts.cmd'] = [strToU8(WINDOWS_CMD.replace(/\n/g, '\r\n')), { attrs: FILE_MODE }]
  files['install-fonts.ps1'] = [strToU8(WINDOWS_PS1.replace(/\n/g, '\r\n')), { attrs: FILE_MODE }]
  files['README.txt'] = [strToU8(readmeText(report.deckName, generated)), { attrs: FILE_MODE }]
  files['MANIFEST.txt'] = [strToU8(manifestText(report, generated)), { attrs: FILE_MODE }]

  return zipSync(files as Parameters<typeof zipSync>[0], { level: 6 })
}

export function bundleFilename(deckName: string): string {
  const base = sanitizeName(deckName.replace(/\.pptx?$/i, ''))
  return `${base} — fonts.zip`
}

/** Licence line for a font we found installed locally rather than on Google. */
export function localLicenseNote(font: DeckFont, google: GoogleMatch | null): {
  license: string
  redistributable: boolean
} {
  if (google && google.license && google.license !== 'Unknown') {
    return { license: google.license, redistributable: true }
  }
  void font
  return {
    license: 'Proprietary / unknown — check the foundry terms',
    redistributable: false,
  }
}
