# Changelog

**Read this in your language:** [English](./CHANGELOG.md) · [Português](./CHANGELOG.pt-BR.md)

All notable changes to the Nirvana-OS engine. Versions map to GitHub releases
(`nirvana-os-engine`); each release ships the full engine tarball that
`npx @nirvana-os/cli` and pack installs consume.

## 0.4.0 — 2026-08-14

### A license could only be installed by reinstalling the pack

A buyer on Windows ran `nrv update genesis-circle` and got "Sem PROVENANCE com
license_key". The message named both paths it had searched — that part worked —
and then told them to re-run `bun setup.ts`, the entire pack installer, to copy
one small file. That was the only route: the copy lives inside setup.ts and
nowhere else.

`nrv license install` is the missing command. With no argument it looks where a
downloaded pack actually sits: the current directory, Downloads, Desktop, home,
and one level into any subdirectory whose name mentions nirvana or pack. With an
argument it takes a file or a folder, because a folder is what people paste.
`LICENSE.txt` rides along when it sits beside it.

Verification runs after the copy and never blocks it. A provenance that fails
signature checking is still the file the buyer paid for, and telling them it is
unsigned is more useful than refusing to move it.

## 0.3.9 — 2026-08-14

### The leak guard now follows the engine instead of remembering it

Removing the committed run artifacts left a gate that named three paths from
memory — `outputs/`, `.nirvana/`, `.harness-logs/`. A list like that goes stale
the day someone changes where a run writes, and the leak it would miss looks
exactly like the one it caught.

The guarded set is now asked of the engine's own resolvers (`outputsDir`,
`harnessLogsDir`), with those three as a floor if resolution ever fails. Moving
an output directory cannot silently unguard it: a test derives the same paths
and fails until `.gitignore` follows. Another checks that plain `git add` is
refused without `--force`, because the cheapest guard is the one that stops the
mistake being made at all.

### Run artifacts were committed into the engine

`outputs/` was never gitignored, so nine files from a dispatch run reached the
public repo in #4: a brief, a HANDOFF, a business's deliverables, a generated
report. Nothing secret — no credentials, no paid content, no watermarks — but
the trace of *using* the engine is not the engine, and it does not belong in a
repository other people read to understand the product.

`outputs/` is ignored now, the nine are untracked (still on disk, since they are
the provenance of the published CLA), and `check-engine-purity` fails on any
tracked file under `outputs/`, `.nirvana/` or `.harness-logs/`. It reads the git
index rather than the disk, so a developer's local run is left alone and only a
committed one fails.

They remain in history: the content is not sensitive, and rewriting a public
repo's history to erase noise costs more than the noise.

## 0.3.8 — 2026-08-13

### The cockpit was still advertised by the hooks installer

`nrv glance` was dropped from the engine installer's closing screen, but the
hooks installer closes from a different file and still pointed at it. The
cockpit is unfinished; an install should not send a new user to the weakest
surface. The guard now checks every `console.log` across both installers, so a
mention in a comment stays allowed and one in printed output does not.

### A 5xx killed runs the header promised to retry

`quota-detector` has documented since day one that a 5xx classifies as
`transient` — recoverable, retry the same runtime. No rule ever implemented it.
Every 5xx fell through to `error`, which the cascade treats as fatal: it emits
`runtime_error` and gives up, where `transient` sleeps and retries.

Found by a real incident: an Anthropic **529 Overloaded** killed a dispatch that
would have succeeded seconds later. The agentic orchestrator recovered by
reasoning about the error in prose — it checked nothing had been written, closed
the run `failed` with the reason, and redispatched from scratch. The scripted
path had nothing to reason with.

5xx now classifies as transient across every runtime, and conservatively: a bare
"529" could be a line number, so a status code counts only next to
status-shaped context, while the word "overloaded" is accepted alone because no
provider uses it for anything else. The runtime tables keep first say — a 503
that a provider uses to mean "your plan is spent" stays `quota_exhausted`,
because that needs a cooldown and a handoff, not a retry against the same wall.

### A Hermes-only skill was offered to every runtime

Installing OpenClaw and running `openclaw skills list` showed `nirvana-os-hermes`
as ready. It is not in the skills root: OpenClaw scans six levels deep and found
it under `_shared/adapters/hermes/`, which the installer links into every
runtime. Its own description asks other runtimes to ignore it — prose enforces
nothing. It is now gated on the `hermes` binary, so it disappears where Hermes is
absent.

The gate cannot express "which runtime am I" — OpenClaw offers binary, config and
OS gates only — so on a machine that has Hermes installed and OpenClaw running,
both variants still appear and the description is what remains.

The `nirvana-os` skill also shipped with no gate at all, visible on machines that
cannot run a line of it. It requires `bun` now, like the other three.

### OpenClaw

Nirvana now installs into `~/.agents/skills`, the personal skills root OpenClaw
reads, and the three skills carry a `metadata.openclaw` gate requiring `bun` —
without it the skill would appear on a machine that cannot run a single one of
its scripts.

Two facts about that runtime change how the system behaves there, and the
adapter (`_shared/adapters/openclaw.md`) documents both. It has **no in-process
subagent**: work is delegated with `bash background:true` to a child CLI, tracked
with `process poll`, and the child announces its own completion. That is exactly
what `nrv dispatch --exec` already does, so the scripted path is the dispatch
there rather than a fallback. And it reads **no project instruction file** — no
CLAUDE.md or AGENTS.md equivalent — so activation rests entirely on the skill's
description, and the run-ledger supervisor is what covers a worker that dies
before announcing anything.

The skill's compatibility line used to claim that a runtime whose spawn is
fire-and-forget "cannot run the cascade". That stopped being true when dispatch
became notification-collected, and it was never true for a runtime that offers a
pollable handle instead.

### Three things about notifications, learned by getting them wrong

A live test dispatch notified with a garbled `<result>` and nothing on disk. Read
as final, that is a failed delivery. Minutes later the same dispatch notified
again — clean report, file written. The work had been arriving the whole time.

So the protocol now says what a notification means. It fires each time a target
stops with no live background child, which means **one dispatch can notify more
than once**: a `<result>` that looks truncated, garbled or contradicts the disk
reads as *not finished yet*, never as failed. **`<result>` is a report, not
proof** — the harness can neutralise output that looks like instructions, and a
report can simply be optimistic; what proves delivery is Phase 6 reading the
disk. And **an honestly reported blocker is the system working**: record it,
close the run failed with the reason, and do not re-dispatch the same brief
hoping for a different wall.

### Blocking the session was the wrong price for getting results back

Earlier today the protocol was changed to dispatch synchronously
(`run_in_background: false`), because a real run showed 13 dispatches returning
"Async agent launched successfully" and no work. That reading was half right: the
receipt is indeed not the result, but the result was never missing. It arrives in
the `<task-notification>` the runtime delivers when a target finishes, carrying
`<result>` with the full report. Twenty-four of them had arrived in that same run
and none had been acted on.

Mandating synchronous dispatch did return the work in the tool result — by
blocking the session for the entire run. A 45-minute deploy stack left the owner
unable to say a word: a question typed meanwhile sat queued, unread, behind work
it was not about.

So dispatch is background again, which is the default and does not block. What
changed for good is the rule that was always missing: the receipt is not the
result, the result comes from the notification, and a notification noticed and
not acted on is the same failure as a receipt mistaken for work. Filesystem
polling stays banned, and a dispatch still gets no timeout — a target killed at
an arbitrary deadline is work thrown away.

## 0.3.7 — 2026-08-13

### Adopting Nirvana in a project you already had did not wire it

`nrv init` writes the contract as AGENTS.md + CLAUDE.md + GEMINI.md so every
runtime family finds one. For a file that already existed it kept the user's
rules and appended only the *writing* contract — which left the most common case
of all without the *invocation* contract, the part that tells a runtime to
orchestrate. AGENTS.md received it, and Claude Code does not read AGENTS.md. A
user with a pre-existing CLAUDE.md ran init, saw "ok", and went on getting inline
answers: no dispatch, no gate, no audit.

Both blocks are now appended under their own markers, with the user's rules
untouched above them and a second run changing nothing.

### The orchestrator repairs the project instead of reporting it

Nobody drives this system by typing `nrv`. People talk to Claude Code, Codex,
agy or Hermes, and that CLI runs the commands. So an uninitialised project is not
a user error to report — it is a one-line repair the orchestrator performs,
because the orchestrator is the one holding the shell. Phase 0 is now a
preflight: no contract file present, run `nrv init .`, say so in a line, carry
on. It asks first only when the directory is somebody else's repository, where
three new files would land in their diff.

### The heartbeat test flaked because it asserted the opposite of the design

