# Attributions

PowerPoint Font Manager is built on other people's work. This file lists what that work is,
who did it, and what it is doing here.

> **Note:** in the rest of the fleet this file is generated — the master lists live in the
> `stoatworks-backend` repo and are pushed out by `scripts/sync-attributions.py`. This repo
> is new and is **not registered there yet**, so this copy is hand-written. Register it and
> re-run the sync, then stop editing this file by hand.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

### fflate

<https://github.com/101arrowz/fflate>  
Licence: MIT  
Copyright: Arjun Barrett

An npm dependency. Reads the `.pptx` archive and writes the sidecar bundle. Chosen over
JSZip for its `filter` option on `unzipSync`, which is what lets a 316 MB deck be scanned
without inflating its media.

### Vite

<https://vite.dev>  
Licence: MIT  
Copyright: VoidZero Inc. and Vite contributors

A build-time dependency.

### Vitest

<https://vitest.dev>  
Licence: MIT  
Copyright: VoidZero Inc. and Vitest contributors

A build-time dependency.

### TypeScript

<https://www.typescriptlang.org>  
Licence: Apache-2.0  
Copyright: Microsoft Corporation

A build-time dependency.

## Data this project uses

### Google Fonts catalogue

<https://fonts.google.com/metadata/fonts> and <https://github.com/google/fonts>  
Licence of the catalogue metadata: the Google Fonts API is provided by Google  
Licences of the fonts themselves: OFL-1.1, Apache-2.0 or UFL-1.0, per family

`src/data/google-fonts.json` is a build-time snapshot of the family list, categories,
published weights, and — taken from the directory each family lives in within the
`google/fonts` repo — its SPDX licence. Regenerate with `scripts/build-catalogue.mjs`.

Font files themselves are **not** bundled with this app. They are downloaded from
`raw.githubusercontent.com/google/fonts` at the user's request, and each family's licence
is recorded in the manifest of any bundle it goes into.

## Standards and formats

### ECMA-376 / ISO/IEC 29500 — Office Open XML

<https://ecma-international.org/publications-and-standards/standards/ecma-376/>

The `.pptx` format. The parts this project reads are the presentation, slide, slide layout,
slide master, notes, chart, diagram and theme parts, plus the embedded font list.

### Embedded OpenType (EOT)

<https://www.w3.org/Submission/EOT/>  
Submitted to the W3C by Microsoft

The format of `ppt/fonts/*.fntdata`. This project reads the EOT header to report what an
embedded font is, and recovers the sfnt payload where it is not MicroType Express
compressed.
