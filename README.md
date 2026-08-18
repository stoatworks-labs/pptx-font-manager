# PowerPoint Font Manager

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The scanner is verified
> against three real presentations of different provenance — one from Canva, one
> from Office with embedded fonts, one 316 MB deck that names almost no fonts
> explicitly — and its installed/missing verdicts were checked font by font
> against CoreText's own list on macOS. The bundle's **Windows installer script
> has never been run on Windows**; the macOS and Linux ones are syntax-checked
> but have not been run against a real font install. Check the bundle on a spare
> machine before you rely on it in front of a client.

Drop in a `.pptx`. Find out which fonts it **actually** uses, which of those are
installed here, and take away a sidecar `.zip` that installs the rest on the
machine that needs them.

Everything happens in the browser. The deck is never uploaded anywhere.

---

## Why not just search the file for font names

Because you get a wrong answer that looks right. Every PowerPoint theme carries
a *script fallback table* — a list of fonts to reach for if the deck ever
contains Japanese, Devanagari, Khmer, Syriac and so on. It is there whether or
not a single such character exists in the presentation.

Searching a real deck for `typeface=` finds **39 fonts**. It uses **two**. The
other 37 are that table, and a tool that lists them will send you off to install
Mongolian Baiti and DokChampa for a slide that says "Welcome" in Calibri.

The second half of the problem is that decks name *faces*, not *families*:

| The deck asks for      | A naive check says | Actually             |
| ---------------------- | ------------------ | -------------------- |
| `Helvetica Neue Medium` | missing            | you have it          |
| `Poppins Regular`       | missing            | you have it          |
| `Times Roman`           | missing            | that's Times New Roman |
| `Garamond`              | missing            | genuinely missing    |

Three false alarms out of four. This tool resolves the names first, so "missing"
means missing.

---

## What it does

**Scans** slides, layouts, masters, notes, charts and SmartArt, resolves theme
references (`+mn-lt` and friends) through the theme the slide actually
inherits, and sorts what it finds by how much it matters — used on a slide,
inherited from a layout or theme, or only present somewhere incidental.

**Checks what is installed**, using the Local Font Access API where the browser
has it, and text-width measurement everywhere else. The fallback was checked
against CoreText on macOS across nine fonts and agreed on all nine.

**Finds replacements** across two catalogues — 1,942 Google Fonts families plus
119 more from Fontsource that Google does not carry — matched after the name is
normalised, with near-matches offered when there is no exact one (a missing
`Garamond` suggests EB Garamond and Cormorant Garamond).

**Substitutes what cannot be shared.** The fonts most often missing are the
ones a deck picks up just by being written on Windows or a Mac — Calibri,
Cambria, Arial, Times New Roman, Courier New, Georgia. None may be
redistributed and none are on Google Fonts, so the app offers *metric-compatible*
stand-ins instead: Carlito for Calibri, Caladea for Cambria, Arimo for Arial,
Tinos for Times New Roman. These have the **same advance widths** as the
original, so line breaks hold and text stays inside its box.

Where only a visually similar face exists (Open Sans for Segoe UI), it says so
plainly — that swap *will* move your line breaks, and being told the deck is
fixed when it is not is worse than being told the font is missing.

**Recognises Adobe Fonts.** These can never be bundled — Adobe's terms say the
fonts "are not compatible with packaging workflows that involve transferring
font files to another user or computer", and there is no API that serves the
files in any case. So for a missing one the app names the reason and links
straight to the family page, where anyone with a Creative Cloud subscription can
activate it.

The desktop app also catches the version of this that looks fine: a font
Creative Cloud syncs onto your machine is installed here and nowhere else, so
the deck renders perfectly for you and breaks at the venue. It is told apart
from an ordinary installed font by where its file lives — Adobe keeps synced
faces in its own CoreSync folder — which is why *Times New Roman* does not get
the warning merely for being sold on Adobe Fonts too.

**Reports embedded fonts** — fonts that travel inside the deck and need no
installation at all. Where the format allows, it extracts them as real
installable files (see below).

**Builds a sidecar `.zip`** containing the fonts, a manifest saying where each
came from and under what licence, and an installer for macOS, Windows and Linux
that writes to the per-user font directory with no administrator password.

---

## Embedded fonts

PowerPoint's "embed fonts in the file" does not store a TTF. It stores **EOT**,
and what happens next depends on who wrote the file:

| Written by         | Format                  | Can it be recovered?               |
| ------------------ | ----------------------- | ---------------------------------- |
| PowerPoint         | EOT + MicroType Express | **No** — the glyph data is compressed |
| Canva, LibreOffice | EOT, uncompressed       | **Yes** — extracted as a valid TTF |

Either way the font travels with the deck, so it will render wherever the
`.pptx` goes. The distinction only matters for what can go in the bundle.

---

## The bundle, and two traps it works around

There is no such thing as a single self-extracting archive that runs on every
OS — a Windows `.exe` will not run on a Mac. So the bundle is a plain `.zip`
with one small script per platform, and a README that heads off the two ways
these normally fail:

- **macOS Gatekeeper.** Anything extracted from a downloaded zip inherits a
  quarantine flag, and double-clicking the installer gets "cannot be opened
  because it is from an unidentified developer". That is not a broken script.
  The README gives both ways through, plus the no-script route of dropping the
  fonts on Font Book.
- **Windows Mark-of-the-Web.** PowerShell refuses to run a `.ps1` that came out
  of a downloaded zip. The bundle ships a `.cmd` wrapper that unblocks it — run
  that one, not the `.ps1`.

Fonts already installed are skipped, never overwritten.

### Licensing

The manifest splits the bundle in two. Fonts from Google Fonts carry OFL-1.1,
Apache-2.0 or UFL-1.0 and are marked free to pass on. Anything taken off your
own machine or extracted from the deck is marked **RESTRICTED**, because font
licences almost never permit redistribution — and permission to *embed* a font
in a document is not permission to extract and install it somewhere else. The
bundle is built for moving your own deck between your own machines. Read the
manifest before you send it to anyone.

---

## The desktop app

The browser version can tell you a font is missing and hand you a zip. It
cannot put the font where the OS looks for it — no browser can. The desktop
build is the same app with that last step joined up: find the missing fonts,
fetch them, and **install them**, in one press.

It is also more accurate. It reads the platform's own font registry rather than
measuring text widths, so it resolves *faces* and not just families:
`Helvetica Neue Medium` comes back as installed rather than "the family is
there, the weight might not be".

Fonts go to your own account — `~/Library/Fonts`,
`%LOCALAPPDATA%\Microsoft\Windows\Fonts`, `~/.local/share/fonts` — so no
administrator password is needed, and anything already installed is skipped
rather than overwritten.

```bash
npm run desktop:dev      # run it
npm run desktop:build    # .app / .dmg / .msi / .deb / .AppImage
```

> **macOS and Linux only, so far.** The Windows install path is written but has
> never been run on Windows, and the same goes for Linux. See
> [AGENTS.md](AGENTS.md) §9 for exactly what is and is not verified.

## Development

```bash
npm install
npm run dev
npm test
```

Fixtures: the real decks used for testing are private and gitignored. A
synthetic one is generated and committed, so the suite tests something on a
clean clone:

```bash
node scripts/make-test-deck.mjs
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and
[AGENTS.md](AGENTS.md) for the design notes and traps.

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->

## Licence

MIT. Part of [Stoatworks Labs](https://stoatworks-labs.com).
