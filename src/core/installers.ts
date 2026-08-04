/**
 * Installer scripts that ship inside the sidecar bundle.
 *
 * ## Why there is no true self-extracting archive
 *
 * A single file that unpacks and installs itself on every OS does not exist —
 * a Windows .exe is not runnable on macOS, and a shell script is not runnable
 * on Windows. What travels reliably is a plain .zip that every OS opens
 * natively, containing one small script per platform. That is what this
 * produces.
 *
 * ## The two traps that break naive installer scripts
 *
 * **macOS quarantine.** A .zip downloaded by a browser is tagged with
 * `com.apple.quarantine`, and the tag is inherited by everything extracted
 * from it. Double-clicking the extracted `.command` gets "cannot be opened
 * because it is from an unidentified developer" — Gatekeeper, not an error in
 * the script. A script cannot lift its own quarantine (the check happens
 * before it runs). So the bundle documents the two real ways through:
 * right-click -> Open, or the `xattr -d` one-liner. It also always offers the
 * no-script path: select the .ttf files and open them in Font Book.
 *
 * **Windows Mark-of-the-Web.** Same idea: files from a downloaded zip carry a
 * zone identifier, and PowerShell refuses to run the .ps1 under the default
 * execution policy. The .cmd wrapper is what makes this work — it calls
 * PowerShell with `-ExecutionPolicy Bypass` and `Unblock-File`s the script
 * first. Users should double-click the .cmd, never the .ps1.
 *
 * All three scripts install **per-user**, which needs no administrator rights:
 *   macOS    ~/Library/Fonts
 *   Windows  %LOCALAPPDATA%\Microsoft\Windows\Fonts  (+ HKCU registry entry)
 *   Linux    ~/.local/share/fonts                    (+ fc-cache)
 */

export const MACOS_INSTALLER = `#!/bin/bash
# Install the fonts in this folder into your user font library.
# No administrator password required — this only writes to your own account.

set -u
cd "$(dirname "$0")" || exit 1

DEST="$HOME/Library/Fonts"
mkdir -p "$DEST"

shopt -s nullglob nocaseglob
files=(fonts/*.ttf fonts/*.otf fonts/*.ttc)

if [ \${#files[@]} -eq 0 ]; then
  echo "No font files found next to this script."
  echo "Make sure you EXTRACTED the .zip first — scripts do not run from inside it."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "Installing \${#files[@]} font file(s) to $DEST"
echo

installed=0
skipped=0
for f in "\${files[@]}"; do
  name="$(basename "$f")"
  if [ -e "$DEST/$name" ]; then
    echo "  already present, skipping: $name"
    skipped=$((skipped + 1))
    continue
  fi
  if cp "$f" "$DEST/$name"; then
    # Clear the download quarantine so the font is trusted immediately.
    xattr -d com.apple.quarantine "$DEST/$name" 2>/dev/null
    echo "  installed: $name"
    installed=$((installed + 1))
  else
    echo "  FAILED: $name"
  fi
done

echo
echo "Done — $installed installed, $skipped already present."
echo "Applications already running may need restarting to see new fonts."
read -n 1 -s -r -p "Press any key to close..."
`

export const WINDOWS_CMD = `@echo off
REM Double-click THIS file, not the .ps1.
REM
REM Files extracted from a downloaded .zip carry Windows' Mark-of-the-Web, and
REM PowerShell refuses to run them under the default execution policy. This
REM wrapper unblocks the script and runs it with a bypass scoped to this one
REM process, which is why it works where double-clicking the .ps1 does not.

setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -Path '%~dp0install-fonts.ps1'; & '%~dp0install-fonts.ps1'"
if errorlevel 1 (
  echo.
  echo The installer reported a problem.
  pause
)
`

