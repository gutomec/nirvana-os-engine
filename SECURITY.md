# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.** Public disclosure before a
fix puts every user at risk.

Report privately through GitHub's **[private vulnerability reporting](https://github.com/gutomec/nirvana-os-engine/security/advisories/new)**
(Security tab → "Report a vulnerability"). If you cannot use that channel, reach
the maintainer via the profile at https://github.com/gutomec.

Please include: the affected version (`nrv --version`), your OS/runtime, a
minimal reproduction, and the impact you observed.

## What to expect

- Acknowledgement within a few days.
- An assessment and, for confirmed issues, a fix in a patch release with a
  `CHANGELOG.md` entry crediting you (unless you prefer to stay anonymous).
- Coordinated disclosure — we agree on a public date once a fix ships.

## Scope

In scope: the engine (`skills/`, `scripts/`, `bin/`), the npm launcher
(`@nirvana-os/cli`), and the publish/install pipeline.

Out of scope: third-party runtimes the engine installs into (Claude Code, Codex,
Gemini, Antigravity — report to their vendors), and paid pack content (report via
the purchase channel at squads.sh).

## Supported versions

Only the latest published release receives security fixes. Run
`npx @nirvana-os/cli` (or `nrv update`) to stay current.
