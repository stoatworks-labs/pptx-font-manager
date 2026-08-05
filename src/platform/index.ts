import { defaultInventory, type FontInventory } from './fontcheck'
import { isDesktop, nativeInventory } from './native'

export { isDesktop } from './native'
export { hasLocalFontAccess, queryLocalFontInventory } from './fontcheck'
export type { FontInventory } from './fontcheck'

/**
 * Pick the best font inventory this build can get.
 *
 *   desktop  native      — the OS font registry. Exact, no permission prompt,
 *                          and the only one that can also install.
 *   browser  canvas      — text-width probing. Accurate for "is it installed",
 *                          cannot enumerate or read files. No prompt.
 *            local-font-access — upgraded to on request, from a click.
 *
 * `wanted` matters only on desktop: face names are resolved lazily there, so
 * the Rust side needs to know which families to look inside.
 */
export async function bestInventory(wanted: string[]): Promise<FontInventory> {
  if (isDesktop()) {
    try {
      return await nativeInventory(wanted)
    } catch {
      // Fall through to the browser path rather than showing nothing. A
      // desktop build with a broken command is still a working scanner.
    }
  }
  return defaultInventory()
}
