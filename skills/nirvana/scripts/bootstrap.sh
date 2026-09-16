#!/bin/sh
# bootstrap.sh — install the Nirvana-OS engine from the `nirvana` skill.
#
#   sh bootstrap.sh [--yes] [--dry-run] [--update]
#
# The skill carries no engine. This script puts one on the machine the way
# `npx @nirvana-os/cli` does, without needing Node: it finds or installs Bun in
# user space, downloads the engine release tarball, extracts it and runs the
# engine's own installer (scripts/install.ts --no-starter). Everything after
# that (nrv in ~/.local/bin, the PATH line, audit hooks, runtime links, the
# empty content roots, the registry index) is the installer's job, not this
# file's.
#
# Environment (all optional):
#   NIRVANA_ENGINE_TARBALL   local tarball, used instead of any download
#   NIRVANA_ENGINE_URL       full URL override
#   NIRVANA_ENGINE_REPO      owner/repo (default gutomec/nirvana-os-engine)
#   NIRVANA_BOOTSTRAP_YES=1  same as --yes
#   NIRVANA_SKIP_PATH_PERSIST, NIRVANA_HOME, SQUADS_DIR, BUSINESSES_DIR,
#   DNA_LIBRARY              passed through to the installer untouched
#
# Exit codes: 0 engine present or installed · 2 usage · 3 no consent ·
#   4 missing prerequisite · 5 download failed · 7 installer failed
set -eu

YES="${NIRVANA_BOOTSTRAP_YES:-}"
DRY=""
UPDATE=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --update) UPDATE=1 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bootstrap.sh: unknown option '$a' (accepted: --yes --dry-run --update)" >&2; exit 2 ;;
  esac
done

HOME_DIR="${HOME:-$(cd ~ && pwd)}"
LOCAL_NRV="$HOME_DIR/.local/bin/nrv"
ENGINE_DIR="$HOME_DIR/.nirvana/skills/harness"
REPO="${NIRVANA_ENGINE_REPO:-gutomec/nirvana-os-engine}"
URL="${NIRVANA_ENGINE_URL:-https://github.com/$REPO/releases/latest/download/nirvana-os-engine.tar.gz}"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

# 1. Already here?
if [ -z "$UPDATE" ] && [ -d "$ENGINE_DIR" ] && { command -v nrv >/dev/null 2>&1 || [ -x "$LOCAL_NRV" ]; }; then
  ver="$(cat "$HOME_DIR/.nirvana/skills/VERSION" 2>/dev/null || echo unknown)"
  echo "Nirvana-OS engine already installed (version $ver). Nothing to do; pass --update to reinstall."
  echo "$PATH_LINE"
  exit 0
fi

# 2. What this will change. Printed always, so a dry run and a real run show
# the same list and the user (or the agent on the user's behalf) reads it once.
cat <<LIST
Nirvana-OS bootstrap will change this machine:
  - Bun in user space ($HOME_DIR/.bun) if it is missing, no sudo
  - the engine in $HOME_DIR/.nirvana (skills + shared node_modules)
  - the nrv launcher in $HOME_DIR/.local/bin, plus one PATH line in the shell rc
  - audit hooks in the settings of the agent runtimes it finds (~/.claude, ~/.gemini, ~/.codex, ~/.antigravity)
  - runtime skill links in ~/.claude/skills, ~/.codex/skills, ~/.gemini/skills, ~/.antigravity/skills, ~/.pi/agent/skills, ~/.agents/skills
  - the empty content roots ~/squads, ~/businesses, ~/businesses/_library/dna
  Source: ${NIRVANA_ENGINE_TARBALL:-$URL}
  Reversible with: nrv uninstall --engine
LIST
if [ -n "$DRY" ]; then echo "(dry run: nothing changed)"; exit 0; fi

# 3. Consent. An agent's shell is not a TTY, so without --yes this stops here
# and the agent has to come back with the user's go-ahead.
if [ -z "$YES" ] && [ -t 0 ]; then
  printf 'Proceed? [y/N] '
  read -r ans
  case "$ans" in y|Y|yes|YES|s|S|sim|SIM) YES=1 ;; esac
fi
if [ -z "$YES" ]; then
  echo "No consent given. Re-run with --yes (or NIRVANA_BOOTSTRAP_YES=1) to install." >&2
  exit 3
fi

# 4. Prerequisites.
command -v tar >/dev/null 2>&1 || { echo "tar not found; install it and re-run." >&2; exit 4; }
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "neither curl nor wget found; install one and re-run." >&2; return 4; fi
}

# 5. Bun, found or installed in user space (never `npm install -g bun`: EACCES
# in /usr/local; never `bunx @nirvana-os/cli`: its bin has a node shebang).
find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  if [ -x "$HOME_DIR/.bun/bin/bun" ]; then echo "$HOME_DIR/.bun/bin/bun"; return 0; fi
  return 1
}
BUN="$(find_bun || true)"
if [ -z "$BUN" ]; then
  echo "Bun not found; installing in user space ($HOME_DIR/.bun, no sudo)..."
  if command -v curl >/dev/null 2>&1 && curl -fsSL https://bun.sh/install | bash; then
    BUN="$(find_bun || true)"
  fi
fi
if [ -z "$BUN" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "Bun could not be installed; falling back to npx @nirvana-os/cli (Node)."
    exec npx -y @nirvana-os/cli
  fi
  echo "Bun could not be installed and Node is absent. Install Bun and re-run:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 4
fi
PATH="$(dirname "$BUN"):$PATH"; export PATH

# 6-7. The tarball, extracted with RELATIVE paths: an absolute Windows path
# carries a ":" and the GNU tar of Git Bash reads it as a remote host.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nrv-engine-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
cd "$WORK"
local_tb="${NIRVANA_ENGINE_TARBALL:-}"
local_tb="${local_tb#file://}"
if [ -n "$local_tb" ]; then
  [ -f "$local_tb" ] || { echo "NIRVANA_ENGINE_TARBALL not found: $local_tb" >&2; exit 5; }
  cp "$local_tb" engine.tar.gz
else
  echo "Downloading $URL ..."
  if ! fetch "$URL" engine.tar.gz; then
    echo "Download failed. Behind a proxy or offline? Fetch the tarball by hand and re-run with NIRVANA_ENGINE_TARBALL=/path/to/nirvana-os-engine.tar.gz" >&2
    exit 5
  fi
fi
mkdir -p src
tar -xzf engine.tar.gz -C src
ROOT="$WORK/src"
if [ ! -f "$ROOT/scripts/install.ts" ]; then
  # The release asset extracts flat; a source archive comes wrapped in one dir.
  for d in "$ROOT"/*/; do [ -f "${d}scripts/install.ts" ] && ROOT="${d%/}"; done
fi
[ -f "$ROOT/scripts/install.ts" ] || { echo "Invalid engine asset (no scripts/install.ts)." >&2; exit 5; }

# 8. The engine's own installer, run from HOME so its post-install index builds
# the GLOBAL registry (from inside a project it would anchor to <project>/.nirvana/).
cd "$HOME_DIR"
unset NIRVANA_PROJECT_ROOT
if ! "$BUN" "$ROOT/scripts/install.ts" --no-starter; then
  echo "The engine installer failed (see above)." >&2
  exit 7
fi

# 9. Work dirs left by interrupted runs, older than one hour.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'nrv-engine-*' -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true

echo
echo "Nirvana-OS engine installed. New shells find nrv on PATH; for this one:"
echo "$PATH_LINE"
