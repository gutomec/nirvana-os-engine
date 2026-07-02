#!/usr/bin/env bash
# setup.sh — bootstrap de 1 comando, sem pré-requisito além de bash + curl.
#
#   bash setup.sh
#
# Instala o Bun (user-space, em ~/.bun, SEM sudo) se faltar, garante o binário no
# PATH DESTA sessão (evita o gotcha de "precisa abrir um terminal novo") e roda o
# setup.ts do pack com esse Bun. Idempotente: se o Bun já existe, só roda o setup.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  if [ -x "$HOME/.bun/bin/bun" ]; then echo "$HOME/.bun/bin/bun"; return 0; fi
  return 1
}

BUN="$(find_bun || true)"
if [ -z "${BUN:-}" ]; then
  echo "Bun não encontrado — instalando (user-space, em ~/.bun, sem sudo)…"
  if ! curl -fsSL https://bun.sh/install | bash; then
    echo "✗ Não consegui instalar o Bun automaticamente."
    echo "  Instale manualmente e rode de novo:  curl -fsSL https://bun.sh/install | bash && bash setup.sh"
    echo "  NUNCA use 'npm install -g bun' (dá EACCES em /usr/local)."
    exit 1
  fi
  BUN="$(find_bun || true)"
fi
if [ -z "${BUN:-}" ]; then
  echo "✗ Bun instalado mas não encontrado no PATH. Abra um novo terminal e rode:  bash setup.sh"
  exit 1
fi

export PATH="$(dirname "$BUN"):$PATH"
exec "$BUN" "$HERE/setup.ts"
