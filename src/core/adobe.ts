import catalogue from '../data/adobe-fonts.json'
import { normalizeKey, type ParsedFontName } from './names'

/**
 * Adobe Fonts recognition. **Identify-only — nothing here can be downloaded.**
 *
 * ## Why there is no download path, and why signing in would not create one
 *
 * Two independent blockers, either decisive alone:
 *
 * 1. **No font-file endpoint exists.** The Typekit/Adobe Fonts API is still
 *    live (typekit.com/api/v1 answers 401, not 404) but does kit management and
 *    metadata only. Desktop faces reach a machine solely via Creative Cloud
 *    sync, into an obfuscated CoreSync directory.
 * 2. **The licence forbids this app's whole workflow.** Adobe's documentation
 *    states the fonts "are not compatible with packaging workflows that involve
 *    transferring font files to another user or computer". A sidecar .zip
 *    handed to a venue is precisely that.
 *
 * So an Adobe font can never enter a bundle, and this module never tries. What
 * it does instead is let the app name the most dangerous situation the scanner
 * meets: **a deck that works perfectly for its author and breaks everywhere
 * else.** Adobe fonts synced by Creative Cloud register with the OS like any
 * other font, so the installed-check reports them present — on the authoring
 * machine. The venue has neither the font nor, necessarily, a subscription.
 *
 * ## This module may only assert positives
 *
 * The public feed cannot be fully enumerated: page size is fixed at 12 and it
 * hard-caps at page 200, so the plain feed reaches 2,400 of 5,369. Facet slices
 * widen that but do not close it — see scripts/build-adobe-catalogue.mjs.
 *
 * A name that is not in the catalogue therefore means **unknown**, not "not an
 * Adobe font". `isAdobeFont` returning null must stay silent in the UI. Do not
 * add a `definitelyNotAdobe` helper; the data cannot support one.
 */

interface RawFamily {
  n: string
  s: string
  y: string
  o: number
}

const FAMILIES = (catalogue as { families: RawFamily[] }).families
export const ADOBE_DATE = (catalogue as { generated: string }).generated
export const ADOBE_COUNT = FAMILIES.length
/** What Adobe says the library holds, so the coverage gap stays visible. */
export const ADOBE_LIBRARY_TOTAL = (catalogue as { libraryTotal?: number }).libraryTotal ?? 0

const BY_KEY = new Map<string, RawFamily>()
for (const f of FAMILIES) BY_KEY.set(normalizeKey(f.n), f)

export interface AdobeMatch {
  family: string
  /** Deep link to the family page, where a subscriber activates it. */
  url: string
  /** Foundry, which disambiguates same-named revivals. */
  foundry?: string
  /**
   * Adobe also publishes an open-source cut of this family. Worth checking the
   * Google/Fontsource catalogues before telling anyone to activate anything —
   * Source Sans and friends are on Google Fonts under OFL.
   */
  hasOpenSourceCut: boolean
}

/**
 * Is this an Adobe Fonts family?
 *
 * `null` means **unknown**, never "no" — see the note above. Callers must not
 * present a null as evidence of anything.
 */
export function findAdobeFamily(parsed: ParsedFontName): AdobeMatch | null {
  const rec = BY_KEY.get(normalizeKey(parsed.family)) ?? BY_KEY.get(normalizeKey(parsed.raw))
  if (!rec) return null
  return {
    family: rec.n,
    url: `https://fonts.adobe.com/fonts/${rec.s}`,
    foundry: rec.y || undefined,
    hasOpenSourceCut: rec.o === 1,
  }
}

/**
 * The line that goes in the bundle README for an Adobe font.
 *
 * Deliberately explains *why* no file is included. "Adobe font, not included"
 * reads like a bug; "the licence does not permit putting it in this zip, here
 * is where to activate it" is actionable.
 */
export function adobeBundleNote(match: AdobeMatch): string {
  return (
    `${match.family} is an Adobe Font. Its licence does not permit including the ` +
    `font file here — Adobe fonts activate through a Creative Cloud subscription ` +
    `rather than travelling with a deck. Anyone with a subscription can activate ` +
    `it at ${match.url}`
  )
}
