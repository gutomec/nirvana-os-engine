# Nirvana-OS — instalador de um comando (Windows).
#
#   irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
#
# Instala o Bun (user-space, em %USERPROFILE%\.bun, sem admin) se faltar, baixa o
# engine mais recente do GitHub e roda o instalador com esse Bun. Idempotente.
#
# Node.js NAO e necessario. O engine roda em Bun por construcao, e este script so
# usa o que ja existe no Windows 10+: PowerShell e tar.
#
# Variaveis:
#   NIRVANA_ENGINE_REPO      repo alternativo (padrao: gutomec/nirvana-os-engine)
#   NIRVANA_ENGINE_URL       URL direta do tarball
#   NIRVANA_ENGINE_TARBALL   .tar.gz local, para instalar offline
$ErrorActionPreference = "Stop"

$repo = if ($env:NIRVANA_ENGINE_REPO) { $env:NIRVANA_ENGINE_REPO } else { "gutomec/nirvana-os-engine" }
$url  = if ($env:NIRVANA_ENGINE_URL)  { $env:NIRVANA_ENGINE_URL }  else { "https://github.com/$repo/releases/latest/download/nirvana-os-engine.tar.gz" }

function Find-Bun {
  $c = Get-Command bun -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $p) { return $p }
  return $null
}

# --- 1. Bun ---
$bun = Find-Bun
if (-not $bun) {
  Write-Host "Bun nao encontrado - instalando (user-space, sem admin)..."
  powershell -Command "irm bun.sh/install.ps1 | iex"
  $bun = Find-Bun
}
if (-not $bun) { Write-Error "Nao consegui instalar o Bun. Instale por https://bun.sh e rode de novo."; exit 1 }
# Garante o bun no PATH DESTA sessao: o instalador do engine tambem o invoca.
$env:Path = (Split-Path -Parent $bun) + ";" + $env:Path
Write-Host "Bun: $(& $bun --version) ($bun)"

# --- 2. Engine ---
# Sobras de instalacoes anteriores: as versoes ate 0.1.73 nao limpavam, e cada
# execucao deixava ~14 MB. So o que tem mais de uma hora, para nunca puxar o
# tapete de uma instalacao rodando em paralelo.
Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Directory -Filter "nrv-engine-*" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("nrv-engine-" + [System.IO.Path]::GetRandomFileName())
$code = 1
New-Item -ItemType Directory -Path $work -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $work "src") -Force | Out-Null
try {
  $tarball = Join-Path $work "engine.tar.gz"
  if ($env:NIRVANA_ENGINE_TARBALL) {
    if (-not (Test-Path $env:NIRVANA_ENGINE_TARBALL)) { Write-Error "NIRVANA_ENGINE_TARBALL nao existe: $($env:NIRVANA_ENGINE_TARBALL)"; exit 1 }
    Write-Host "Engine local: $($env:NIRVANA_ENGINE_TARBALL)"
    Copy-Item $env:NIRVANA_ENGINE_TARBALL $tarball
  } else {
    Write-Host "Baixando o engine mais recente..."
    # ProgressPreference: sem isto o Invoke-WebRequest fica ordens de grandeza mais lento.
    $prev = $ProgressPreference; $ProgressPreference = "SilentlyContinue"
    try { Invoke-WebRequest -Uri $url -OutFile $tarball -UseBasicParsing }
    catch { Write-Error "Falha ao baixar o engine. Verifique a internet, ou baixe o .tar.gz e use NIRVANA_ENGINE_TARBALL=..."; exit 1 }
    finally { $ProgressPreference = $prev }
  }

  # Paths absolutos aqui de proposito. A precaucao de usar relativo (um path
  # "C:\..." tem ":" e vira host remoto) vale para o GNU tar do Git Bash; o tar
  # do Windows 10+ e bsdtar, chamado direto pelo PowerShell, e lida com "C:" bem.
  # Sem Push-Location/Pop-Location de proposito: mudar o diretorio do processo
  # cria um estado que precisa ser desfeito, e se o Pop falhar o processo fica
  # DENTRO do temporario e a limpeza nao consegue mais apaga-lo. Nao ha ganho que
  # justifique o risco quando o -C absoluto resolve.
  & tar -xzf $tarball -C (Join-Path $work "src")
  if ($LASTEXITCODE -ne 0) { Write-Error "Nao consegui extrair o engine (precisa do 'tar', presente no Windows 10+)." }

  # O asset extrai plano (scripts/ na raiz); um archive de source vem embrulhado
  # num diretorio unico. Aceita os dois.
  $root = Join-Path $work "src"
  if (-not (Test-Path (Join-Path $root "scripts/install.ts"))) {
    $dirs = @(Get-ChildItem -Path $root -Directory)
    if ($dirs.Count -eq 1 -and (Test-Path (Join-Path $dirs[0].FullName "scripts/install.ts"))) { $root = $dirs[0].FullName }
  }
  if (-not (Test-Path (Join-Path $root "scripts/install.ts"))) { Write-Error "Asset do engine invalido (sem scripts/install.ts)."; exit 1 }

  & $bun (Join-Path $root "scripts/install.ts") @args
  $code = $LASTEXITCODE
} finally {
  # -LiteralPath + -Confirm:$false: sem os dois, o Remove-Item pede confirmacao
  # no meio do encerramento e estoura NullReference ao nao conseguir ler o stdin.
  # Double check: um Remove-Item que nao lancou nao prova remocao — no Windows um
  # antivirus segurando um handle faz o unlink falhar em silencio. O laco
  # confirma com Test-Path a cada tentativa.
  #
  # -LiteralPath: o path vem de GetRandomFileName e nao deve ser tratado como
  # wildcard. -Confirm:$false: sem ele o cmdlet pode pedir confirmacao no meio do
  # encerramento, quando nao ha mais stdin para responder.
  for ($i = 1; $i -le 3; $i++) {
    if (-not (Test-Path -LiteralPath $work)) { break }
    Remove-Item -LiteralPath $work -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $work)) { break }
    # Limpa o atributo ReadOnly da arvore antes de tentar de novo. Repetir o
    # mesmo Remove-Item so repetiria o mesmo erro.
    Get-ChildItem -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue |
      ForEach-Object { try { $_.Attributes = [System.IO.FileAttributes]::Normal } catch { } }
  }
  if (Test-Path -LiteralPath $work) {
    Write-Host "Nao consegui remover o temporario: $work (nada quebrou - apague quando puder)"
  }
}
exit $code
