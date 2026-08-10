#!/usr/bin/env bash
# Nirvana-OS — instalador de um comando (macOS e Linux).
#
#   curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
#
# Instala o Bun (user-space, em ~/.bun, SEM sudo) se faltar, baixa o engine mais
# recente do GitHub e roda o instalador com esse Bun. Idempotente.
#
# Node.js NÃO é necessário. O engine roda em Bun por construção, e este script só
# usa o que já existe em qualquer máquina: curl (ou wget) e tar.
#
# Variáveis:
#   NIRVANA_ENGINE_REPO      repo alternativo (padrão: gutomec/nirvana-os-engine)
#   NIRVANA_ENGINE_URL       URL direta do tarball
#   NIRVANA_ENGINE_TARBALL   .tar.gz local, para instalar offline
#
# Argumentos são repassados ao instalador do engine:
#   curl -fsSL .../install.sh | bash -s -- --no-starter
set -euo pipefail

REPO="${NIRVANA_ENGINE_REPO:-gutomec/nirvana-os-engine}"
URL="${NIRVANA_ENGINE_URL:-https://github.com/$REPO/releases/latest/download/nirvana-os-engine.tar.gz}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 1. Bun ──────────────────────────────────────────────────────────────────
find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  [ -x "$HOME/.bun/bin/bun" ] && { echo "$HOME/.bun/bin/bun"; return 0; }
  return 1
}

BUN="$(find_bun || true)"
if [ -z "${BUN:-}" ]; then
  say "Bun não encontrado — instalando (user-space, em ~/.bun, sem sudo)…"
  # NUNCA sugerir 'npm install -g bun': dá EACCES em /usr/local.
  curl -fsSL https://bun.sh/install | bash \
    || die "Não consegui instalar o Bun. Instale por https://bun.sh e rode de novo."
  BUN="$(find_bun || true)"
  [ -n "${BUN:-}" ] || die "Bun instalado mas fora do PATH. Abra um novo terminal e rode de novo."
fi
# Garante o bun no PATH DESTA sessão: o instalador do engine também o invoca.
export PATH="$(dirname "$BUN"):$PATH"
say "Bun: $("$BUN" --version) ($BUN)"

# ── 2. Engine ───────────────────────────────────────────────────────────────
# Limpeza com double check: um `rm -rf` que retorna 0 nao prova remocao (um
# arquivo sem permissao de escrita sobrevive). O laco confirma com [ -d ] a cada
# tentativa e so desiste depois de forcar permissao. Nunca falha: `return 0` em
# todos os caminhos, senao o `set -e` derrubaria a instalacao por causa do lixo.
cleanup() {
  [ -n "${WORK:-}" ] || return 0
  for _ in 1 2 3; do
    rm -rf "$WORK" 2>/dev/null || true
    [ -d "$WORK" ] || return 0
    chmod -R u+w "$WORK" 2>/dev/null || true
  done
  printf '⚠ Não consegui remover o temporário: %s (nada quebrou — apague quando puder)\n' "$WORK" >&2
  return 0
}

# Sobras de instalacoes anteriores: as versoes ate 0.1.73 nao limpavam, e cada
# execucao deixava ~14 MB. Só o que tem mais de uma hora, para nunca puxar o
# tapete de uma instalacao rodando em paralelo.
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'nrv-engine-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nrv-engine-XXXXXX")"
trap cleanup EXIT INT TERM

if [ -n "${NIRVANA_ENGINE_TARBALL:-}" ]; then
  [ -f "$NIRVANA_ENGINE_TARBALL" ] || die "NIRVANA_ENGINE_TARBALL não existe: $NIRVANA_ENGINE_TARBALL"
  say "Engine local: $NIRVANA_ENGINE_TARBALL"
  cp "$NIRVANA_ENGINE_TARBALL" "$WORK/engine.tar.gz"
else
  say "Baixando o engine mais recente…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$WORK/engine.tar.gz" \
      || die "Falha ao baixar o engine. Verifique a internet, ou baixe o .tar.gz e use NIRVANA_ENGINE_TARBALL=…"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$WORK/engine.tar.gz" "$URL" || die "Falha ao baixar o engine (wget)."
  else
    die "Preciso de curl ou wget para baixar o engine."
  fi
fi

mkdir -p "$WORK/src"
# cd + paths RELATIVOS: um path absoluto do Windows (C:\…) tem ":" e o GNU tar do
# Git Bash o trata como host remoto. Relativo funciona em GNU tar e bsdtar.
( cd "$WORK" && tar -xzf engine.tar.gz -C src ) || die "Não consegui extrair o engine (precisa do 'tar')."

# O asset extrai plano (scripts/ na raiz); um archive de source vem embrulhado
# num diretório único. Aceita os dois.
ROOT="$WORK/src"
if [ ! -f "$ROOT/scripts/install.ts" ]; then
  only="$(find "$WORK/src" -mindepth 1 -maxdepth 1 -type d | head -2)"
  if [ "$(printf '%s\n' "$only" | wc -l)" -eq 1 ] && [ -f "$only/scripts/install.ts" ]; then
    ROOT="$only"
  fi
fi
[ -f "$ROOT/scripts/install.ts" ] || die "Asset do engine inválido (sem scripts/install.ts)."

# Sem `exec`: ele substitui o processo e o trap EXIT nunca rodaria, deixando o
# engine extraído (~14 MB) para trás em /tmp a cada instalação.
"$BUN" "$ROOT/scripts/install.ts" "$@"