`driver — heartbeat sidecar` failed roughly one CI run in three, on macOS and
Windows both, and blocked three pull requests in a row. It checked that the last
heartbeat looked stale at the moment the test read it — but the sidecar renews
the lease on ANY new output, and the child's final result JSON is new output.
Whether the heartbeat looked stale depended on where a 250ms poll happened to
land relative to that write.

Renewing on the final write is correct behaviour, so the assertion was wrong,
not the timing. An earlier attempt to fix it by exiting the fake child sooner
only narrowed the window: the bytes are already in the capture file by then.

The property it wanted — the sidecar stopped renewing during the stall — is
proven outright by the `x_ledger_stall_observed` event, emitted once with the
measured gap. Against 2.2s of silence and a 1.2s budget the sidecar gets about
eight polls to notice it. Nothing left to race.

### The install taught the wrong first step

The engine installer ended with a flat list of four commands, `nrv init` last and
`nrv glance` above it. The pack installer was worse: "open any AI CLI you use and
just talk to it" — which is precisely the inline path, taught to a buyer on their
first run, in whatever directory they happened to be standing in.

`nrv init` writes the contract (AGENTS.md / CLAUDE.md / GEMINI.md, one per
runtime family) that tells an AI CLI to orchestrate through Nirvana-OS. Without
it a brief is answered inline by a single agent: no dispatch to the businesses
and squads the user installed, no quality gate, no audit trail. Nothing errors —
they just get a worse product and no way to know why.

Both installers now lead with `nrv init`, show it for a new directory and for an
existing one, and state that consequence in those words. `nrv glance` is gone
from both: the cockpit is unfinished, and a first screen should not point at the
weakest surface.

## 0.3.6 — 2026-08-13

### An uninitialised project degraded silently

`nrv init` writes AGENTS.md + CLAUDE.md + GEMINI.md so every adapter finds one,
and whichever the runtime reads carries the instruction to invoke Nirvana
"regardless of skill activation". A project with none of them still orchestrates
once the skill is active — the skill carries the protocol, and the dispatch
instruction now carries the build and writing rules — but nothing tells the
runtime to reach for the skill in the first place, so a brief can be answered
inline with no dispatch, no gate and no audit trail.

`nrv doctor` now names it, checking all three filenames rather than any one
runtime's, and only when the working directory actually looks like a project.

### Build rules reached only Claude Code projects

The four rules that keep an agent from over-building — think first, minimum that
solves it, surgical changes, verifiable done — lived only in the project contract
`nrv init` writes. Two independent ways to miss them: most projects never run
`nrv init`, and the file a runtime reads differs across the eight adapters
(`AGENTS.md` for antigravity/codex/grok/kimi/pi, `CLAUDE.md` for claude-code,
`GEMINI.md` for gemini-cli). Anything depending on a project file is unreliable
twice over.

They now travel with what is always present: the dispatch instruction for the
entity that builds, the skill itself for the orchestrator. A test walks every
adapter and fails if one declares a contract file `nrv init` does not write, so
no runtime can be silently left without a contract.

### Prose was judged by a rule it never received

The writing contract lives in a project's `CLAUDE.md`/`AGENTS.md`, written there
by `nrv init` — which most projects never run. The quality gate judges every
`.md` and `.txt` against it regardless, so a subagent could be failed on a rule
nobody had given it. Seen live: a report came back with 38 em-dashes against a
budget of 12 and had to be rewritten after the fact.

The dash budget is the one that gets missed, because it is quantitative and
nobody counts while drafting. So the contract now travels inside the dispatch
instruction itself, together with the command that checks it — and the entity
runs that check before handing work back, not after the gate rejects it.
Catching it there costs a re-read; catching it at the gate costs rewriting a
finished document.

### The gate waited for the slowest sibling

Phase 6 opened with "Before declaring done, run TWO checks in order". For one
target that reads fine; for a wave it means nothing gets checked until everything
is home. Measured on a real run: one target returned at 04:51:15, its sibling at
05:05:27, and both were gated in a single loop at 05:06 — the first target's
output sat fourteen minutes unverified.

The wall clock is the small part. A failure found late cannot be fixed
concurrently: a revision that could have run alongside its still-working
siblings becomes another serial round. The gate is now anchored to a target
handing back its work, per target, before the next dispatch goes out.

## 0.3.5 — 2026-08-13

### Dispatched work never came back

The protocol's dispatch examples never passed `run_in_background: false`, and the
subagent tool defaults to background. So every dispatch returned "Async agent
launched successfully" — a launch receipt — and the orchestrator, which the
protocol tells to wait for the return, had nothing to wait for.

Measured on a real 13-target run: 13 dispatches, 13 launch receipts, zero
results. What the orchestrator did instead was scan the output directory with
`find` and `ls` to guess which targets had finished, prod them with follow-up
messages, run the quality gate on whatever files it happened to notice, and
close ledger runs on the strength of a directory listing. Nine hours of wall
clock, much of it polling.

Everything downstream of a dispatch assumed a result that was never arriving: a
business reads the handoff artifact to choose its next employee, a workflow
phase consumes the previous phase's output, and the gate is supposed to judge
what a target reported. All three were reading the floor instead.

Dispatch is now synchronous across the three pillars, parallelism is defined as
what it actually is (one message carrying several calls, which the runtime runs
concurrently and returns together), background is named as the exception that
costs you the return, and polling the filesystem for completion is forbidden in
the words the failure produced. `check:dispatch` fails the build on any dispatch
example that would fire and forget — the gate found three more in the runtime
adapter that this changelog entry would otherwise have missed.

## 0.3.4 — 2026-08-12

### The engine is now developed in the open

This repository stopped being a force-pushed mirror and became the place where
the engine is developed. History is permanent from `63e4f4c` on: pull requests
merge here, releases are tagged here, and CI builds the release tarball from
the public tree — the same leak and watermark gates, now running where everyone
can see them. `main` rejects force-pushes for everyone, admins included.

Contribution machinery arrived with the flip: CONTRIBUTING.md, SECURITY.md
(prompt injection and audit-chain forgery explicitly in scope), CODEOWNERS, a
CLA bot, and the cross-OS test matrix now running on pull requests from forks —
without secrets, by construction.

### The CLA is a license, not an assignment

The Sustainable Use License always required contributions to come with a CLA;
the published agreement transferred ownership of each contribution to the
project owner. It now follows the Apache ICLA model instead: contributors keep
ownership and grant a perpetual, worldwide, irrevocable, royalty-free,
sublicensable license, including the explicit right to relicense under
commercial terms — the freedom the project needs, without taking anyone's work.
A patent grant with defensive termination is new; moral rights remain
inalienable under Brazilian law. The switch happened while the CLA had zero
signatures, so no contributor is left under the old terms.

### Update backups no longer pile up

`nrv update` backed up the skills tree on every run and never deleted anything:
a machine that updated eleven times carried eleven full copies (~50MB) that
nothing would ever read again. The update now keeps exactly one backup — the one
it just made — and prunes the rest, only after the installer has succeeded, so a
failed update never loses the copy that could still rescue it.

`nrv doctor` also gained a litter check: a `*.bak` entry inside a runtime skills
directory is loaded as if it were a skill (a stale pre-migration copy was found
live, sitting next to the real one), and more than one `skills-backup-*` means
the prune is not running. Both now surface as warnings instead of accumulating
in silence.

## 0.3.3 — 2026-08-10

### Work an agent dispatched could end in silence

The never-stall guarantee had a hole, and the hole sat exactly where most work
happens. `nrv dispatch --exec` opens a row in the run-ledger, heartbeats while
the child runtime works, and the supervisor sweeps expired leases every two
minutes, so a scripted run that dies gets resumed and a human gets told. An
agent orchestrating the same brief inside its own session opened nothing at all.
It emitted the audit events, dispatched the squads, ran the gate, and left the
ledger empty, so the supervisor had nothing to find and nobody learned that the
work had ended.

One project showed the whole shape of it: 11 `brief_received`, 5
`dispatch_squad`, 8 `gate_passed`, zero ledger rows, zero notifications. The
agent had followed the protocol faithfully. The protocol was at fault, in a
single sentence that scoped the promise to "every scripted dispatch" and then,
three clauses later, guaranteed "never forgotten" without qualification.

Coverage is now a side effect of dispatching instead of something an agent has to
remember. `brief-squad.ts` and `brief-business.ts` are prep steps the
orchestrator must run anyway; they now open the ledger run exactly as they
already emit `dispatch_squad`, and they print the run id together with the
command that closes it. `nrv run-track` is the door for everything else: `open`
for an `agent-x` dispatch, which has no prep script; `beat` to renew a lease
across a long stretch of thinking; `close` to record `delivered`, `withheld` or
`failed`. Closing fires a desktop notification, which is the part the owner
actually wanted, because they are not watching the terminal doing the work.

