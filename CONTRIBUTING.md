# Contributing to Nirvana-OS

Development happens here, in the open. Pull requests merge into `main` and ship
in the next release — this repository is the source of truth for the engine, not
a mirror.

> Repository history starts in August 2026, when the engine went public-primary.
> Earlier development happened in a private monorepo whose history also contains
> commercial content and cannot be published.

## What lives here (and what does not)

This repository is the **engine**: the harness orchestrator, the `nrv` CLI, the
squad/business/mind-clone lifecycle skills, tests, and CI gates. It ships
content-free by design — a CI gate fails the build if any squad, business, or
mind-clone content lands here.

Content (squads, businesses, mind-clone libraries, paid packs) is commercial and
lives elsewhere. Issues about content are welcome; content itself cannot be
contributed here.

## Setup

The engine is Bun-native. Node, npx, and tsx will not run it.

```bash
curl -fsSL https://bun.sh/install | bash   # macOS / Linux
bun install
bun test                                    # full suite
bun run check:all                           # repo contract gates
```

`bun scripts/install.ts` installs your working copy as the live engine
(`~/.nirvana/skills`) if you want to test end to end; `nrv update` restores the
released version.

## Conventions

- Code, comments, identifiers, commit messages: **English**.
- User-facing runtime strings: localized (PT-BR is the default locale).
- UTF-8 everywhere; never strip accents from localized text.
- Runtime: Bun only — top-level await, `Bun.$`, `bun:sqlite` are used freely.
- Match the style of the file you are editing. Surgical diffs: every changed
  line should trace to the change you are making.

## Pull requests

1. Fork, branch from `main`.
2. Make the change with tests. A bug fix starts with a test that reproduces it.
3. `bun test` and `bun run check:all` must pass locally — CI runs the same
   suite on Ubuntu, macOS, and Windows.
4. Open the PR. The CLA bot will ask you to sign the
   [Contributor License Agreement](./CLA.md) once — read it first; it assigns
   the economic rights in your contribution to the project owner (your moral
   rights and authorship remain yours, and you keep a full license to your own
   work).
5. Changes that alter behavior users see get a line in `CHANGELOG.md` **and**
   `CHANGELOG.pt-BR.md` — a CI gate enforces parity.

## Reporting

- Bugs and feature requests: GitHub Issues.
- Questions and ideas: GitHub Discussions.
- Vulnerabilities: see [SECURITY.md](./SECURITY.md) — not the public tracker.
