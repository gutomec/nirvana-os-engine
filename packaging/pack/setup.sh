#!/usr/bin/env bash
# setup.sh — one-command bootstrap, no prerequisite beyond bash + curl.
#
#   bash setup.sh
#
# Installs Bun (user space, in ~/.bun, WITHOUT sudo) if missing, puts the binary on
# THIS session's PATH (avoids the "open a new terminal" gotcha) and runs the pack's
# setup.ts with that Bun. Idempotent: if Bun already exists, it just runs the setup.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  if [ -x "$HOME/.bun/bin/bun" ]; then echo "$HOME/.bun/bin/bun"; return 0; fi
  return 1
}

BUN="$(find_bun || true)"
if [ -z "${BUN:-}" ]; then
  echo "Bun not found. Installing (user-space, in ~/.bun, no sudo)..."
  if ! curl -fsSL https://bun.sh/install | bash; then
    echo "✗ Could not install Bun automatically."
    echo "  Install it manually and run again:  curl -fsSL https://bun.sh/install | bash && bash setup.sh"
    echo "  NEVER use 'npm install -g bun' (it fails with EACCES in /usr/local)."
    exit 1
  fi
  BUN="$(find_bun || true)"
fi
if [ -z "${BUN:-}" ]; then
  echo "✗ Bun is installed but was not found on the PATH. Open a new terminal and run:  bash setup.sh"
  exit 1
fi

export PATH="$(dirname "$BUN"):$PATH"
exec "$BUN" "$HERE/setup.ts"