The supervisor learned that an agentic run is not a scripted one. There is no
session to resume and no prompt to relaunch, and the only pid in reach belongs to
the user's own session rather than to a child of ours, so the ledger deliberately
records none and the sweep never signals it. It reads file activity as proof of
life instead: a run still writing gets its lease extended, and a run gone quiet
escalates straight to salvage, where the artifacts on disk go once through verify
and the quality gate so the human is told what was found and whether it passed.
Long runs also report in every thirty minutes (`NIRVANA_PROGRESS_PING_SEC=0`
silences that).

Desktop notification reached one platform before this and now reaches three:
macOS through osascript, Linux through notify-send, Windows through a PowerShell
balloon that needs nothing installed.

## 0.3.2 — 2026-08-10

### Windows could not start an agent CLI at all

CreateProcess only auto-appends `.exe`, never `.cmd` — and every agent CLI
installed through npm IS a `.cmd`. The driver spawned the bare name, so the
invocation died while `where` happily reported the runtime as available: the
probe said yes, execution said no, and a Windows buyer could not dispatch
anything. The installer had learned this rule long ago and written it in a
comment; the agent driver never received it.

`resolveExecutable()` now routes a `.cmd`/`.bat` through a shell (the only way
to start one) and spawns a real `.exe` directly, with `quoteForCmd()` protecting
arguments a shell would otherwise eat — a temp prompt file lands under a user
profile, and plenty of those contain a space. `whichSync` scans `.cmd`/`.bat`
too; it only tried `.exe`, so it reported "not installed" for a runtime sitting
right there. Applied at the three places that start a CLI, one of which is the
choke point for all sixteen runtime adapters. On POSIX every part of this is the
identity: same command, same args, no shell.

The test harness had quietly opted out of the engine's own architecture. The
fake CLIs were `#!/bin/bash` and `#!/bin/sh` scripts, which Windows resolves
neither by name nor by shebang, so 38 tests failed there while saying nothing
about the product. Every fake is now a Bun/TypeScript body with a one-line
per-OS launcher; on Windows they land as `.cmd`, the same shape npm gives a real
CLI, so the driver's new handling is exercised rather than assumed.

Three portability defects surfaced underneath: tests joined PATH entries with
`:`, which separates nothing on Windows; four fixtures relocated `HOME` while
`os.homedir()` follows `USERPROFILE` there; and `doctor-system` read
`os.homedir()` directly while the rest of the engine honors `NIRVANA_HOME`
first, so with that variable set it diagnosed a different home than the engine
was using and reported everything as fine.

The full matrix is green for the first time: Windows, macOS, Ubuntu and the
contract gates, with `nrv doctor` on Windows at 30 checks, 0 failures, and the
npx tarball bootstrap passing there.

## 0.3.1 — 2026-08-09

### A runtime probe that answered about the wrong PATH

`runtimeAvailable()` decides whether a CLI exists before the cascade tries it,
and it spawned its `which` probe without passing `env`. Under Bun that means the
environment captured at PROCESS START, not the current `process.env` — while the
actual invocation spawns with `env: {...process.env}`. Probe and invocation could
therefore disagree: a runtime added to PATH during the run reads as unavailable
while being perfectly invocable, and the cascade skips a platform that works.

Found by the release's own CI. The failover suite passed on a machine that
happens to have the real `gemini` and `agy` binaries installed and failed on
Linux, which has neither — meaning the test shims it believed it was exercising
were never being reached. Both probes (`runtimeAvailable` and `whichSync`) now
pass `env` explicitly, and a regression test asserts the probe follows a PATH
mutation, using a binary name no machine is likely to have.

## 0.3.0 — 2026-08-09

### BREAKING: a broken credential no longer costs the whole run

A live matrix (the same brief across all six installed platforms) caught Google
retiring the individual tier of `gemini-cli`: the CLI authenticates and is then
refused, with `IneligibleTierError` pointing at Antigravity. Five platforms
delivered; the sixth died, and it exposed three defects of ours behind the
external one.

**`IneligibleTierError` matched no pattern in the classifier.** The auth regex
demanded `authentication failed`, and the real text says `Error authenticating:`.
The verdict came back a generic `error`, and a generic error does not rotate: the
run ended with a healthy runtime sitting in the next cascade entry. The retired
tier is now recognized, and the hint names `agy` rather than telling the user to
log in again — nobody re-authenticates their way out of a retired tier.

**`auth_failed` now rotates.** The policy used to be to stop and hand the error
back to the caller, on the argument that an invalid credential is the user's
problem. The argument still holds for the diagnosis, not for the work: the
runtime now takes a short cooldown (15 min) and the cascade moves to the next
entry, exactly as it already did for quota. The `runtime_auth_failed` event stays
in the audit with its hint — moving on does not hide the broken credential. The
cooldown is per runtime, not per entry, because another model on the same CLI
uses the same credential and would fail identically.

**The router picks its runtime per attempt.** `routeOnce` closed over a single
choice, so the ladder's "retry once" hit the same dead CLI: the router failed
twice and the brief fell through to agent-x with no specialist — routing quality
lost to somebody else's outage. Now a transport failure whose cause is the
runtime itself marks a cooldown, and the next attempt routes through a live
platform.

### `nrv install --dry` no longer installs for real

`--dry` was honored only by the starter-pack sync and the hermes config. The
other four phases ignored the flag: a "preview" copied the skills tree over the
installed one, reinstalled dependencies, relinked every runtime, rewrote the
hooks and appended the smoke sentinel to the audit log. Anyone running it to
inspect an upgrade before deciding had already taken it. Each phase now guards on
the flag and prints what it would do; the hook installer runs in its own
`--check` mode. Verified on a real system: skills tree, settings and audit log
all unchanged after a `--dry`.

### `nrv` tells you when a newer engine exists

`nrv update` has always worked, but nothing ever said an update was there. A user
who never typed the command stayed on their install forever, including through
fixes that decide whether a run delivers or dies. The changelog reached whoever
went looking; everyone else never heard.

One line on stderr, before the command, only when a newer release actually
exists. The constraint that shaped the design: every subcommand ends in `exec`,
so there is no "after the command" to hook, and the notice must not cost the CLI
any latency. It therefore reads a three-line cache file with shell builtins and
no subprocess, while the network refresh runs detached and benefits the NEXT
invocation. The timestamp lives inside the file rather than in its mtime, which
`stat` reads differently across macOS and Linux and which rsync and restores
rewrite. Silence is the failure mode: no network, a rate limit, a corrupted
cache, an unwritable directory — each produces no message, never a broken
command. Opt out with `NIRVANA_NO_UPDATE_CHECK=1`; `CI` is honored automatically.
`nrv update-check --status` reports the state.

### A fresh install's first `nrv index` no longer fails

The engine ships content-free by design, so a new install has zero businesses,
squads and clones. The digest builder treated "zero entries" and "could not
parse the registry" as the same condition and exited 1 with "run `nrv index`
first" — advice for the command the user had just run. `nrv doctor` then
reported three critical failures on a machine where nothing was wrong.

Only an unreadable registry is a failure now; an empty one gets a valid empty
digest and a line saying so. Measured on a fresh install from the release
tarball: `nrv index` goes 4/4 ok, and the doctor drops from 3 criticals to 2
warnings (no runtime configured, nothing dispatched yet — both true).

### The CLI parity gate stops inventing commands

`check-cli-parity.ts` scanned all of `bin/nrv` for 2-space-indented lines
containing a `)`, so a comment with a parenthesis or a `case` inside a helper
function counted as a subcommand. Adding the update notice made the release
build fail with eight commands that do not exist. The scan is now anchored on
the column-0 `case "$cmd" in … esac` dispatch block, where the commands actually
live, so the file can grow helpers without the gate hallucinating.

### The error you see is the cause, not the CLI's first warning

The failure recorded in the ledger and shown to the user was
`"YOLO mode is enabled. All tool calls will be automatically approved."` — a
benign warning the CLI prints before anything else. The real cause sat buried
under twelve lines of `Skill conflict detected` and a stack trace.

The eleven places where an adapter built the error message (nine runtimes plus
the two low-level envelopes) took the first 500 bytes of stderr. They now extract
the line carrying the cause, wherever it is: known noise is dropped, and lines
with signal beat position. This matters beyond looks — in the low-level envelopes
`error` is the only text the classifier ever sees, and enough chatter pushed the
cause out of the window entirely.

### `nrv doctor` flags skills visible through two paths

Runtimes that read both the convention directory (`~/.agents/skills`) and their
own (`~/.gemini/skills`, …) load the same SKILL.md twice and log
`Skill conflict detected` for every skill. Nothing breaks — both paths resolve to
the same file — but the warning reads like a real problem. The doctor now
compares by realpath (a directory reachable under two names is not two
directories), names which directories duplicate, and notes that `~/.agents/skills`
is not created by this engine.

### `bun test` at the root no longer reports pack failures

