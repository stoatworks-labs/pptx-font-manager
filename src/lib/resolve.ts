import { parseFontName, resolveInstalled } from '../core/names'
import { findGoogleFamily, suggestGoogleFamilies, fetchGoogleFaces } from '../core/google'
import { findFontsourceFamily, fetchFontsourceFaces, type FontsourceMatch } from '../core/fontsource'
import { findSubstitutes, type SubstituteMatch } from '../core/substitutes'
import type { DeckFont, FetchedFace, FontStatus, GoogleMatch } from '../core/types'
import type { FontInventory } from '../platform/fontcheck'

export interface ResolvedFont extends FontStatus {
  /** Alternatives when the font is missing and not on Google Fonts. */
  suggestions: GoogleMatch[]
  /**
   * Fontsource match, for the ~120 open families Google Fonts does not carry.
   * Checked only when Google has nothing, since for anything Google does have
   * we prefer the original repo files over Fontsource's subsetted republish.
   */
  fontsource?: FontsourceMatch
  /**
   * Curated stand-ins for a font that cannot be redistributed — Carlito for
   * Calibri, Arimo for Arial. Set only when the font is missing and nothing
   * downloadable matches it directly, because an actual copy of the font the
   * deck asked for always beats a substitute.
   */
  substitutes?: SubstituteMatch
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

  // Source precedence, strongest first:
  //   1. Google Fonts   — the real font, original unsubsetted repo files
  //   2. Fontsource     — the real font, for families Google does not carry
  //   3. a substitute   — a different font that stands in for it
  // Only fall down a step when the one above has nothing to offer.
  const fontsource = !google?.downloadable ? findFontsourceFamily(parsed) : null

  const needsFallback = state === 'missing' && !google?.downloadable && !fontsource
  const substitutes = needsFallback ? findSubstitutes(parsed) : null

  return {
    font,
    state,
    method: inventory.method,
    matchedFamily,
    google: google ?? undefined,
    fontsource: fontsource ?? undefined,
    // A real font or a curated substitute both beat token-overlap guesswork,
    // so the fuzzy suggestions stand down when either exists.
    suggestions:
      state === 'missing' && !google && !fontsource && !substitutes ? suggestGoogleFamilies(parsed) : [],
    substitutes: substitutes ?? undefined,
  }
}

export function resolveAll(fonts: DeckFont[], inventory: FontInventory): ResolvedFont[] {
  return fonts.map((f) => resolveFont(f, inventory))
}

/** Where a real copy of this font can be fetched from, if anywhere. */
export interface DownloadPlan {
  family: string
  source: 'google' | 'fontsource'
  license: string
}

/**
 * The one place that decides which catalogue supplies a font.
 *
 * Callers should not branch on `r.google` / `r.fontsource` themselves — the
 * precedence rule lives here so the row button, the bulk install and the
 * bundle builder cannot drift apart.
 *
 * Substitutes are deliberately NOT part of this: they are a different typeface,
 * not a copy of what was asked for, and every caller treats them differently.
 */
export function downloadPlan(r: ResolvedFont): DownloadPlan | null {
  if (r.google?.downloadable) {
    return { family: r.google.family, source: 'google', license: r.google.license }
  }
  if (r.fontsource) {
    return { family: r.fontsource.family, source: 'fontsource', license: r.fontsource.license }
  }
  return null
}

/** Fetch faces for a plan, from whichever catalogue it names. */
export function fetchPlanFaces(
  plan: DownloadPlan,
  weight: number,
  italic: boolean,
  signal?: AbortSignal,
): Promise<FetchedFace[]> {
  const opts = { italics: italic, signal }
  return plan.source === 'google'
    ? fetchGoogleFaces(plan.family, [weight], opts)
    : fetchFontsourceFaces(plan.family, [weight], opts)
}

export interface ResolveSummary {
  total: number
  installed: number
  familyOnly: number
  missing: number
  embedded: number
  /** Missing fonts that Google Fonts can supply as the real thing. */
  fixable: number
  /** Missing fonts with no real copy available, but a curated stand-in. */
  substitutable: number
  /**
   * Of those, the ones whose stand-in preserves the deck's line breaks.
   * Reported separately because the rest will reflow the deck, and a summary
   * that hides that difference is telling the user the deck is safe when it
   * is not.
   */
  metricSubstitutable: number
}

export function summarize(resolved: ResolvedFont[]): ResolveSummary {
  const s: ResolveSummary = {
    total: resolved.length,
    installed: 0,
    familyOnly: 0,
    missing: 0,
    embedded: 0,
    fixable: 0,
    substitutable: 0,
    metricSubstitutable: 0,
  }
  for (const r of resolved) {
    if (r.state === 'installed') s.installed++
    else if (r.state === 'family-installed') s.familyOnly++
    else if (r.state === 'embedded') s.embedded++
    else {
      s.missing++
      if (r.google?.downloadable || r.fontsource) s.fixable++
      else if (r.substitutes) {
        s.substitutable++
        if (r.substitutes.hasMetric) s.metricSubstitutable++
      }
    }
  }
  return s
}
