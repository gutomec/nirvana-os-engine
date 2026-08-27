# setup.ps1 — bootstrap de 1 comando no Windows, sem pré-requisito além do PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Instala o Bun (user-space, em %USERPROFILE%\.bun) se faltar, garante o binário no
# PATH DESTA sessão e roda o setup.ts do pack com esse Bun. Idempotente.
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
  Write-Host "Bun nao encontrado - instalando (user-space, sem admin)..."
  powershell -Command "irm bun.sh/install.ps1 | iex"
  $bun = Find-Bun
}
if (-not $bun) {
  # Console strings stay unaccented on purpose: PowerShell 5.1 reads a BOM-less
  # .ps1 as ANSI, so a "nao" written with the tilde reaches the buyer as mojibake.
  # The comments above keep their accents; only what Write-Host prints is ASCII.
  Write-Host "Nao consegui instalar o Bun automaticamente."
  Write-Host "  Instale manualmente e rode de novo:"
  Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"'
  Write-Host "    powershell -ExecutionPolicy Bypass -File setup.ps1"
  Write-Host "  Se a politica de execucao bloquear o irm, instale pelo winget:"
  Write-Host "    winget install Oven-sh.Bun"
  Write-Host "  Instalou e o Bun continua sumido? Abra um terminal novo antes de rodar de novo."
  exit 1
}

$env:Path = (Split-Path -Parent $bun) + ";" + $env:Path
& $bun (Join-Path $here "setup.ts")
# Propagate the installer's exit code. Without this the script always returned 0,
# so a Windows buyer whose setup failed saw a shell that said everything was fine
# — on the exact platform the last two license reports came from. setup.sh gets
# this for free via `exec`; PowerShell needs it spelled out.
exit $LASTEXITCODE
