# ADR-009: Orca is a host — a projection and a transport, never a source of truth

**Status:** accepted, implemented 2026-09-09 (engine 0.13.5)
**Requirements:** none registered; measured against Orca 1.4.198 on macOS

## Context

Orca (orca.dev) is a desktop and headless host for agentic work. It manages workspaces (git repos and plain folders), the terminals agents run in, an embedded browser, scheduled automations, public artifacts and paired remote machines. It installs status hooks into the same agent configuration files `nrv setup` writes to (Claude Code, Codex, Gemini, Antigravity, Grok), reads them into a sidebar that shows each pane's state, and offers an orchestration layer — Run (namespace and inbox), Task (a DAG with dependencies), Dispatch (one attempt in one terminal) — with `worker-start`, `worker_done`, `ask`/`reply`, `escalation`, `check --wait` and federation to paired servers.

Every concept the engine already has maps onto one of Orca's: a Nirvana project onto a workspace, a ledger run onto the workspace card and its board column, a seat or squad dispatch onto a worker terminal, `manifest.json` phases onto Tasks with `--deps`, `human_notification_required` onto an escalation, the Glance cockpit onto an embedded browser tab. Users who work in Orca should see all of it there.

The owner's constraint is explicit: the engine must behave identically in any terminal on any operating system, and inside Orca it must use the host's full potential.

## Decision

Orca is an **execution host**, a layer above the runtime, never a runtime and never a dependency. The engine integrates with it under eight invariants:

1. **Detection is the only gate.** `TERM_PROGRAM=Orca`, `ORCA_TERMINAL_HANDLE` or `ORCA_WORKTREE_ID` in the environment means "inside an Orca terminal". Absent, no Orca code path runs and the `orca` binary is never spawned. `host.orca` (`auto` | `on` | `off`, variable `NIRVANA_ORCA_HOST`) overrides detection in both directions.
2. **Same commands, same flags, same exit codes.** No command gains a required flag. `nrv run`, `nrv dispatch --exec`, `nrv team step`, `nrv revise` and `nrv supervisor` keep their signatures.
3. **Same files as the truth.** The ledger, `audit.jsonl`, the outputs tree, `HANDOFF.json` and `manifest.json` keep deciding what happened. Orca identifiers (workspace, terminal, pane, task, dispatch) are added fields on audit events and results, never required ones.
4. **Same prompts.** The seat prompt, the DNA injection, the resource map, the scope guard and the autonomous directive are identical. Orca changes the transport: the prompt reaches the agent by reference to a file, with one reporting paragraph appended.
5. **Same gate.** Verify, gate and delivery run in the coordinating `nrv` process. A worker's `--outcome succeeded` is an input to verify, not a verdict.
6. **Same never-stall.** With orchestration off, depth exceeded, an unrecognized agent, or the app gone before injection, the dispatch falls back to the headless child. The ledger's activity lease and the supervisor cover an injected worker like any child.
7. **Every Orca call is fail-soft.** Status updates are fire-and-forget; the CLI's `--json` envelope is parsed and an error is an answer, never an exception that reaches a run.
8. **Proven with a fake `orca`.** A fake CLI on PATH records every call; tests assert the record stays empty outside Orca and carries the exact calls inside it, on all three CI systems.

Concretely, inside an Orca terminal the engine: stamps every audit event with an `orca` block (workspace, terminal, pane, app version); reports the host in `nrv doctor`; registers a project created by `nrv init` as a workspace; mirrors every ledger transition onto the workspace card (comment `nirvana · <kind>/<slug> · <state>`, board column `in-progress` / `in-review` / `completed`); mirrors desktop notifications onto the card; opens the Glance cockpit in the embedded browser; and, when `host.orca_workers` is on (its default) and the orchestration layer answers, runs every headless dispatch as a worker terminal: one Run per dispatch, one Task pointing at the brief file, an operator-started agent terminal with the engine's own autonomy flags, `dispatch --inject`, `check --wait` until `worker_done`, questions answered with the zero-human policy, the transcript archived beside the brief, the tab closed on success and kept open on failure.

Children the engine spawns inherit the environment **minus** Orca's pane identity (`ORCA_PANE_KEY`, `ORCA_TAB_ID`, `ORCA_AGENT_LAUNCH_TOKEN`, `ORCA_TERMINAL_HANDLE`), so a headless `claude -p` is not reported to Orca as the coordinator pane's agent.

## Consequences

Outside Orca the engine is byte-for-byte the same. Inside Orca a `nrv run` shows its progress on the workspace card, each seat of a business chain is a titled terminal tab with live status from Orca's own hooks, a failed seat leaves its terminal open with the transcript, and the cockpit opens where the user already is.

Two limits are accepted for this cut. A worker's provider session id is not captured, so `nrv revise` on an Orca-run seat starts a fresh session with the handoff context instead of resuming the conversation. Orca's nested-worker depth defaults to one generation, so a seat that sub-dispatches a squad runs that squad as a headless child unless the user raises the depth in Orca's settings.

No abstraction of "execution host" is introduced: one module (`_shared/lib/orca.js` for detection, `_shared/lib/orca.ts` for the CLI, `_shared/lib/orca-worker.ts` for the transport) and a call at each existing seam, the same shape the OpenClaw integration took. A third host would be the moment to name the interface, with two real cases to copy from.

## Alternatives rejected

Orca's Run as the source of truth for a dispatch (the ledger already is, and works with Orca closed). Orca's decision gates in place of the engine's quality gate (a worker's report is not evidence about the files). Publishing artifacts automatically through `orca artifacts share` (human-gated in Orca by design; the engine may only offer). A generic host interface ahead of a second host. Enabling the host from any terminal by default (a plain terminal must not reach into the app).

## Verification

`skills/_shared/tests/orca-host.test.ts` (detection, executable rule, no-spawn proof, card projection, audit stamping), `skills/harness/tests/orca-worker-transport.test.ts` (every branch of the transport with canned answers, then `runHeadless` through a fake `orca` and a fake `claude`), `skills/harness/tests/orca-doctor-init.test.ts` (doctor line, init registration). Live on 2026-09-09: the transport sequence ran end to end against Orca 1.4.198 and the file the brief asked for was on disk eighteen seconds after injection; a headless child spawned with the pane variables registered as the pane's agent, and the same child without them did not.
