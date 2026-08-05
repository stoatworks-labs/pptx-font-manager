import type { FontInventory } from './fontcheck'

/**
 * The desktop half of the platform layer.
 *
 * This is the whole point of the desktop port. A browser can tell you a font
 * is missing and hand you a zip to run somewhere; it cannot write into the
 * font directory. Everything here is what the web app structurally cannot do:
 *
 *   - enumerate installed fonts through the OS's own registry rather than by
 *     measuring text widths;
 *   - read the bytes of a font the user already has, so it can go in a bundle
 *     without asking for a permission prompt;
 *   - install a font, which is the feature people actually want.
 *
 * `src/core/` is shared verbatim with the web build. Only this file and the
 * factory in `index.ts` differ.
 */

import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * True when running inside the Tauri shell rather than a browser tab.
 *
 * Uses the API package rather than sniffing `window.__TAURI__`: that global
 * only exists when `withGlobalTauri` is set in tauri.conf.json, which it is
 * not. Checking for it silently reports every desktop launch as a browser —
 * the app runs, looks right, and quietly loses the one feature it was built
 * for.
 */
export function isDesktop(): boolean {
  return isTauri()
}

interface InventoryDto {
  families: string[]
  faces: string[]
}

/**
 * Ask the OS what is installed.
 *
 * `wanted` is passed through because face names are resolved lazily on the
 * Rust side — loading the name table of all 11,000-odd installed fonts to
 * answer a question about five of them takes seconds. Families come back in
 * full; faces only for the families the deck actually mentions.
 */
export async function nativeInventory(wanted: string[]): Promise<FontInventory> {
  const dto = await invoke<InventoryDto>('font_inventory', { wanted })
  return {
    method: 'native',
    families: new Set(dto.families),
    faces: new Set(dto.faces),
  }
}

export function fontInstallDir(): Promise<string> {
  return invoke<string>('font_install_dir')
}

export interface InstallOutcome {
  filename: string
  status: 'installed' | 'already-present' | 'failed'
  detail: string | null
  path: string | null
}

export interface InstallReport {
  dir: string
  installed: number
  skipped: number
  failed: number
  outcomes: InstallOutcome[]
  note: string | null
}

/**
 * Install font files into the per-user font directory.
 *
 * The Rust side re-validates everything: filenames must be plain font
 * filenames that cannot escape the directory, and the bytes must start with a
 * real sfnt signature. That last check is not paranoia — a failed download
 * returns an HTML error page, and writing that into the font directory is how
 * you get a font manager that corrupts a font book.
 */
export async function installFonts(
  files: Array<{ filename: string; data: Uint8Array }>,
): Promise<InstallReport> {
  return invoke<InstallReport>('install_fonts', {
    files: files.map((f) => ({ filename: f.filename, data: Array.from(f.data) })),
  })
}

export interface LocalFontFile {
  filename: string
  size: number
}

export function listInstalledFontFiles(family: string): Promise<LocalFontFile[]> {
  return invoke<LocalFontFile[]>('list_installed_font_files', { family })
}

/**
 * Read one file backing an installed family.
 *
 * Returned as an ArrayBuffer over the raw IPC response rather than as JSON —
 * a 160 kB font serialised as a JSON array of numbers is roughly 700 kB of
 * text, which is a silly way to move a file a few hundred microseconds.
 */
export async function readInstalledFontFile(family: string, index: number): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer | number[]>('read_installed_font_file', { family, index })
  return buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf)
}
