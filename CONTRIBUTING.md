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
- Everything the engine prints, shows or sends to an agent (CLI output,
  errors, `nrv config` descriptions, prompts, the Glance UI): **English**.
  Portuguese stays only as data the engine matches against input (keyword and
  stopword lists, regexes, eval briefs) and in content about Brazil-only law
  or norms. Deliverables follow the language of the request.
- UTF-8 everywhere; never strip diacritics from content.
- Runtime: Bun only — top-level await, `Bun.$`, `bun:sqlite` are used freely.
- Match the style of the file you are editing. Surgical diffs: every changed
  line should trace to the change you are making.

## Working in parallel cuts

A cut (one branch, one agent) verifies its own area and hands back; the whole
is verified once, on the integrated tree, by CI on the three systems and by
whoever merges. That is the same gate charged once instead of once per slice:
the full suite takes minutes, and every cut running it on code nobody has
integrated yet multiplies that for no new information.

The loop, in order of cost:

```bash
bun test <dir>          # while working: the tests of what you touch
bun run test:fast       # whole-repo smell check, the fast files only
bun run check:quick     # the cheap gates, during the work
bun run test:<area>     # once, before handing back (harness, businesses, squads, shared, gate)
bun run test:full       # once, on the integrated tree
bun run check:all       # once, on the integrated tree
```

Every cut names the files it touched, what it did not verify, and the areas
outside its own it suspects it may have broken. A failure of the whole goes
back to the cut that produced it, in that cut's session. Write a large new
file in blocks with the area's tests running between them rather than in one
write.

## Pull requests

1. Fork, branch from `main`.
2. Make the change with tests. A bug fix starts with a test that reproduces it.
3. `bun test` and `bun run check:all` must pass locally — CI runs the same
   suite on Ubuntu, macOS, and Windows.
4. Open the PR. The CLA bot will ask you to sign the
   [Contributor License Agreement](./CLA.md) once — read it first; you keep
   ownership of your contribution and grant the project's Owner a broad
   license to use and relicense it, including under commercial terms (your
   moral rights and authorship remain yours).
5. Changes that alter behavior users see get a line in `CHANGELOG.md` **and**
   `CHANGELOG.pt-BR.md` — a CI gate enforces parity.

## Reporting

- Bugs and feature requests: GitHub Issues.
- Questions and ideas: GitHub Discussions.
- Vulnerabilities: see [SECURITY.md](./SECURITY.md) — not the public tracker.
- Conduct: all community spaces follow the
  [code of conduct](./CODE_OF_CONDUCT.md).