`dist/` holds built packs whose squad templates carry their own tests, with their
own dependencies — installed in the buyer's project, not here. Scanning that
directory made a bare `bun test` report 55 phantom failures. `bunfig.toml` now
scopes the scan to the engine: 624 tests, 0 failures.

### BREAKING: `nrv revise` delivers through the pipeline, and the exit codes change

`revise.ts` carried its own copy of verify and gate: a 200-byte floor, a gate
covering only `.md`/`.txt`/`.json`, and an `allPass` variable initialized to
`true` before a loop that could run zero times. A revision producing only
`.html`, a PDF or an image was judged by nothing and still emitted `delivered`
with `gate:"pass"` and exited 0. A genuinely failed gate also emitted `delivered`
(with `gate:"fail"`) before exiting 1. It was the same fail-open that Phase 4
closed in dispatch, alive in precisely the route the WITHHELD delivery message
points users to.

`nrv revise` now calls the same `runDelivery()` as dispatch and the supervisor:
verify (with `verify-deliverable.ts` when a manifest exists), gate over EVERY
gateable artifact, and a delivered | withheld | indeterminate decision.

| exit | meaning |
|------|---------|
| 0 | revised and DELIVERED — gate passed |
| 1 | failed — runtime error, or no verifiable deliverable |
| 2 | delivery WITHHELD — gate failed after the revision budget |
| 3 | INDETERMINATE — no artifact the gate knows how to judge |
| 4 | invalid arguments (was 2, which became the withheld code) |

The revision budget for `nrv revise` comes from config
(`quality_gate.max_revisions`), because that iteration belongs to the human. When
the caller is the supervisor (`NRV_IN_SWEEP=1`), the budget drops to zero: the
sweep runs under launchd every 120s with nobody watching, and spending LLM on a
revision loop there is money with no owner. The verdict goes back to the
supervisor, which withholds and escalates.

### The supervisor judges what the redispatch produced

After a successful redispatch, the supervisor ran its own verify and gate and
returned `delivered` with "gate indeterminate" whenever the run had produced only
`.html`, a PDF, an image or code. Delivered without a single rubric having run.
The redispatch result now goes through `runDelivery()`, and resume reads the exit
code of `nrv revise` instead of looking for "gate FAIL" in the output text.

Two decisions worth recording. The redispatch does not get the completeness
ceiling: the run finished under the supervisor's control, unlike salvaging an
interrupted run, and applying the ceiling would make automatic recovery useless,
since most runs have no manifest. And it runs with zero revisions, by the same
budget rule above.

### A runtime error no longer abandons what was already produced

A real run (`proj-20260809T050140-content-creation`) delivered a guide in md,
html, PDF and images — and still ended as `failed`, with the artifacts forgotten
on disk: no verify, no gate, no delivery decision. Cause: the runtime returned an
error verdict at the end of the run (usage limit), and dispatch exited 1 without
looking at the output directory.

A non-ok run now looks for artifacts with the SAME discovery the delivery
pipeline uses. With no artifact, nothing changes (`failed`, exit 1). With
artifacts, the run enters the same pipeline — verify → gate → revision budget →
delivered | withheld | indeterminate. The runtime error stays visible: an
`x_runtime_errored_with_artifacts` audit event, `last_error` preserved and
`meta.runtime_errored` in the ledger through the terminal row, and an explicit
warning in the terminal. The fail-closed contract did not loosen: an artifact
from a failed run that fails the gate is still WITHHELD (exit 2).

The ledger state machine gained the `failed → verifying` edge — the salvage path,
which does not redispatch because the work already exists.

### `nrv dispatch` without `--exec` exits 3, not 0

`nrv dispatch --auto "<brief>"` without `--exec` exited 0 having dispatched
nothing. Since 0 means DELIVERED, a `nrv dispatch … && publish` published a run
that never executed. Scaffolding delivers nothing and judges nothing: it now
exits 3 (INDETERMINATE) on all three paths — business, squad-only and agent-x.

| exit | meaning (updated) |
|------|-------------------|
| 0 | delivered — gate passed, or `--force-deliver` |
| 1 | run failed — routing, execution or verification |
| 2 | delivery WITHHELD — gate failed after revisions |
| 3 | INDETERMINATE — nothing was judged: zero gateable artifacts, **or scaffold without `--exec`** |
| 4 | invalid arguments |

## 0.2.0 — 2026-08-07

A big release: the engine stops depending on discipline to keep its promises.
Three new guarantees — never stall, never deliver without a gate, never abandon a
brief — plus routing that works in any language.

### BREAKING: `nrv dispatch` exit codes — delivery is now fail-closed

A failed gate used to carry on and end the run at exit 0 with a `delivered`
event. That is over. Anyone with a script checking for `exit 0` needs the new
contract:

| exit | meaning |
|------|---------|
| 0 | delivered — gate passed, or an explicit `--force-deliver` (audit `delivered` with `gate:"fail-forced"`) |
| 1 | run failed — routing, execution or verification |
| 2 | delivery WITHHELD — gate failed after the revision budget (previously: exit 0 + `delivered`); audit `x_delivery_withheld` |
| 3 | delivery INDETERMINATE — zero gateable artifacts, nothing was judged (previously: exit 0 + `delivered`) |
| 4 | invalid arguments (was 2, which became the withheld code) |

The gate also grew to cover every artifact type (`.html`, `.yaml`, code and
images, not just `.md`/`.txt`/`.json`), `verify-deliverable.ts` is finally called
on runs with a manifest, and the LLM judge switches on via
`quality_gate.judge_enabled` (default remains `false`).

### Never stall: run ledger + supervisor

Every dispatch opens a debt in a SQLite ledger with a state machine enforced in
code: `dispatched → running → verifying → gated → delivered | withheld`. A run
leaves the debt only by finishing; `abandoned` requires an explicit reason.

What detects a stall is activity, not the clock. A sidecar renews the lease only
while stdout, stderr or the output files actually advance, and gives up after 5
minutes of silence. The supervisor then sweeps: it resumes from the recorded
session, redispatches on another runtime, and escalates with a notification when
attempts run out. Run `nrv supervisor install` once and a LaunchAgent sweeps every
2 minutes; each `nrv` command also performs a lazy sweep of under 20 ms. The
wall-clock ceiling became what it always should have been: a 24-hour safety net,
so a book that legitimately takes six hours is not killed.

### Never abandon: the Business → Squad → agent-x cascade became code

`NO_MATCH` dispatches the runtime's `agent-x` instead of exiting with an error —
it changes who executes, never whether execution happens. A squad route now
dispatches and delivers for real (it used to print instructions and exit).
Ambiguity offers a choice in the terminal, picks the top candidate outside it
with an audit event, or fails with `--strict-route`. A router transport failure
retries, falls back to BM25, and only then to agent-x.

### Worldwide routing

The agentic router is the default and got cheap: it reads a compact ~45k-token
digest (businesses, squads, capabilities, collisions and mind-clones) instead of
megabytes of registry. The response contract separates transport from semantics —
`decision`, `ambiguous` or `no_match` — so a router failure is never again
confused with "nothing fits".

On the deterministic fallback: a single Unicode tokenizer (segments CJK, Arabic
and Devanagari via ICU; repairs acronyms like E-E-A-T; treats `e-book` and
`ebook` as the same term), coverage gates that prevent injecting an irrelevant
mind-clone, and a multilingual alias bridge that rescues a Portuguese brief
against an English corpus without spending a token. The dense arm was
re-evaluated with the real multilingual model and stays off by measurement,
available as a suggestion on `no_match`.

### Content findable by construction

Creating a business, squad or mind-clone now passes a self-retrieval gate: the
entity is only born when its own `example_briefs` retrieve it in first place.
`ROUTING_METADATA_CONTRACT.md` defines the standard (canonical English
descriptions, multilingual synonym groups, briefs in EN and PT with infinitive
and conjugated verbs, `not_for` as short tokens), the indexers now emit the
descriptions that never used to reach the index, and `nrv doctor` reports your
library's coverage. Anyone with existing content can raise it with
`enrich-routing-metadata.ts`.

### Runtimes and robustness

The two divergent drivers became one, with nine adapters (claude-code, codex,
gemini-cli, antigravity-cli, kimi-cli, grok-cli, pi, qwen-code, opencode). A
large prompt no longer blows the argument limit — each CLI receives it by the
method it supports (STDIN, `--prompt-file`, attachment), verified with 300 KB.
Per-run cost is populated where the CLI reports it, and explicitly unavailable
where it does not. File locks eliminate lost writes in parallel waves.

### Repository hygiene

All source code and agentic instructions in English, with a CI gate. The
references were rewritten against the real code and the audit event table is now
generated from the enum, so it cannot fossilize again. `bun run check:all` runs
the four gates: English, engine purity, command parity and event parity.

