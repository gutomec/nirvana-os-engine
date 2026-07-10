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
  Write-Host "Nao consegui instalar o Bun. Instale manualmente: https://bun.sh e rode de novo."
  exit 1
}

$env:Path = (Split-Path -Parent $bun) + ";" + $env:Path
& $bun (Join-Path $here "setup.ts")
