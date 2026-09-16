# bootstrap.ps1 — install the Nirvana-OS engine from the `nirvana` skill (Windows).
#
#   powershell -ExecutionPolicy Bypass -File bootstrap.ps1 [-Yes] [-DryRun] [-Update]
#
# Mirror of bootstrap.sh: finds or installs Bun in user space, downloads the
# engine release tarball, extracts it and runs the engine's own installer
# (scripts/install.ts --no-starter). Same environment variables, same exit
# codes: 0 present or installed, 2 usage, 3 no consent, 4 missing prerequisite,
# 5 download failed, 6 checksum mismatch, 7 installer failed.
#
# Console strings stay unaccented on purpose: PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI and a non-ASCII character reaches the user as mojibake.
param(
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Update
)
$ErrorActionPreference = "Stop"

$profileDir = $env:USERPROFILE
$localNrv = Join-Path $profileDir ".local\bin\nrv.cmd"
$engineDir = Join-Path $profileDir ".nirvana\skills\harness"
$repo = if ($env:NIRVANA_ENGINE_REPO) { $env:NIRVANA_ENGINE_REPO } else { "gutomec/nirvana-os-engine" }
$url = if ($env:NIRVANA_ENGINE_URL) { $env:NIRVANA_ENGINE_URL } else { "https://github.com/$repo/releases/latest/download/nirvana-os-engine.tar.gz" }
if ($env:NIRVANA_BOOTSTRAP_YES -eq "1") { $Yes = $true }

# 1. Already here?
$nrvOnPath = [bool](Get-Command nrv -ErrorAction SilentlyContinue)
if (-not $Update -and (Test-Path $engineDir) -and ($nrvOnPath -or (Test-Path $localNrv))) {
  $verFile = Join-Path $profileDir ".nirvana\skills\VERSION"
  $ver = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { "unknown" }
  Write-Host "Nirvana-OS engine already installed (version $ver). Nothing to do; pass -Update to reinstall."
  exit 0
}

# 2. What this will change.
$source = if ($env:NIRVANA_ENGINE_TARBALL) { $env:NIRVANA_ENGINE_TARBALL } else { $url }
Write-Host "Nirvana-OS bootstrap will change this machine:"
Write-Host "  - Bun in user space ($profileDir\.bun) if it is missing, no admin"
Write-Host "  - the engine in $profileDir\.nirvana (skills + shared node_modules)"
Write-Host "  - the nrv launcher in $profileDir\.local\bin, plus that directory in the user PATH"
Write-Host "  - audit hooks in the settings of the agent runtimes it finds (.claude, .gemini, .codex, .antigravity)"
Write-Host "  - runtime skill copies in .claude\skills, .codex\skills, .gemini\skills, .antigravity\skills, .pi\agent\skills, .agents\skills"
Write-Host "  - the empty content roots squads, businesses, businesses\_library\dna under the user profile"
Write-Host "  Source: $source"
Write-Host "  Reversible with: nrv uninstall --engine"
if ($DryRun) { Write-Host "(dry run: nothing changed)"; exit 0 }

# 3. Consent.
if (-not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $ans = Read-Host "Proceed? [y/N]"
  if ($ans -match '^(y|yes|s|sim)$') { $Yes = $true }
}
if (-not $Yes) {
  Write-Host "No consent given. Re-run with -Yes (or NIRVANA_BOOTSTRAP_YES=1) to install."
  exit 3
}

# 4. Prerequisites.
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Write-Host "tar not found (Windows 10+ ships it); install it and re-run."
  exit 4
}

# 5. Bun.
function Find-Bun {
  $c = Get-Command bun -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $p) { return $p }
  return $null
}
$bun = Find-Bun
if (-not $bun) {
  Write-Host "Bun not found; installing in user space (no admin)..."
  try { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" } catch { }
  $bun = Find-Bun
}
if (-not $bun) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Bun could not be installed; falling back to npx @nirvana-os/cli (Node)."
    & npx -y @nirvana-os/cli
    exit $LASTEXITCODE
  }
  Write-Host "Bun could not be installed and Node is absent. Install Bun and re-run:"
  Write-Host '  powershell -c "irm bun.sh/install.ps1 | iex"'
  exit 4
}
$env:Path = (Split-Path -Parent $bun) + ";" + $env:Path

# 6-7. The tarball, extracted with RELATIVE paths (an absolute path carries a ":").
$work = Join-Path ([IO.Path]::GetTempPath()) ("nrv-engine-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
$code = 0
try {
  $localTb = $env:NIRVANA_ENGINE_TARBALL
  if ($localTb) { $localTb = $localTb -replace '^file://', '' }
  $expected = ""
  if ($localTb) {
    if (-not (Test-Path $localTb)) { Write-Host "NIRVANA_ENGINE_TARBALL not found: $localTb"; exit 5 }
    Copy-Item $localTb (Join-Path $work "engine.tar.gz")
    if (Test-Path "$localTb.sha256") { $expected = (Get-Content "$localTb.sha256" -First 1).Substring(0, 64) }
  } else {
    Write-Host "Downloading $url ..."
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $work "engine.tar.gz") }
    catch {
      Write-Host "Download failed. Behind a proxy or offline? Fetch the tarball by hand and re-run with NIRVANA_ENGINE_TARBALL=<path>"
      exit 5
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile (Join-Path $work "engine.tar.gz.sha256")
      $expected = (Get-Content (Join-Path $work "engine.tar.gz.sha256") -First 1).Substring(0, 64)
    } catch { $expected = "" }
  }
  # Verify the bytes against the published checksum when both exist.
  if ($expected) {
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $work "engine.tar.gz")).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      Write-Host "Checksum mismatch: the engine tarball is not the one the release published."
      Write-Host "  expected $expected"
      Write-Host "  got      $actual"
      Write-Host "Nothing was installed. Download again, or verify the source."
      exit 6
    }
    Write-Host "Checksum verified (sha256 $actual)."
  } else {
    Write-Host "No checksum published for this asset; proceeding without integrity verification."
  }
  New-Item -ItemType Directory -Path (Join-Path $work "src") | Out-Null
  Push-Location $work
  & tar -xzf engine.tar.gz -C src
  $tarExit = $LASTEXITCODE
  Pop-Location
  if ($tarExit -ne 0) { Write-Host "Could not extract the engine tarball."; exit 5 }
  $root = Join-Path $work "src"
  if (-not (Test-Path (Join-Path $root "scripts\install.ts"))) {
    $entries = @(Get-ChildItem -Path $root -Directory)
    if ($entries.Count -eq 1 -and (Test-Path (Join-Path $entries[0].FullName "scripts\install.ts"))) { $root = $entries[0].FullName }
  }
  if (-not (Test-Path (Join-Path $root "scripts\install.ts"))) { Write-Host "Invalid engine asset (no scripts/install.ts)."; exit 5 }

  # 8. The engine's own installer, run from the profile dir so its post-install
  # index builds the GLOBAL registry.
  Push-Location $profileDir
  Remove-Item Env:NIRVANA_PROJECT_ROOT -ErrorAction SilentlyContinue
  & $bun (Join-Path $root "scripts\install.ts") --no-starter
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Host "The engine installer failed (see above)."; exit 7 }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Nirvana-OS engine installed. New shells find nrv on PATH; for this one:"
Write-Host '  $env:Path = "$env:USERPROFILE\.local\bin;" + $env:Path'
exit 0