### How to migrate

Check the exit codes in any automation that calls `nrv dispatch`. If you need the
old behavior in a specific case, `--force-deliver` delivers even with a failed
gate and leaves an honest record in the audit. Run `nrv index` after updating
(the digest is rebuilt with it) and `nrv supervisor install` to enable the
automatic sweep.

## 0.1.72 — 2026-07-28

### The pi runtime: one CLI, 15+ providers and local models in the cascade

Pi Coding Agent (pi.dev) joins as the seventh exec-runtime, verified against the
real binary (`pi 0.82.1`). `runPi` dispatches via `pi -p --mode json` with a
deterministic session (`--session-id`, the same pattern as gemini) and carries
`AUTONOMOUS_DIRECTIVE` through the native `--append-system-prompt`. An important
quirk handled in the driver: pi exits 0 even when the provider fails, so
`ok`/`error` come from the event stream (`stopReason`/`errorMessage`), and the
quota-detector classifies the real quota phrasing ("used all available credits"
becomes `quota_exhausted`). Cost is summed from `message.usage.cost.total`. The
`@provider` in LLM_CASCADE becomes a real `--provider`, including `@ollama`: the
success path was verified 100% locally with qwen2.5-coder:7b, with a correct
answer, a real session resume and $0 cost. Completing the runtime: USE_PI
aliases, host detection via PI_CODING_AGENT, `agent-x.pi`, a 15-section adapter,
a skills symlink at `~/.pi/agent/skills` on install, and the `pi-mcp-adapter` +
`@pi9/subagent` packages registered in the matrix. An empirical measurement
recorded in the adapter: a local 7B model does not sustain a full business
dispatch (92k-char prompt, zero tool calls across 2 attempts); the local rail is
the bottom of a cascade, not the top. Suite: 141 pass, 0 fail.

### Verify accepts a short deliverable named in the brief

