import { parseFontName, resolveInstalled } from '../core/names'
import { findGoogleFamily, suggestGoogleFamilies } from '../core/google'
import type { DeckFont, FontStatus, GoogleMatch } from '../core/types'
import type { FontInventory } from '../platform/fontcheck'

export interface ResolvedFont extends FontStatus {
  /** Alternatives when the font is missing and not on Google Fonts. */
  suggestions: GoogleMatch[]
}

/**
 * Decide, for one deck font, whether it is installed and what can be done
 * about it.
 *
 * Order matters: an embedded font is reported as embedded regardless of
 * whether it is also installed, because the deck renders correctly either way
 * and telling the user to install something they do not need is noise.
 */
export function resolveFont(font: DeckFont, inventory: FontInventory): ResolvedFont {
  const parsed = parseFontName(font.name)
  const google = findGoogleFamily(parsed)

  if (font.embedded) {
    return {
      font,
      state: 'embedded',
      method: inventory.method,
      google: google ?? undefined,
      suggestions: [],
    }
  }

  let state: FontStatus['state']
  let matchedFamily: string | undefined

  if (inventory.probe) {
    // Canvas probing cannot enumerate, so ask about both the full name and the
    // bare family. A hit on the full name is a genuine face match; a hit on
    // only the family means the weight may substitute.
    const rawHit = inventory.probe(parsed.raw)
    const familyHit = rawHit || inventory.probe(parsed.family)
    if (rawHit) {
      state = 'installed'
      matchedFamily = parsed.family
    } else if (familyHit) {
      state = parsed.weight === 400 && !parsed.italic ? 'installed' : 'family-installed'
      matchedFamily = parsed.family
    } else {
      state = 'missing'
    }
  } else {
    const r = resolveInstalled(parsed, inventory.families, inventory.faces)
    state = r.state
    matchedFamily = r.matchedFamily
  }

  return {
    font,
    state,
    method: inventory.method,
    matchedFamily,
    google: google ?? undefined,
    suggestions: state === 'missing' && !google ? suggestGoogleFamilies(parsed) : [],
  }
}

export function resolveAll(fonts: DeckFont[], inventory: FontInventory): ResolvedFont[] {
  return fonts.map((f) => resolveFont(f, inventory))
}

export interface ResolveSummary {
  total: number
  installed: number
  familyOnly: number
  missing: number
  embedded: number
  /** Missing fonts that Google Fonts can supply. */
  fixable: number
}

export function summarize(resolved: ResolvedFont[]): ResolveSummary {
  const s: ResolveSummary = {
    total: resolved.length,
    installed: 0,
    familyOnly: 0,
    missing: 0,
    embedded: 0,
    fixable: 0,
  }
  for (const r of resolved) {
    if (r.state === 'installed') s.installed++
    else if (r.state === 'family-installed') s.familyOnly++
    else if (r.state === 'embedded') s.embedded++
    else {
      s.missing++
      if (r.google?.downloadable) s.fixable++
    }
  }
  return s
}
