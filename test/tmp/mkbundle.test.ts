import { it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBundle, type BundleEntry } from '../../src/core/bundle'

it('write a bundle for the Windows VM test', () => {
  const data = new Uint8Array(readFileSync('/tmp/Lobster-Regular.ttf'))
  const entries: BundleEntry[] = [{
    filename: 'Lobster-Regular.ttf',
    data,
    family: 'Lobster',
    source: 'google',
    license: 'OFL-1.1',
    redistributable: true,
    provenance: 'Google Fonts (OFL-1.1)',
  }]
  const zip = buildBundle({ deckName: 'Windows VM test.pptx', entries, unavailable: [] })
  writeFileSync('/tmp/windows-font-bundle.zip', zip)
})