The 200-byte anti-stub check rejected legitimately tiny deliverables: a 57-byte
`haicai.md`, correct and within contract, failed verify in a real dispatch via
`--exec=codex`. A file named explicitly in the brief now counts as a deliverable
as long as it is non-empty, at all three points that used the fixed floor
(verify, the gate's file list, and the post-revision second pass). An E2E
regression via codex closed green: `verify_passed`, `gate_passed`,
`delivered: pass`.

## 0.1.71 — 2026-07-27

### The fast router after a census: 94.1% → 99.8%, and NO_MATCH finally reachable

A ground-truth census against ALL 2,358 `example_briefs` in the registry proved
that `applyAdjustments` was knocking out 133 valid briefs — every one an error,
none of it curation. The fixes, each measured before and after:

- **The intent filter becomes opt-in** (`NIRVANA_ROUTER_INTENT_FILTER=1` turns it
  back on). Banal verbs ("run", "rodar") excluded capabilities by class: 81
  fabricated NO_MATCH plus 34 HIGH scores for the wrong route. After the
  adjustments: 94.1% → 99.8%.
- **`score_boost` clamped to [1.0, 1.3]** — a boost of 0 was accepted as a ×0
  multiplier and self-annihilated the capability.
- **NO_MATCH by coverage**: a winner matching ≤1 of ≥3 content tokens from the
  ORIGINAL brief (never the amplified one) → NO_MATCH; 2 of ≥4 with a fraction
  ≤0.5 → AMBIGUOUS. An out-of-domain brief now abstains with an explicit reason;
  zero false negatives across the 2,358 real ones. Closes the "NO_MATCH
  unreachable" debt.
- **Stage -1 stops hijacking**: banal triggers ("portfolio", "end-to-end")
  removed and the dead substring fallback deleted — 56 hijacked briefs with 0
  hits return to the normal pipeline.
- **Business-first promotion treats `business_route` as a rival** — closes the
  broken top=1.0 invariant.
- **A business was invisible to its own brief**: `example_briefs`/`produces`/
  `keywords` now enter the indexed text of the business doc. Correct destination
  for the 319 declared briefs: 7.5% → 91.5%. E2E squads rose with it (99.6%).

### Native creation: the content-free engine creates everything

The engine installs with no businesses, squads or clones — and now creates all
three end to end, with no intermediate squad (the role of `nirvana-squad-creator`
was absorbed):

- `squads/references/02-creation.md`: Phase 0 (intent archaeology + mandatory web
  research) and Phase 8 (optimization + a routing gate with `example_briefs` as
  ground truth).
- `businesses/SKILL.md`: equivalent Round 0 and Round 5, with mind-clones chosen
  by need.
- `_shared/MIND_CLONE_CREATION_PIPELINE.md` (new): an end-to-end clone with a
  material gate (no source means an archetype, never a real name), `^[FONTE]` DNA
  and a routing block per the contract.
- Harness: clones matched by NEED via `nrv find-clone` (the `serves` field),
  NO_MATCH dispatches `agent-x` (the brief never stops), and a currency gate in
  Phase 2 (an unspecified stack choice requires web research with source and
  date).

### Quality locked in CI

- The clone routing eval joins the suite with watermarks; on a clean install or a
  partial pack the watermarks skip (purity: the engine installs no content) and
  the universal 100% self-retrieval invariant applies.
- `index-clones.ts` mirrors the global-scope registry automatically.
- Suite: 141 pass, 0 fail.

## 0.1.70 — 2026-07-27

### A missing clone never takes down a dispatch again — across seven layers

The owner's rule: **a dispatch may never die because a mind-clone does not
exist.** A brief citing an expert outside the library killed the whole execution,
even when the agent knew perfectly well how to work as that person.

But degrading silently is worse than failing, so every degradation is LOUD across
three channels: a `mind_clone_missing_degraded` event, an explicit block inside
the prompt telling the agent it does NOT carry that DNA, and a field in the
return value so the caller can report it to the user.

The survey found the defect in seven places, not one:

- **`injectMindClones`** threw. It now degrades and returns `degraded[]`.
- **`validateTrace`**, the anti-fabrication guarantee, treated a degraded clone as
  fabrication. It now distinguishes three states: injected, degraded with an
  event, and vanished without a trace. Only the third fails — the
  anti-fabrication property stays intact, verified with a synthetic trace.
- **`team-orchestrator`** skipped silently (`if (persona)`).
- **`employee-prompt`** was the worst: a REQUESTED, nonexistent clone made
  `hadRequested` become `false`, and the system fell quietly through to SEARCH and
  injected **a different person**. The employee ran believing it was the right
  persona.
- **`deterministicAudit` Rule 2** marked a missing clone as `critical`, and
  `critical > 0` produces `verdict: "block"`. The removed `throw` came back to
  life one floor up. Downgraded to `warning`; a missing squad or business stays
  critical.
- **`buildVoiceFidelityPack`** omitted a missing clone with no record, leaving the
  fidelity gate indistinguishable from "no clone declared". It gained
  `missing_clones`.
- **The LLM auditor's rubric** (`dispatch-auditor.md`) still listed mind-clone
  under "Critical — verdict: block", which would reintroduce the block through the
  semantic layer. Moved to warning, with the creation path documented.

### Rule 9 in SKILL.md: search by need, create if missing, degrade honestly

- Clone selection in four steps, and none of them ends in a hard failure: named in
  the brief beats everything; unnamed searches by NEED rather than by name;
  requested and nonexistent offers creation via `fabrica-de-genios`
  (`knowledge_management.mind_clone_generation_pipeline.execute`); not created,
  work from your own knowledge **while saying so**.
- The point of step 4 is the difference between degrading and lying. Working
  without the DNA is acceptable; letting the user believe the DNA was there is not.

## 0.1.69 — 2026-07-27

### The fragmented path discarded the persona's operational spine

- `NIRVANA_DNA_INJECTION=fragments` never read `AGENT.md`. It read SOUL + schema
  layers + coherence map, and nothing else. That was not "layer selection": it was
  swapping the agent's operational definition for the summary derived from it.
  `AGENT.md` is **36% of everything the full mode injects** and is where the
  Principles, the named Frameworks, the `Commands`, the `What You Refuse to Do`
  and the `Limitations` live.
- Consequence: anyone who had enabled fragmented mode — available for a while,
  behind an env var — ran with personas that had no declared limits and no
  refusals, and the system emitted no signal at all. A silent degraded mode, like
  the blind truncation of 0.1.68.
- Fixed: `AGENT.md` enters as the first unit of the fragment. A regression test
  pins the invariant.

### How this surfaced, and what the measurement showed

- A blind test of 5 pairs (same brief, whole persona against the phase fragment, a
  judge blind to which was which, the complete persona as reference): the whole
  persona won **4×1**. One judge decided explicitly on `Limitations` — a section
  the fragment had no way to see. A causal link, not a correlation.
- After the fix, with one variable changed: **3×2**, which at n=5 is
  indistinguishable from a coin. The deficit is gone; equivalence was **not**
  demonstrated, and the test lacks the power to decide.
- **The default stays `full`.** The real saving, measured with `AGENT.md`
  restored, is 21% — and falls to 12% if L5 returns to the phase policy, which the
  judges' evidence suggests is necessary for analytical work. The layers weigh
  almost the same (17% to 26%), so there is no slack to extract without a
  proportional cost.
- An honest record: the 55% the previous version reported summed 34 points of
  amputation with 21 of real selection. The amputation was being counted as a gain.

## 0.1.68 — 2026-07-26

### Layered DNA injection stops amputating the method

- Structural per-layer selection (L1 Philosophies · L2 Mental Models · L3
  Heuristics · L4 Frameworks · L5 Methodologies) already existed and is LOSSLESS
  by construction, but it was unusable: `byteBudget` cut with
  `lastIndexOf("\n", 9000)` over the already-concatenated text. Since assembly
  order is SOUL → L1 → phase layers → coherence map, the amputated tail was always
  **the last requested layer** — exactly the one the phase policy had chosen —
  while L1, which enters in every phase, survived intact. Measured: **175 of 548
  clones** were amputated this way, with no error at all.
- The budget now drops a WHOLE unit (only the coherence map, which is derived)
  and, if it still overflows, delivers the COMPLETE fragment. The ceiling became
  advisory: delivering SOUL + the phase layers above budget is still a fraction of
  full, whereas amputating destroys the method. Blind truncation still applies
  only to the non-fragmented paths.
- Ceiling 9 KB → 16 KB, chosen by measurement: 9 KB let 65% of fragments fit
  whole, 16 KB takes it to 94%, and 24 KB adds 2 points.
- The real phase reaches the selector (`injectMindClones({ phase })`); it used to
  be a fixed `"execute"`, so a planning dispatch received execution layers.
- Result across the library: **0 mutilated** (was 175), 512 fragmentable clones,
  **56% average saving with no loss at all**.

### The layer parser recognizes level-3 headings

- Five clones carried all five layers complete, with cited sources, written as
  `### Layer 1 — VISION`. The strict parser rejected them and they fell back to
  full. Rewriting the persona to fit the regex would destroy good material because
  of the tool.
- A fallback that engages only when the strict parse fails, also splitting on
  `###`. The canonical path stays identical: splitting on outgoing `###` would
  break the layer bodies of well-formed clones.

### Fixes to the 0.1.67 contract surface

- **Perpetual churn in mind-clones.** The clone surface scans the whole directory
  and measured `CHANGES.json` and `CHANGELOG.md` — which the generator itself
  writes. Every execution produced a change, which wrote a file, which produced a
  change. 22 clones in a loop. Generator outputs are now outside the measurement
  (`GENERATED_FILES`).
- **Schema suppression became permanent.** `diffSurfaces` deliberately ignores a
  diff between different schemas, so an extractor improvement does not flood
  buyers with phantom changes. But `gen` returned early when there was no change,
  so the surface was never rewritten with the new schema: the mismatch persisted
  and EVERY future real change to that artifact would be swallowed silently. A
  different schema now forces the rewrite. `SURFACE_SCHEMA` → 2.
- Phantom entries already written ("dna-artifact removed: CHANGELOG.md") were
  cleaned from 22 clones — they would have told the buyer's agent that a breaking
  removal had happened.

## 0.1.67 — 2026-07-26

### Artifact change stops being narrated and starts being computed

- The system distributes squads, businesses and mind-clones that change all the
  time, but whoever receives the update had no way to know **what** changed. The
  buyer's agent kept invoking a renamed capability, or pointing at a target that
  became something else, with nothing failing out loud: the work simply came out
  wrong.
- The obvious way out — a hand-written `CHANGELOG.md` in every artifact — had
  already failed in this system before it was tried. The `version` field exists in
  all 774 artifacts and is dead: 132 of 178 squads stuck at `5.0.0` (the
  *protocol* version leaking through) and 48 of 49 businesses at `1.0.0`. Metadata
  that depends on someone remembering rots; writing prose rots faster than
  changing a number.
- Every artifact now carries a **contract surface** (`.nirvana-surface.json`): the
  identifiers a consuming agent actually binds to — capability id, `invoke`
  target, task/workflow/agent name, employee slug, domains and produces — plus the
  hash of each body. Two surfaces are machine-comparable, so version and changelog
  become **derived**.
- Severity is a structural consequence, not an opinion: a removed or renamed id
  and a changed invocation target are BREAKING (major); a new id is additive
  (minor); a change to only the body or the discovery prose is a patch. A rename
  is recognized as such (same body, different id) instead of becoming "removed +
  added", which would hide exactly the trivial migration.
- The surface lives **inside** the artifact and travels in the pack. That removes
  the need for a central registry: on update, the installer compares the installed
  surface against the incoming one at the only moment both coexist on disk, before
  overwriting, and reports the breaks with a migration for each.
- `nrv changes pending <entity> --project <dir>` answers the question that matters
  to a consumer: *what changed that THIS project has not seen yet?* It returns a
  `brief_block` ready for the orchestrator to paste into the dispatch instruction
  (Rule 8), because a changelog the agent has to remember to open is a changelog it
  does not read.
- Behavior is the one type no structural diff can see (same interface, different
  result). It stays as an optional manual annotation in `.nirvana-behavior.md`,
  consumed and deleted at build time — deliberately the exception, not the rule.

### Details that decide whether this works or becomes noise

- **Determinism is a requirement.** The generated file enters the installer's
  `hashDir()`. With a timestamp or unstable ordering, every rebuild would mark
  every artifact as updated and the signal would die in the noise. No generation
  date, keys sorted at any depth, and the file itself excluded from what it
  measures.
- **A different schema re-baselines silently.** A future improvement in the
  extractor changes hashes of artifacts nobody touched; comparing across schemas
  would flood every buyer with phantom changes. The engine does not know what
  really changed, so it does not invent.
- **Both installers use the same helper.** `scripts/install.ts` and
  `skills/_shared/scripts/install-content.ts` each have their own copy of
  `syncKind`; the first version of this feature landed only in the first, and the
  path buyers use to update would have been left with no warning at all. The
  comparison lives in `_shared/lib/contract-breaks.ts` so both report the same
  thing.
- A baseline was generated for 178 squads, 49 businesses and 547 clones in ~2s; a
  second run does not change a byte. `build-all-packs.sh` regenerates before
  assembling the packs.

## 0.1.66 — 2026-07-26

### Order before shape: parallelism becomes a conclusion, not a default

- Phase 4 opened by saying "Dispatch to 1 or N in parallel" — parallel as the
  starting point, before any dependency analysis. The reasoning about order sat
  twenty lines below, behind a "load it on demand", and multi-target was still
  mentioned inside the **Optional subsystems** section ("None is mandatory"). In
  other words: the maestro was instructed to parallelize first and think about
  order only if it decided to load the reference.
- Phase 4 now opens with the question that decides everything — *does this target
  need another's deliverable to do its work?* — and the answer defines the shape.
  Needs upstream: runs afterwards, and `DISPATCH-INSTRUCTION.md` names the phase
  and the path to read. Needs nobody: runs concurrently, as long as the
  instruction is self-sufficient — a target that would need to ask a sibling
  something mid-run was never independent, it was under-instructed.
- Concurrency becomes the CONCLUSION of the analysis. Two targets that merely look
  independent but read each other's output are a corrupted run, and the failure
  shows up late wearing the face of a quality problem.

### Multi-target leaves "optional" and becomes the normal path for 2+ targets

- `references/04-multi-target.md` stops being an optional subsystem and becomes a
  required protocol whenever Phase 4 lands on more than one target. The machinery
  already existed and is good — a shared workspace, a `manifest.json` with
  `depends_on` / `consumed_by` / `outputs_path` and `parallel_waves[]`, and one
  `DISPATCH-INSTRUCTION.md` per target with scope, upstream paths and who consumes
  the output. What was missing was the entry point treating it as the norm.
- Writing the DAG is what makes the order auditable: a wave that points at itself
  is a decision, a wave that stayed in the maestro's head is a guess the user
  cannot check.

## 0.1.65 — 2026-07-26

### Session reuse per entity (the agent stays the same agent)

- Every dispatch opened a cold session. The same business or squad called twice in
  the same project rebuilt from scratch what it already knew — and an agent that
  restarts cold is not the same agent, it is a new one with the same prompt. Lost
  context is lost quality, and no budget brings back what the agent forgot.
- `harness/lib/session-store.ts` keeps the session per **(project, runtime,
  entity)**. All three matter: project because the same business in another
  project should start cold (the same isolation as memory — what one project
  learned is usually wrong for the next); runtime because a claude-code id means
  nothing to codex; entity because each employee/squad has its own line of
  reasoning. It lives in `<project>/sessions.json`, the only place BP5 allows
  writing during a brief.
- Wired at both points in `team-orchestrator` (employee step and mandatory squad)
  through a single helper, with no duplicated logic. Emits `session_resumed` and
  `session_resume_failed` on the audit trail.

### Fallback: reuse can only improve, never degrade

- The driver passes `--resume <id>` and did NOT handle an invalid id. An expired
  session, deleted by the CLI or carried from another machine, would fail a
  dispatch that works today.
- Now: if the run failed AND we had passed an id, drop the id and try ONCE cold.
  The worst case of reuse becomes exactly today's behavior.

### Fix: session id leaked between runtimes in the cascade

- A latent bug this change would have made common. `cascade-runner` built the
  options by spreading the args (`{...args, runtime: chosen}`) and, on handoff,
  `{...currentOpts, runtime: chosen}` — `sessionId` survived the runtime switch.
  The new CLI received a `--resume` with another CLI's id.
- It contradicted the code's own comment at the handoff ("Build a fresh prompt for
  the new runtime — it doesn't see the old session"). The id now passes only when
  the chosen runtime is the one the caller asked for, and it is cleared on any
  handoff.

### Coverage

- 10 new tests in `session-store.test.ts`, focused on what can go wrong: isolation
  between runtimes, between projects and between entity types; a corrupted file,
  wrongly shaped JSON and a runtime with no session id not taking down the
  dispatch; a surgical `dropSession`. Full suite: 89 tests.

### Deliberately not implemented

- Parallelism in the mandatory-squads loop. The mechanism was proven in a spike
  (1531 ms against 4195 ms, identical `session_id`, a 200 KB payload intact across
  multiple chunks, isolated failure), but the gain is wall-clock and each squad's
  output is identical in series or in parallel. It would require making
  `cascade-runner` asynchronous, and that is the failover brain — trading the
  system's most critical path for latency, in a system whose primary rule is
  quality with no spending limit, is a bad deal. The employee chain stays
  sequential out of real dependency (each step reads the previous one's
  `priorOutputs`).

## 0.1.64 — 2026-07-25

### Rule 7 of the execution contract: the whole scope, and anything beyond it is declared

- Impeccable delivery means the WHOLE task, not the easy part: report completion
  only when it is actually done and, if something is genuinely blocked, finish
  everything else and say what is missing and why. Ambiguity is resolved the way a
  careful colleague would resolve it — a routine decision belongs to the maestro,
  and only goes back to the user when different readings lead to materially
  different work.
- What scope may not do is move in silence. No narrowing, widening or
  transforming the request without saying so; believing the brief is wrong becomes
  a sentence said to the user, not a quiet substitution. Anything beyond the
  request enters the dispatch instruction and the final report as an explicit
  addition — work the user did not ask for is not a bonus if they cannot tell it
  apart from what they did ask for.

### Writing contract: length follows substance

- The `Structure` section gained the size rule: cover what the deliverable needs
  and stop. A filler section, a redundant summary, restated context and
  boilerplate are now treated as a DEFECT, not as diligence — length without
  substance buries the part the reader came for. A long document justifies its size
  by covering more, never by saying the same thing twice.
- It reaches the project's three contract files (`AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`) through `init-project`, so it also reaches dispatched entities,
  which run with cwd in the project.

### What deliberately did NOT change

- `effort` and `model` remain the user's. Nirvana-OS changes neither on its own:
  it inherits whatever is in the system and changes only if `.env` specifies it or
  the user asks. No effort level was embedded anywhere.
- No spawn ceiling and no mandatory budget. Unlimited budget and maximum quality
  are the system's primary rule; the multi-agent cap the model documentation
  recommends applies to cost-sensitive workloads, which is not the case here. The
  fan-out architecture stays as it is.
- The three deterministic gates (`quality-gate`, `verify-deliverable`,
  `validate-chain`) stay intact: they check truth on disk, they are not
  prompt-driven self-verification.

## 0.1.63 — 2026-07-25

### A slug collision is now reported (no longer silent)

- Policy unchanged: the pack is the source of truth for ITS components, always
  wins, and there is no backup — whoever alters what is ours is responsible for
  their own changes. What changes is only VISIBILITY: if the user created a
  component with the same slug as one in the pack, the sync overwrote it silently
  and their work vanished with no explanation (it became a "disappeared out of
  nowhere" issue).
- Exact detection: exists on disk AND is not in the pack manifest
  (`~/.nirvana-pack.json`) ⇒ it is the user's creation. No false positive on the
  second round, once the pack owns the slug.
- Reported as `N overwritten` in the count and in its own block at the end, with
  the way out (rename yours) and what was preserved (run state: `projects/`,
  `outputs/`, `memory/projects`). Applied on BOTH sync paths —
  `scripts/install.ts` (starter) and `_shared/scripts/install-content.ts` (what the
  buyer runs via the pack's `setup.ts` and `nrv update <slug>`).

### Clones in the legacy nested layout are indexed again

- Pack installs at ≤ 0.1.61 wrote `dna/<category>/<slug>/` (issue #2, fixed in
  0.1.62). Anyone who already had that tree kept getting `0 mind-clones indexed`
  even after updating, because the scanner only saw one level.
- `index-clones.ts` now reads both layouts: liberal reader, strict writer. NOTHING
  is moved on disk — touching the user's data during a read command would be worse
  than the bug. The writer has been flat since 0.1.62, so this is a compatibility
  path that decays on its own as old installs reinstall.
- Flat wins a slug tie; for a nested clone the category comes from its own parent
  directory. The legacy total is reported at the end of the index, with guidance
  that reinstalling the pack normalizes it and nothing needs to be moved by hand.

## 0.1.62 — 2026-07-25

### Content libraries created empty at install (`~/squads`, `~/businesses`, `~/businesses/_library/dna`)

- The engine is core-only (it ships no content), but the directories where the
  user creates THEIR businesses/squads/mind-clones did not exist after
  installation: `scripts/install.ts` created them only when there was starter-pack
  content to copy (`if (available.length > 0) mkdirSync(dstRoot)`). With
  `--no-starter` (the `npx` path), none were created — and the behavior was
  inconsistent on top of that: `~/squads` ended up appearing by accident on the
  first `nrv index` (via `squads/lib/registry.js`), while `~/businesses` and the
  DNA library never showed up. Result: a fresh install reported `⚠ 3 warning(s).
  System usable but degraded.` in `nrv doctor`.
- `ensureContentLibraries()` now creates all three EMPTY, before the starter pack
  (with and without `--no-starter`). It mirrors what project scope already did
  (`init-project.ts` creates `.nirvana/{squads,businesses,mind-clones}`).
- NOT destructive and idempotent: a recursive `mkdir` is a no-op on an existing
  directory — user content is preserved (it reports `kept` instead of `created`).
  Cross-OS: only `path.join` + `mkdirSync`, no shell command, with EEXIST tolerated
  (Bun throws it on Windows even with `recursive: true`). `nrv install --check`
  still mutates nothing.

### Fix: pack install wrote mind-clones nested by category (issue #2) — 0 clones indexed

- `installer.ts` installed a clone at `dna/<category>/<slug>/`, but the canonical
  layout is FLAT (`dna/<slug>/`) — which `index-clones.ts` (one level only) and
  `install-content.ts` already followed. Every pack with mind-clones installed via
  `nrv install --type=pack` resulted in `0 mind-clones indexed`.
- It installs flat now (pack and standalone asset) and writes the category as
  METADATA in `.pack-categories.json` — a file the indexer reads but which NO
  engine flow wrote, so `pack_category` never came out of `null`.
- A slug collision inside the pack now fails explicitly (it used to be masked by
  different categories). Category inference hardened: real packs are flat, so the
  parent directory name would have written `"mind-clones"` as the category.
  `index-clones.ts` now resolves the map per root (metadata written in project
  scope was ignored).

### Fix: `nrv init --with-skills` broke with a 312 MB copy and a half-made project (issue #3)

- These were three chained defects, not one: (1) the symlink branch did not create
  `<target>/.agents`, so `symlinkSync` failed with ENOENT; (2) it fell through to
  the copy fallback; (3) `copyTree` used `statSync` and followed each skill's
  `node_modules` symlink → hundreds of MB and infinite recursion on the
  `node_modules/.bin/*` cycles (ELOOP). Fixing only `copyTree` would have left the
  trigger standing, with every `--with-skills` copying instead of linking.
- `copyTree` uses `lstatSync`, skips `node_modules` at ANY depth (not just the
  top) and recreates symlinks instead of expanding them; `.agents` is now created
  in the symlink branch; and a copy failure became fail-closed — it used to be a
  `log.warn` with the command exiting 0 and leaving a broken project.

### Fix: `nrv index` failed on Windows in project scope (issue #1, bug 2)

- `businesses/lib/registry.ts` called a raw `mkdirSync`; on Bun/Windows that
  throws EEXIST even with `recursive: true` when the directory already exists — the
  case of `<project>/.nirvana`, which exists since `nrv init`. It now uses the
  canonical `ensureDir` helper, which already tolerates EEXIST. (The other 3 bugs
  in issue #1 were already fixed in 0.1.25/0.1.26.)

### grok-cli: documented flag + real cost

- Swapped `--yolo` for `--always-approve` (code and docs). `--yolo` works, but it
  is a HIDDEN alias — it does not appear in `--help` and may disappear between
  builds.
- The driver hard-coded `costUsd: null` claiming the subscription reports no
  spend; the real build returns `total_cost_usd` in the JSON. It is parsed now.
- Invocation VERIFIED against the real binary (`grok 0.2.103`): flags accepted,
  JSON with `text`/`sessionId`/`total_cost_usd`. `kimi-cli` remains UNVERIFIED
  (binary absent on the test machine).

## 0.1.61 — 2026-07-20

### New first-class runtimes: Kimi Code CLI + Grok Build CLI

- `kimi-cli` (Moonshot, binary `kimi`) and `grok-cli` (xAI, binary `grok`) are now
  first-class runtimes, equal to codex/gemini-cli/antigravity-cli: `runKimi`/
  `runGrok` in the host-agent-driver, present in VALID_RUNTIMES/EXEC_RUNTIMES,
  RUNTIME_ALIASES (`USE_KIMI`/`USE_GROK`), host detection, brief mention, glance,
  `.env.example`, and complete adapters in `_shared/adapters/{kimi-cli,grok-cli}.md`
  + `_shared/agents/agent-x.{kimi,grok}.md`. The model comes only from LLM_CASCADE
  (`kimi-cli:k3` / `grok-cli:<model>`), NEVER hardcoded (model-agnostic).
  - Kimi: free via Kimi.com OAuth (K3/K2.7), `kimi -m <model> -p … --output-format stream-json`.
  - Grok: agentic coding + native media generation, `grok -p … --output-format json --yolo --cwd`.
  - Caveat: the invocations have NOT yet been verified against the real `kimi`/
    `grok` binaries (safe fallback if a flag diverges).

### Adapters consolidated in `_shared/adapters/` (v5, single source)

- The `squads/adapters/` v4.0 layer was retired (duplicates/orphans): codex,
  gemini-cli, antigravity, cursor and claude-code removed. The tables in
  `squads/references/*` now point at `_shared/adapters/`. No code depended on the
  v4 layer.
- Antigravity: the orphan adapter was eliminated (id `antigravity`/binary
  `antigravity`/fixed model); only the canonical `antigravity-cli` remains (binary
  `agy`, no model).
- Cursor: removed (replaced by `grok-cli`).
- ALL old model names purged from the adapters — the engine uses the runtime's
  default or the user's choice, never a fixed id.

## 0.1.60 — 2026-07-18

### Fix: validator drift — v5 capability/business description caps

- `capability-validator.js` (the v5 structural pre-check that `validate-squad.ts`
  runs) hard-coded the capability `description` cap at 500, which had drifted from
  the raised canonical limit (1500 in `_shared/validators/limits.ts`, the same
  `LIMITS` the zod validators use). Valid v5 manifests with 500–1500-char
  capability descriptions were wrongly rejected, aborting `brief-squad.ts` prep
  (e.g. a squad's `whatsapp.system.provision` at 639 chars). It now reads the cap
  from `limits.ts` (single source of truth) with a safe fallback to 1500 — never
  500 again, so the fast pre-check can't drift from the authoritative validator.
- Aligned the JSON schemas to `limits.ts`: capability `description` 500→1500 and
  `example_briefs` items 500→1000; business `description` 500→2000 and
  `example_briefs` items 500→1000.

## 0.1.59 — 2026-07-17

### Windows: CRLF-tolerant parsing

- The frontmatter parsers were `\n`-anchored, so a Windows CRLF checkout made
  `---\r\n` fail to match → rubrics (and 8 other parsers: mind-clone/squad/
  business audit criteria, clone inspect/list/translate) silently loaded
  nothing, and the quality gate selected no rubric on Windows. Fixed with a
  `.gitattributes` (`eol=lf` for parsed files, `eol=crlf` for `.cmd` launchers)
  plus CRLF-tolerant regexes as defense in depth. Caught by the new quality-gate
  test on the Windows CI runner.

## 0.1.58 — 2026-07-17

### The engine never prescribes a model

- The model used is ALWAYS the one configured in the user's own agent runtime
  (Claude Code, Codex, Gemini, Antigravity, …). The engine only overrides it when
  the user explicitly asks for a specific model.
- Removed every default model from the engine: judge config (`default_judge_model:
  inherit`), capability `model_hint` default, rubric `target_model` (now
  telemetry-only `inherit`), adapter docs, and the pixelle client (now
  `gemini-flash-latest`, the provider's non-versioned pointer — no more 404s from
  retired model slugs).

### Router: explicit mention wins; business-first stops hijacking

- New Stage 0.5: naming a squad or business by slug ("use o squad code-review…")
  deterministically short-circuits routing (`route_tier: explicit_mention`) —
  before any scoring. Accent/hyphen-normalized, guarded against false positives.
- Business-first preference is now a relative tiebreak against the best squad,
  never an absolute floor; artifact-pattern routes (`business_route`) compete
  inside the RRF fusion as a third ranked list instead of short-circuiting ahead
  of content matching. Briefs that clearly match a squad no longer get hijacked
  by unrelated business routes.

### Repo & docs

- `CHANGELOG.md` (this file), `AGENT-QUICKSTART.md` (one-page agent onboarding),
  `SECURITY.md`, issue/PR templates, `examples/` end-to-end walkthrough.
- README hero image + CI badge; version badge now rewritten from `package.json`
  at publish time.
- `AGENTS.md` is the single source for the agent contract; `CLAUDE.md`/`GEMINI.md`
  are generated copies (drift fails the publish).
- `skills/harness/SKILL.md` normalized to English throughout.
- New tests: audit event emission (`audit-emit`) and quality-gate selection/fail-closed paths.

## 0.1.57 — 2026-07-13

- **Windows:** `nrv index` fixed (POSIX-only bun-path check made every indexer
  spawn fail with ENOENT when Bun wasn't on PATH); shell-string quoting replaced
  by argv-based `run()`; 11 `.cmd` wrappers fixed (`>nul` instead of
  `/dev/null`); spawn errors now surface their cause.
- **Install anywhere:** the npx installer auto-installs the latest Bun on Windows
  (PowerShell) and continues in the same run; `nrv` is added to the user PATH via
  registry + `WM_SETTINGCHANGE` broadcast so new terminals work without a
  restart; post-install indexing now runs on Windows (`nrv.cmd`); hook commands
  are quoted and use per-OS stderr suppression; `fileURLToPath` fixes repo-root
  resolution on Windows.

## 0.1.56 — 2026-07-13

- Grok-aware ENGINE-MENU (Grok Imagine i2v across video squads' guidance).
- `brief-squad.ts`: squad dispatch now scaffolds the project dir, HANDOFF and
  brief AND emits `brief_received`/`dispatch_squad` automatically — the audit
  trail exists on any runtime, no reliance on the agent obeying SKILL.md.

## 0.1.55 — 2026-07-10

- `nrv doctor` reports honestly: "last activity <date>" instead of a false
  "no dispatches yet?"; detects outputs-without-audit (agent not emitting
  events) and squad dispatches (not only businesses); OS-safe paths.

## 0.1.54 — 2026-07-10

- Security hardening: removed `js-yaml` (DoS advisory GHSA-h67p-54hq-rp68) —
  the two remaining users migrated to `yaml` v2; `bun audit` clean.
- Embedder locked with `allowLocalModels=false` (closes the local-model vector
  of the ONNX CVEs; hub/cache behavior unchanged).

## 0.1.53 — 2026-07-10

- Hybrid retrieval: BM25 + optional local dense arm (transformers.js/ONNX,
  multilingual MiniLM) fused with Reciprocal Rank Fusion; opt-in via
  `nrv embeddings enable` — the core stays zero-hard-dep with graceful fallback.
- Router calibration (E1–E7 external audit): capability `keywords`/
  `example_briefs`/`produces` indexed with field weighting; org-noun vs verb
  separation; best-business-only promotion; generic-object abstention in the
  keyword stage; meta-intent pruning.
- Retroactive learning loop: audit readers accept `business_slug`/`squad_name`
  aliases (history recovered); `nrv audit emit` canonical writer CLI.
- First router test suite (69 tests) + YAML/HTML validation rubrics.

---

Earlier releases (0.1.9 → 0.1.52) predate this changelog; see the GitHub
release notes of each tag for their summaries.