export const WINDOWS_PS1 = `# Install the fonts in this folder for the current user.
# No administrator rights required.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'fonts'

if (-not (Test-Path $src)) {
  Write-Host "No 'fonts' folder found next to this script."
  Write-Host "Make sure you EXTRACTED the .zip first - scripts do not run from inside it."
  Read-Host "Press Enter to close"
  exit 1
}

# Per-user font directory. Windows 10 1809+ registers fonts here without admin.
$dest = Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$regPath = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
New-Item -Path $regPath -Force | Out-Null

$files = Get-ChildItem -Path $src -Include *.ttf,*.otf,*.ttc -File -Recurse
if ($files.Count -eq 0) {
  Write-Host "No font files found in $src"
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Installing $($files.Count) font file(s) to $dest"
Write-Host ""

$installed = 0
$skipped   = 0
foreach ($f in $files) {
  $target = Join-Path $dest $f.Name
  if (Test-Path $target) {
    Write-Host "  already present, skipping: $($f.Name)"
    $skipped++
    continue
  }
  try {
    Copy-Item -Path $f.FullName -Destination $target -Force
    # The registry value is what actually makes the font visible to apps —
    # copying the file alone is not enough. Windows' own installer writes the
    # face name with a type suffix, e.g. "Poppins Regular (TrueType)", and
    # omitting the suffix leaves fonts that install but never appear in
    # application font menus.
    $valueName = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    if ($f.Extension -ieq '.otf') {
      $valueName = "$valueName (OpenType)"
    } else {
      $valueName = "$valueName (TrueType)"
    }
    New-ItemProperty -Path $regPath -Name $valueName -PropertyType String -Value $target -Force | Out-Null
    Write-Host "  installed: $($f.Name)"
    $installed++
  } catch {
    Write-Host "  FAILED: $($f.Name) - $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "Done - $installed installed, $skipped already present."
Write-Host "Applications already running may need restarting to see new fonts."
Read-Host "Press Enter to close"
`

export const LINUX_INSTALLER = `#!/bin/sh
# Install the fonts in this folder for the current user.
# No root required.

set -u
cd "$(dirname "$0")" || exit 1

DEST="\${XDG_DATA_HOME:-$HOME/.local/share}/fonts"
mkdir -p "$DEST"

count=0
for f in fonts/*.ttf fonts/*.otf fonts/*.ttc; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ -e "$DEST/$name" ]; then
    echo "  already present, skipping: $name"
    continue
  fi
  cp "$f" "$DEST/$name" && echo "  installed: $name" && count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "Nothing new installed."
else
  echo ""
  echo "Rebuilding the font cache..."
  fc-cache -f "$DEST" >/dev/null 2>&1 || echo "  (fc-cache not found — log out and back in to refresh)"
  echo "Done — $count font file(s) installed."
fi
`

export function readmeText(deckName: string, generated: string): string {
  return `FONT BUNDLE — ${deckName}
Generated ${generated} by PowerPoint Font Manager

WHAT THIS IS
  The fonts used by the presentation "${deckName}", collected so the deck can
  be opened on another machine without substitution.

  See MANIFEST.txt for the full list, where each font came from, and its
  licence.


HOW TO INSTALL

  FIRST: extract this .zip. The scripts below will not run from inside the
  archive — your OS opens zips read-only, and the installer needs to see the
  "fonts" folder next to it.

  macOS
    Double-click  install-fonts.command

    If macOS says the file "cannot be opened because it is from an
    unidentified developer", that is Gatekeeper, not a broken script: anything
    extracted from a downloaded zip inherits a quarantine flag. Either

      - right-click the file and choose Open, then confirm; or
      - run this in Terminal, in the extracted folder:
            xattr -d com.apple.quarantine install-fonts.command
            ./install-fonts.command

    No-script alternative: open the "fonts" folder, select all the files,
    and double-click. Font Book installs them.

  Windows
    Double-click  install-fonts.cmd          <-- this one
    NOT           install-fonts.ps1

    The .ps1 is blocked by PowerShell's execution policy because it came from
    a downloaded zip. The .cmd wrapper unblocks it and runs it correctly.

    No-script alternative: open the "fonts" folder, select all the files,
    right-click and choose Install.

  Linux
    sh install-fonts.sh

    No-script alternative: copy the files to ~/.local/share/fonts and run
    fc-cache -f


WHERE THE FONTS GO
  All three installers write to your own user account and need no
  administrator password:

    macOS    ~/Library/Fonts
    Windows  %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts
    Linux    ~/.local/share/fonts

  Fonts already installed are skipped, never overwritten.

  Applications that are already open may need restarting before they see the
  new fonts.


LICENSING
  Read MANIFEST.txt before passing this bundle on. Fonts marked RESTRICTED are
  included for your own use on your own machines; redistributing them may
  breach their licence. Fonts marked OFL-1.1, Apache-2.0 or UFL-1.0 are free to
  share.
`
}
