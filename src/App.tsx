import { useCallback, useMemo, useRef, useState } from 'react'
import { scanPptx } from './core/scan'
import { fetchGoogleFaces } from './core/google'
import { CATALOGUE_COUNT, CATALOGUE_DATE } from './core/google'
import { buildBundle, bundleFilename, localLicenseNote, type BundleEntry } from './core/bundle'
import { resolveAll, summarize, type ResolvedFont } from './lib/resolve'
import {
  defaultInventory,
  hasLocalFontAccess,
  queryLocalFontInventory,
  type FontInventory,
} from './platform/fontcheck'
import type { ScanResult } from './core/types'

declare const __APP_VERSION__: string

const TIER_LABEL: Record<string, string> = {
  slide: 'on a slide',
  inherited: 'layout / theme',
  elsewhere: 'notes / unused layout',
}

function download(data: Uint8Array, filename: string) {
  // Copy into a fresh ArrayBuffer — the view may be a subarray of a larger one.
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
  const [deckName, setDeckName] = useState<string>('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [inventory, setInventory] = useState<FontInventory>(() => defaultInventory())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [bundling, setBundling] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

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

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setScan(null)
    setBusy('Reading presentation…')
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const result = scanPptx(buf)
      setDeckName(file.name)
      setScan(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

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

  /** Download a single missing font from Google Fonts. */
  const getOne = useCallback(async (r: ResolvedFont) => {
    if (!r.google?.downloadable) return
    setBusy(`Downloading ${r.google.family}…`)
    setError(null)
    try {
      const faces = await fetchGoogleFaces(r.google.family, [r.font.weight], {
        italics: r.font.italic,
      })
      for (const f of faces) download(f.data, f.filename)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  /** Build the sidecar bundle. */
  const makeBundle = useCallback(async () => {
    if (!scan) return
    setBundling(true)
    setError(null)
    const entries: BundleEntry[] = []
    const unavailable: Array<{ name: string; reason: string }> = []

    try {
      for (const r of resolved) {
        const font = r.font

        // 1. Embedded and extractable — take it straight from the deck.
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

        // 2. On Google Fonts — fetch the real static TTF.
        if (r.google?.downloadable) {
          setBusy(`Fetching ${r.google.family}…`)
          try {
            const faces = await fetchGoogleFaces(r.google.family, [font.weight], {
              italics: font.italic,
            })
            for (const f of faces) {
              entries.push({
                filename: f.filename,
                data: f.data,
                family: f.family,
                source: 'google',
                license: f.license,
                redistributable: true,
                provenance: `Google Fonts (${f.license})${f.variable ? ', variable font' : ''}`,
              })
            }
            continue
          } catch (e) {
            unavailable.push({ name: font.name, reason: (e as Error).message })
            continue
          }
        }

        // 3. Installed locally and we can read the bytes (Local Font Access).
        const records = inventory.records
        if (records) {
          const wanted = (r.matchedFamily ?? font.family).toLowerCase()
          const hits = records.filter((rec) => rec.family?.toLowerCase() === wanted)
          if (hits.length > 0 && hits[0]!.blob) {
            setBusy(`Reading ${font.family} from your system…`)
            let added = 0
            for (const hit of hits) {
              try {
                const blob = await hit.blob!()
                const data = new Uint8Array(await blob.arrayBuffer())
                const note = localLicenseNote(font, r.google ?? null)
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

        unavailable.push({
          name: font.name,
          reason: hasLocalFontAccess()
            ? inventory.records
              ? 'Not on Google Fonts, and the font file could not be read from this machine.'
              : 'Not on Google Fonts. Grant local font access to include fonts you already have.'
            : 'Not on Google Fonts, and this browser cannot read local font files. ' +
              'Open in Chrome or Edge to include fonts already installed here.',
        })
      }

      if (entries.length === 0) {
        setError(
          'Nothing could be bundled — every font is either already everywhere, ' +
            'unavailable, or locked inside the deck. See the list for details.',
        )
        return
      }

      const zip = buildBundle({ deckName, entries, unavailable })
      download(zip, bundleFilename(deckName))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      setBundling(false)
    }
  }, [scan, resolved, inventory, deckName])

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
        Find the fonts a deck actually uses, check which are installed here, and build a sidecar
        bundle so it opens correctly somewhere else. The file never leaves your browser.
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
        <span>{deckName ? 'Drop another to replace it' : 'or click to choose — .pptx, .potx, .ppsx'}</span>
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

          {inventory.method === 'canvas-metrics' && hasLocalFontAccess() && (
            <div className="note info">
              Detecting fonts by measuring text width — accurate, but it cannot read font files.{' '}
              <strong>Grant access to your font list</strong> to include fonts you already have in
              the bundle.
              <br />
              <button onClick={() => void upgradeInventory()}>Allow font access</button>
            </div>
          )}

          {inventory.method === 'canvas-metrics' && !hasLocalFontAccess() && (
            <div className="note info">
              This browser has no Local Font Access API, so fonts are detected by measuring text
              width. That is reliable for checking what is installed, but fonts you already own
              cannot be read into a bundle. Chrome or Edge can do both.
            </div>
          )}

          <div className="bar">
            <button
              className="primary"
              onClick={() => void makeBundle()}
              disabled={bundling || summary.total === 0}
            >
              {bundling ? 'Building…' : 'Build font bundle (.zip)'}
            </button>
            <div className="spacer" />
            {hiddenCount > 0 && (
              <button onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide' : `Show ${hiddenCount} more`}
              </button>
            )}
          </div>

          <div className="fonts">
            {visible.map((r) => (
              <FontRow key={r.font.name} r={r} onGet={() => void getOne(r)} busy={!!busy} />
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
        {scan
          ? `${scan.slideCount} slide${scan.slideCount === 1 ? '' : 's'} scanned · `
          : ''}
        Google Fonts catalogue: {CATALOGUE_COUNT} families, {CATALOGUE_DATE} · {__APP_VERSION__}
      </footer>
    </>
  )
}

function FontRow({ r, onGet, busy }: { r: ResolvedFont; onGet: () => void; busy: boolean }) {
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
  if (r.suggestions.length > 0) {
    detail.push(`similar on Google Fonts: ${r.suggestions.map((s) => s.family).join(', ')}`)
  }

  return (
    <div className="row">
      <div>
        <div className="name">{font.name}</div>
        <div className="meta">
          <span className="pill tier">{TIER_LABEL[font.tier]}</span>{' '}
          {font.count} reference{font.count === 1 ? '' : 's'}
          {detail.length > 0 && ' · '}
          {detail.join(' · ')}
        </div>
      </div>
      <div className="actions">
        {pill}
        {r.state === 'missing' && r.google?.downloadable && (
          <button onClick={onGet} disabled={busy}>
            Download
          </button>
        )}
      </div>
    </div>
  )
}
