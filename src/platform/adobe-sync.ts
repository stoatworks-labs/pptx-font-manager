/**
 * Telling a Creative Cloud-synced font from an OS-bundled one, by where its
 * file lives.
 *
 * ## Why this exists
 *
 * `src/core/adobe.ts` can say a family is in the Adobe Fonts catalogue. That is
 * not enough to warn anybody, because **Adobe Fonts resells the Microsoft
 * system fonts** — Monotype lists Calibri, Times New Roman, Courier New, Segoe
 * UI and Wingdings there as genuine entries. Flagging on a catalogue hit alone
 * told users that Times New Roman "cannot travel with the deck", which is
 * nonsense for a font that ships with both Windows and macOS. See AGENTS.md §11.
 *
 * The warning that had to be dropped is the valuable one: a genuinely
 * Adobe-only face like Proxima Nova, synced by Creative Cloud, is present on
 * the authoring machine and absent at the venue. It registers with the OS like
 * any other font, so the deck looks perfect to its author and breaks on the day.
 *
 * The file path separates the two. A synced face is not in the font directory
 * at all — Creative Cloud writes it into its own store under an obfuscated
 * name:
 *
 *   macOS    ~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/
 *   Windows  %APPDATA%\Adobe\CoreSync\plugins\livetype\r\
 *
 * Times New Roman is never in there. Proxima Nova, on a machine that has it
 * activated, is only in there.
 *
 * ## Why the rule is written this way
 *
 * Matching the four-directory sequence rather than a whole-path prefix:
 *
 *   - the leaf differs by platform — `.r` on macOS, `r` on Windows — and a bare
 *     `r` on its own is far too generic to key on;
 *   - building the expected prefix from `$HOME`/`%APPDATA%` misses a symlinked
 *     or relocated home, and both platforms' filesystems are case-insensitive
 *     by default, so a literal `startsWith` comparison is wrong twice over;
 *   - four consecutive components cannot collide with a font someone happened
 *     to file under a folder called `livetype`.
 *
 * ## Where it runs
 *
 * Here, and only here. The Rust side (`src-tauri/src/fonts.rs`) reports paths
 * and deliberately does not interpret them, so there is one definition of a
 * synced path rather than two that can drift apart.
 *
 * Desktop only, unavoidably: `queryLocalFonts()` hands the browser a `blob()`
 * and never a path, so the web build cannot make this distinction at all. A
 * `false` from here therefore means "not known to be synced", never "proven
 * local" — which is the safe direction, since it only ever suppresses a
 * warning.
 */

/** The directory chain Creative Cloud syncs desktop faces into, lowercased. */
const SYNC_DIR_CHAIN = ['adobe', 'coresync', 'plugins', 'livetype']

/** Was this font file put here by Creative Cloud rather than by the OS? */
export function isAdobeSyncPath(path: string | null | undefined): boolean {
  if (!path) return false
  const parts = path
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase())

  for (let i = 0; i + SYNC_DIR_CHAIN.length <= parts.length; i++) {
    if (SYNC_DIR_CHAIN.every((seg, j) => parts[i + j] === seg)) return true
  }
  return false
}

/** A font file on this machine, as reported by the desktop shell. */
export interface FontFileRef {
  family: string
  path: string | null
}

/**
 * Which of these families exist on this machine **only** because Creative
 * Cloud syncs them.
 *
 * Note the "only". A family with a CoreSync file *and* an ordinary one is not
 * a travel risk: the venue has its own copy of whatever the system supplies.
 * That combination is not hypothetical — Adobe Fonts resells the Microsoft
 * system fonts, so a subscriber can activate Times New Roman and end up with
 * both. Warning on "has a synced file" would put the §2.2 false alarm straight
 * back: "Times New Roman will not be at the venue" is nonsense.
 *
 * A face with no path at all is not evidence either way and is ignored, rather
 * than counted as a local copy that would silence a real warning.
 *
 * This answers "will the deck break elsewhere". It is deliberately NOT the
 * test for whether a particular file may be copied into a bundle — that one is
 * per file, `isAdobeSyncPath`, because the synced file in a mixed family may
 * not travel even though the family as a whole is safe.
 */
export function adobeSyncedFamilies(files: Iterable<FontFileRef>): Set<string> {
  const synced = new Set<string>()
  const alsoLocal = new Set<string>()
  for (const f of files) {
    if (!f.path) continue
    if (isAdobeSyncPath(f.path)) synced.add(f.family)
    else alsoLocal.add(f.family)
  }
  for (const family of alsoLocal) synced.delete(family)
  return synced
}
