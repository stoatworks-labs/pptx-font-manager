import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { scanPptx } from './core/scan'
import { fetchGoogleFaces, CATALOGUE_COUNT, CATALOGUE_DATE } from './core/google'
import { FONTSOURCE_COUNT } from './core/fontsource'
import { adobeBundleNote, adobeSyncBundleNote } from './core/adobe'
import { buildBundle, bundleFilename, localLicenseNote, type BundleEntry } from './core/bundle'
import {
  downloadPlan,
  fetchPlanFaces,
  resolveAll,
  summarize,
  type ResolvedFont,
} from './lib/resolve'
import {
  bestInventory,
  hasLocalFontAccess,
  isDesktop,
  queryLocalFontInventory,
  type FontInventory,
} from './platform'
import { defaultInventory } from './platform/fontcheck'
import {
  fontInstallDir,
  installFonts,
  isAdobeSyncFile,
  listInstalledFontFiles,
  readInstalledFontFile,
  type InstallReport,
} from './platform/native'
import type { ScanResult } from './core/types'

declare const __APP_VERSION__: string

const TIER_LABEL: Record<string, string> = {
  slide: 'on a slide',
  inherited: 'layout / theme',
  elsewhere: 'notes / unused layout',
}

function download(data: Uint8Array, filename: string) {
  const copy = new Uint8Array(data.length)
  copy.set(data)
  const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export default function App() {
  const desktop = isDesktop()

  const [deckName, setDeckName] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [inventory, setInventory] = useState<FontInventory>(() => defaultInventory())
  const [installDir, setInstallDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [report, setReport] = useState<InstallReport | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!desktop) return
    fontInstallDir().then(setInstallDir).catch(() => setInstallDir(null))
  }, [desktop])

  /**
   * Rebuild the inventory whenever the deck changes.
   *
   * The native path resolves face names lazily, so it needs to know which
   * families to look inside — which means it cannot be built until there is a
   * scan to ask about.
   */
  const refreshInventory = useCallback(async (result: ScanResult) => {
    const wanted = result.fonts.flatMap((f) => [f.name, f.family])
    setInventory(await bestInventory(wanted))
  }, [])

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setScan(null)
      setReport(null)
      setBusy('Reading presentation…')
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        const result = scanPptx(buf)
        setDeckName(file.name)
        setScan(result)
        await refreshInventory(result)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [refreshInventory],
  )

  const resolved: ResolvedFont[] = useMemo(
    () => (scan ? resolveAll(scan.fonts, inventory) : []),
    [scan, inventory],
  )
  const summary = useMemo(() => summarize(resolved), [resolved])
  const visible = useMemo(
    () => (showAll ? resolved : resolved.filter((r) => r.font.tier !== 'elsewhere')),
    [resolved, showAll],
  )
  const hiddenCount = resolved.length - visible.length
  const installable = useMemo(
    () => resolved.filter((r) => r.state === 'missing' && downloadPlan(r)),
    [resolved],
  )

  const upgradeInventory = useCallback(async () => {
    setError(null)
    try {
      setInventory(await queryLocalFontInventory())
    } catch (e) {
      const msg = (e as Error).message
      setError(
        /denied|dismiss/i.test(msg)
          ? 'Permission declined — still using width-measurement detection, which works but cannot read font files for the bundle.'
          : `Could not read the local font list: ${msg}`,
      )
    }
  }, [])

  /** Desktop: download and install, in one step. */
  const install = useCallback(
    async (targets: ResolvedFont[]) => {
      if (targets.length === 0) return
      setError(null)
      setReport(null)
      const files: Array<{ filename: string; data: Uint8Array }> = []
      try {
        for (const r of targets) {
          const plan = downloadPlan(r)
          if (!plan) continue
          setBusy(`Downloading ${plan.family}…`)
          const faces = await fetchPlanFaces(plan, r.font.weight, r.font.italic)
          for (const f of faces) files.push({ filename: f.filename, data: f.data })
        }
        if (files.length === 0) {
          setError('Nothing to install — no downloadable font was found for those.')
          return
        }
        setBusy(`Installing ${files.length} font file${files.length === 1 ? '' : 's'}…`)
        const result = await installFonts(files)
        setReport(result)
        // Re-check what is installed so the list reflects reality.
        if (scan) await refreshInventory(scan)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [scan, refreshInventory],
  )

  /** Browser: download the font files for the user to install themselves. */
  const getOne = useCallback(async (r: ResolvedFont) => {
    const plan = downloadPlan(r)
    if (!plan) return
    setBusy(`Downloading ${plan.family}…`)
    setError(null)
    try {
      const faces = await fetchPlanFaces(plan, r.font.weight, r.font.italic)
      for (const f of faces) download(f.data, f.filename)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  /**
   * Fetch a curated stand-in — Carlito for Calibri, Arimo for Arial.
   *
   * Deliberately per-row and never part of the bulk "install missing fonts"
   * action: a substitute is a *different typeface*, and swapping one in without
   * the user picking it is not a decision this app gets to make silently.
   */
  const useSubstitute = useCallback(
    async (r: ResolvedFont, family: string) => {
      setError(null)
      setReport(null)
      setBusy(`${desktop ? 'Installing' : 'Downloading'} ${family}…`)
      try {
        const faces = await fetchGoogleFaces(family, [r.font.weight], { italics: r.font.italic })
        if (desktop) {
          const result = await installFonts(faces.map((f) => ({ filename: f.filename, data: f.data })))
          setReport(result)
          if (scan) await refreshInventory(scan)
        } else {
          for (const f of faces) download(f.data, f.filename)
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [desktop, scan, refreshInventory],
  )

  const makeBundle = useCallback(async () => {
    if (!scan) return
    setBusy('Building bundle…')
    setError(null)
    setReport(null)
    const entries: BundleEntry[] = []
    const unavailable: Array<{ name: string; reason: string }> = []

    try {
      for (const r of resolved) {
        const font = r.font

        if (font.embedded?.extracted?.length) {
          for (const face of font.embedded.extracted) {
            entries.push({
              filename: face.filename,
              data: face.data,
              family: font.family,
              source: 'embedded',
              license: 'Embedded in the presentation — terms unknown',
              redistributable: false,
              provenance: `extracted from ${face.part}`,
            })
          }
          continue
        }
        if (font.embedded) {
          unavailable.push({
            name: font.name,
            reason:
              'Embedded in the presentation, but the data is MicroType Express compressed ' +
              '(PowerPoint’s own format) and cannot be unpacked into an installable file. ' +
              'It travels with the deck, so it will render wherever the .pptx goes.',
          })
          continue
        }

        const plan = downloadPlan(r)
        if (plan) {
          setBusy(`Fetching ${plan.family}…`)
          try {
            const faces = await fetchPlanFaces(plan, font.weight, font.italic)
            const label = plan.source === 'google' ? 'Google Fonts' : 'Fontsource'
            for (const f of faces) {
              entries.push({
                filename: f.filename,
                data: f.data,
                family: f.family,
                source: plan.source,
                license: f.license,
                redistributable: true,
                provenance: `${label} (${f.license})${f.variable ? ', variable font' : ''}`,
              })
            }
            continue
          } catch (e) {
            unavailable.push({ name: font.name, reason: (e as Error).message })
            continue
          }
        }

        // A Creative Cloud-synced font is on this machine and may not leave
        // it. This has to come BEFORE the read-it-off-this-machine branch
        // below, which would otherwise happily copy the CoreSync file into the
        // zip — the exact transfer Adobe's licence forbids, and the one thing
        // the row is at that moment warning the user about.
        //
        // Keyed on the file path, not on `r.adobe`: the path is proof, while
        // the catalogue is knowingly incomplete and may not know the name.
        if (r.installedViaAdobeSync) {
          unavailable.push({
            name: font.name,
            reason: r.adobe ? adobeBundleNote(r.adobe) : adobeSyncBundleNote(font.family),
          })
          continue
        }

        // Read it off this machine. Desktop does this without a prompt;
        // the browser needs Local Font Access to have been granted.
        const family = r.matchedFamily ?? font.family
        const note = localLicenseNote(font, r.google ?? null)

        if (desktop && r.state !== 'missing') {
          setBusy(`Reading ${family} from this machine…`)
          try {
            const list = await listInstalledFontFiles(family)
            let added = 0
            for (let i = 0; i < list.length; i++) {
              // A family can hold both an OS file and a Creative Cloud-synced
              // one — Adobe Fonts resells the Microsoft system fonts, so a
              // subscriber can end up with two Times New Romans. The family is
              // safe to bundle, but *that file* is not: copying it to another
              // machine is the transfer Adobe's licence forbids.
              if (isAdobeSyncFile(list[i]!)) continue
              const data = await readInstalledFontFile(family, i)
              entries.push({
                filename: list[i]!.filename,
                data,
                family: font.family,
                source: 'local',
                license: note.license,
                redistributable: note.redistributable,
                provenance: `copied from this machine (${list[i]!.filename})`,
              })
              added++
            }
            if (added > 0) continue
          } catch {
            /* fall through to the unavailable list */
          }
        }

        const records = inventory.records
        if (records) {
          const wanted = family.toLowerCase()
          const hits = records.filter((rec) => rec.family?.toLowerCase() === wanted)
          if (hits.length > 0 && hits[0]!.blob) {
            setBusy(`Reading ${family} from your system…`)
            let added = 0
            for (const hit of hits) {
              try {
                const blob = await hit.blob!()
                const data = new Uint8Array(await blob.arrayBuffer())
                entries.push({
                  filename: `${hit.postscriptName || hit.fullName || font.family}.ttf`,
                  data,
                  family: font.family,
                  source: 'local',
                  license: note.license,
                  redistributable: note.redistributable,
                  provenance: `copied from this machine (${hit.fullName || hit.postscriptName})`,
                })
                added++
              } catch {
                /* some system fonts refuse blob access */
              }
            }
            if (added > 0) continue
          }
        }

        // Last resort before giving up: a redistributable stand-in. This is
        // the only branch that can put something usable in the bundle for
        // Calibri, Arial and the rest of the system fonts, which are exactly
        // the fonts a venue machine is most likely to be missing too.
        const best = r.substitutes?.substitutes[0]
        if (best) {
          setBusy(`Fetching ${best.family}…`)
          try {
            const faces = await fetchGoogleFaces(best.family, [font.weight], {
              italics: font.italic,
            })
            for (const f of faces) {
              entries.push({
                filename: f.filename,
                data: f.data,
                family: f.family,
                source: 'substitute',
                license: f.license,
                redistributable: true,
                provenance: `Google Fonts (${f.license}), as a stand-in for ${r.substitutes!.target}`,
                substituteFor: { target: r.substitutes!.target, metric: best.metric },
              })
            }
            continue
          } catch {
            /* fall through to the unavailable list */
          }
        }

        // An Adobe font has a specific, actionable reason for its absence.
        // "Not on Google Fonts" would be true but useless — it implies we
        // simply failed to find it, when in fact it may not legally be here.
        if (r.adobe) {
          unavailable.push({ name: font.name, reason: adobeBundleNote(r.adobe) })
          continue
        }

        unavailable.push({
          name: font.name,
          reason: desktop
            ? 'Not on Google Fonts, and no readable font file for it was found on this machine.'
            : hasLocalFontAccess()
              ? inventory.records
                ? 'Not on Google Fonts, and the font file could not be read from this machine.'
                : 'Not on Google Fonts. Grant local font access to include fonts you already have.'
              : 'Not on Google Fonts, and this browser cannot read local font files. ' +
                'Open in Chrome or Edge, or use the desktop app, to include fonts already installed here.',
        })
      }

      if (entries.length === 0) {
        setError(
          'Nothing could be bundled — every font is either already everywhere, ' +
            'unavailable, or locked inside the deck. See the list for details.',
        )
        return
      }

      download(buildBundle({ deckName, entries, unavailable }), bundleFilename(deckName))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [scan, resolved, inventory, deckName, desktop])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setOver(false)
      const f = e.dataTransfer.files[0]
      if (f) void handleFile(f)
    },
    [handleFile],
  )

  return (
    <>
      <h1>PowerPoint Font Manager</h1>
      <p className="sub">
        Find the fonts a deck actually uses, check which are installed here, and{' '}
        {desktop ? 'install the ones that are missing' : 'build a sidecar bundle for the machine that needs them'}.
        {!desktop && ' The file never leaves your browser.'}
      </p>

      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click()
        }}
      >
        <strong>{deckName || 'Drop a .pptx here'}</strong>
        <span>
          {deckName ? 'Drop another to replace it' : 'or click to choose — .pptx, .potx, .ppsx'}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".pptx,.potx,.ppsx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
          }}
        />
      </div>

      {busy && (
        <p className="note info" style={{ marginTop: 16 }}>
          <span className="spin" />
          {busy}
        </p>
      )}

      {error && (
        <p className="note bad" style={{ marginTop: 16 }}>
          {error}
        </p>
      )}

      {report && <InstallSummary report={report} />}

      {scan && (
        <>
          <div className="summary">
            <div className="stat">
              <div className="n">{summary.total}</div>
              <div className="l">fonts used</div>
            </div>
            <div className="stat ok">
              <div className="n">{summary.installed}</div>
              <div className="l">installed here</div>
            </div>
            {summary.familyOnly > 0 && (
              <div className="stat warn">
                <div className="n">{summary.familyOnly}</div>
                <div className="l">family only</div>
              </div>
            )}
            <div className="stat bad">
              <div className="n">{summary.missing}</div>
              <div className="l">missing</div>
            </div>
            {summary.embedded > 0 && (
              <div className="stat info">
                <div className="n">{summary.embedded}</div>
                <div className="l">embedded in deck</div>
              </div>
            )}
          </div>

          {!desktop && inventory.method === 'canvas-metrics' && hasLocalFontAccess() && (
            <div className="note info">
              Detecting fonts by measuring text width — accurate, but it cannot read font files.{' '}
              <strong>Grant access to your font list</strong> to include fonts you already have in
              the bundle.
              <br />
              <button onClick={() => void upgradeInventory()}>Allow font access</button>
            </div>
          )}

          {!desktop && inventory.method === 'canvas-metrics' && !hasLocalFontAccess() && (
            <div className="note info">
              This browser has no Local Font Access API, so fonts are detected by measuring text
              width. That is reliable for checking what is installed, but fonts you already own
              cannot be read into a bundle. Chrome, Edge, or the desktop app can do both.
            </div>
          )}

          <div className="bar">
            {desktop && installable.length > 0 && (
              <button
                className="primary"
                onClick={() => void install(installable)}
                disabled={!!busy}
              >
                Install {installable.length} missing font
                {installable.length === 1 ? '' : 's'}
              </button>
            )}
            <button onClick={() => void makeBundle()} disabled={!!busy || summary.total === 0}>
              Build font bundle (.zip)
            </button>
            <div className="spacer" />
            {hiddenCount > 0 && (
              <button onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide' : `Show ${hiddenCount} more`}
              </button>
            )}
          </div>

          {desktop && installDir && (
            <p className="note info" style={{ fontSize: 12.5 }}>
              Fonts install to <code>{installDir}</code> — your own account, no administrator
              password. Fonts already there are never overwritten.
            </p>
          )}

          <div className="fonts">
            {visible.map((r) => (
              <FontRow
                key={r.font.name}
                r={r}
                desktop={desktop}
                busy={!!busy}
                onGet={() => void getOne(r)}
                onInstall={() => void install([r])}
                onSubstitute={(family) => void useSubstitute(r, family)}
              />
            ))}
          </div>

          {scan.ignoredFallbacks.length > 0 && (
            <details className="ignored">
              <summary>
                {scan.ignoredFallbacks.length} script-fallback fonts ignored — why this matters
              </summary>
              <p>
                Every Office theme carries a table of fonts to reach for if the deck ever contains
                Japanese, Devanagari, Khmer and so on. They are listed whether or not a single such
                character is present. Counting them would tell you to install all of these, none of
                which this deck uses:
              </p>
              <div className="list">
                {scan.ignoredFallbacks.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            </details>
          )}

          {scan.warnings.length > 0 && (
            <div className="note warn" style={{ marginTop: 14 }}>
              {scan.warnings.map((w, i) => (
                <div key={i}>{w.message}</div>
              ))}
            </div>
          )}
        </>
      )}

      <footer>
        {scan ? `${scan.slideCount} slide${scan.slideCount === 1 ? '' : 's'} scanned · ` : ''}
        {desktop ? 'Desktop · ' : ''}
        Catalogues: {CATALOGUE_COUNT} Google Fonts families ({CATALOGUE_DATE}) + {FONTSOURCE_COUNT}{' '}
        more from Fontsource · {__APP_VERSION__}
      </footer>
    </>
  )
}

function InstallSummary({ report }: { report: InstallReport }) {
  const failures = report.outcomes.filter((o) => o.status === 'failed')
  const cls = failures.length > 0 ? 'warn' : 'info'
  return (
    <div className={`note ${cls}`} style={{ marginTop: 16 }}>
      <strong>
        {report.installed} installed
        {report.skipped > 0 && `, ${report.skipped} already present`}
        {report.failed > 0 && `, ${report.failed} failed`}
      </strong>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>{report.dir}</div>
      {report.note && <div style={{ marginTop: 6 }}>{report.note}</div>}
      {failures.map((f) => (
        <div key={f.filename} style={{ marginTop: 6, fontSize: 12.5 }}>
          <strong>{f.filename}</strong> — {f.detail}
        </div>
      ))}
    </div>
  )
}

function FontRow({
  r,
  desktop,
  busy,
  onGet,
  onInstall,
  onSubstitute,
}: {
  r: ResolvedFont
  desktop: boolean
  busy: boolean
  onGet: () => void
  onInstall: () => void
  onSubstitute: (family: string) => void
}) {
  const { font } = r

  const pill =
    r.state === 'installed' ? (
      <span className="pill ok">Installed</span>
    ) : r.state === 'embedded' ? (
      <span className="pill info">Embedded in deck</span>
    ) : r.state === 'family-installed' ? (
      <span className="pill warn">Family only</span>
    ) : (
      <span className="pill bad">Missing</span>
    )

  const detail: string[] = []
  if (font.family !== font.name) detail.push(`family ${font.family}`)
  if (font.weight !== 400) detail.push(`weight ${font.weight}`)
  if (font.italic) detail.push('italic')
  if (r.state === 'family-installed' && r.matchedFamily) {
    detail.push(`${r.matchedFamily} is installed, but not this weight`)
  }
  if (r.state === 'embedded') {
    detail.push(
      font.embedded?.extracted?.length
        ? 'travels with the deck — and can be extracted into a bundle'
        : 'travels with the deck — compressed, cannot be extracted',
    )
  }
  if (r.google) {
    detail.push(
      r.google.exact
        ? `on Google Fonts (${r.google.license})`
        : `Google Fonts has ${r.google.family} (${r.google.license})`,
    )
  }
  if (r.fontsource) {
    detail.push(
      r.fontsource.exact
        ? `on Fontsource (${r.fontsource.license})`
        : `Fontsource has ${r.fontsource.family} (${r.fontsource.license})`,
    )
  }
  if (r.suggestions.length > 0) {
    detail.push(`similar on Google Fonts: ${r.suggestions.map((s) => s.family).join(', ')}`)
  }

  const canFetch = !!downloadPlan(r)
  const wants = r.state === 'missing' || r.state === 'family-installed'

  // A stand-in for something that cannot legally travel in the bundle.
  const sub = r.substitutes
  const best = sub?.substitutes[0]
  const alternates = sub?.substitutes.slice(1) ?? []

  return (
    <div className="row">
      <div>
        <div className="name">{font.name}</div>
        <div className="meta">
          <span className="pill tier">{TIER_LABEL[font.tier]}</span> {font.count} reference
          {font.count === 1 ? '' : 's'}
          {detail.length > 0 && ' · '}
          {detail.join(' · ')}
        </div>
        {(r.adobe || r.installedViaAdobeSync) && (
          <div className="sub sub-adobe">
            <strong>{r.adobe?.family ?? font.family}</strong> is an Adobe Font
            {r.adobe?.foundry ? ` (${r.adobe.foundry})` : ''}
            {/*
              Two quite different situations share this block. A missing Adobe
              font is a gap the user can see. A synced one shows as installed
              and is the more dangerous of the two — nothing on screen would
              otherwise suggest the deck is about to break somewhere else.
            */}
            {r.installedViaAdobeSync
              ? ' — Creative Cloud syncs it onto this machine, which is why it shows as ' +
                'installed. A machine without the subscription will not have it, and Adobe’s ' +
                'licence does not permit putting the file in a bundle.'
              : ', so it cannot travel with the deck — Adobe’s licence does not permit ' +
                'putting the file in a bundle.'}{' '}
            {r.adobe && (
              <>
                Anyone with a Creative Cloud subscription can activate it.{' '}
                <a href={r.adobe.url} target="_blank" rel="noreferrer noopener">
                  Activate on Adobe Fonts
                </a>
                {r.adobe.hasOpenSourceCut && ' · an open-source cut of this family also exists'}
              </>
            )}
          </div>
        )}
        {sub && best && (
          <div className={`sub ${best.metric ? 'sub-metric' : 'sub-similar'}`}>
            <strong>{best.family}</strong> can stand in for {sub.target}.{' '}
            {best.metric
              ? 'Same widths, so your line breaks and text boxes hold.'
              : 'Widths differ, so line breaks will move — check the deck afterwards.'}
            {alternates.length > 0 && (
              <> Also: {alternates.map((a) => a.family).join(', ')}.</>
            )}
          </div>
        )}
      </div>
      <div className="actions">
        {pill}
        {wants && canFetch && (
          <button onClick={desktop ? onInstall : onGet} disabled={busy}>
            {desktop ? 'Install' : 'Download'}
          </button>
        )}
        {wants && !canFetch && best && (
          <button
            onClick={() => onSubstitute(best.family)}
            disabled={busy}
            title={best.note}
          >
            {desktop ? 'Install' : 'Download'} {best.family}
          </button>
        )}
      </div>
    </div>
  )
}
