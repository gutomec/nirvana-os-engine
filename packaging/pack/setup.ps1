# setup.ps1 — one-command bootstrap on Windows, no prerequisite beyond PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Installs Bun (user space, in %USERPROFILE%\.bun) if missing, puts the binary on
# THIS session's PATH and runs the pack's setup.ts with that Bun. Idempotent.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Bun {
  $c = Get-Command bun -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $p) { return $p }
  return $null
}

$bun = Find-Bun
if (-not $bun) {
  Write-Host "Bun not found - installing (user-space, no admin)..."
  powershell -Command "irm bun.sh/install.ps1 | iex"
  $bun = Find-Bun
}
if (-not $bun) {
  # Console strings stay unaccented on purpose: PowerShell 5.1 reads a BOM-less
  # .ps1 as ANSI, so a "nao" written with the tilde reaches the buyer as mojibake.
  # Only what Write-Host prints needs to stay ASCII.
  Write-Host "Could not install Bun automatically."
  Write-Host "  Install it manually and run again:"
  Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"'
  Write-Host "    powershell -ExecutionPolicy Bypass -File setup.ps1"
  Write-Host "  If the execution policy blocks irm, install with winget:"
  Write-Host "    winget install Oven-sh.Bun"
  Write-Host "  Installed it and Bun is still missing? Open a new terminal before running again."
  exit 1
}

$env:Path = (Split-Path -Parent $bun) + ";" + $env:Path
& $bun (Join-Path $here "setup.ts")
# Propagate the installer's exit code. Without this the script always returned 0,
# so a Windows buyer whose setup failed saw a shell that said everything was fine
# — on the exact platform the last two license reports came from. setup.sh gets
# this for free via `exec`; PowerShell needs it spelled out.
exit $LASTEXITCODE
