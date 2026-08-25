# Glance service mode

`nrv glance service` runs the Glance cockpit as a local background worker that stays up until you stop it. The normal `nrv glance` command is unchanged: it opens a browser tab and shuts down after 30 minutes of inactivity, where every request, including `/api/health`, counts as activity. Service mode is a different lifecycle for a cockpit you keep open all day.

Service mode is loopback-only, read-only, and persistent. It never opens a browser, has no idle shutdown, and never installs autostart. It is a managed local process, not an operating-system service: no Windows SCM entry, no LaunchAgent, no systemd unit. If the machine reboots or the process dies, nothing restarts it automatically; you run `service start` again.

## Normal mode vs service mode

| Aspect | `nrv glance` | `nrv glance service start` |
|---|---|---|
| Lifetime | idle shutdown after 30 minutes | runs until explicit stop, process termination, or machine shutdown |
| Port | automatic when omitted | fixed, default 3737, configurable |
| Browser | opens by default | never opens |
| Bind | `127.0.0.1` | `127.0.0.1` |
| Writes | standard behavior preserved | read-only |
| Process | foreground | detached worker with durable state |
| State | legacy `.glance.pid` | `<NIRVANA_HOME>/.nirvana/glance/service/` |
| Autostart | none | none |

The legacy `--idle-min 0` shortcut makes the normal mode exit on its first watchdog tick; it is not persistent operation and not a substitute for service mode.

## Commands

```text
nrv glance service start   [--port <n>] [--scope global|project] [--project-root <path>] [--json]
nrv glance service status  [--json]
nrv glance service stop    [--json]
nrv glance service restart [--port <n>] [--scope global|project] [--project-root <path>] [--json]
```

Every verb accepts `--help`, and `nrv glance service --help` renders the family reference generated from the same declarative registry that parses the flags. An unknown verb or an illegal flag for a verb prints help and exits 2. Flags that would contradict fixed guarantees (`--host`, `--allow-actions`, `--idle-min`, `--no-open`, `--autostart`) do not exist in this family and are rejected at parse time.

Options:

| Option | Verbs | Meaning |
|---|---|---|
| `--port <n>` | start, restart | Fixed local port, integer 1024–65535. Default 3737. |
| `--scope <global\|project>` | start, restart | Scope to serve. Default: the scope resolved from the current context (on-disk config first, then global). |
| `--project-root <path>` | start, restart | Project root used when scope is project. Falls back to the currently configured or detected project root. |
| `--json` | all | Machine-readable result with the same states and codes as human output. |

## State layout

Everything lives under `<NIRVANA_HOME>/.nirvana/glance/service/`:

```text
service/
├── config.json          effective configuration
├── instance.json        identity: instance ID, PID, state, digests
├── manager.lock/        owner snapshot while a mutating command runs
├── secrets/             per-instance control secrets, user-only
├── control/
│   ├── pending/         signed stop requests waiting for the worker
│   ├── processing/      request claimed by the worker
│   ├── startup/         startup readiness records
│   └── archive/         archived instances from stale recovery
└── logs/
```

All JSON publication is temp-file plus fsync plus atomic rename plus exact reread. Directories and files are restricted to your user account. Secrets are 256-bit random values stored as separate private files referenced from `instance.json`; they never appear in JSON output, logs, or command results.

Exactly one managed service exists per effective `NIRVANA_HOME`. Project scope changes which extension roots the UI reads; it does not create a second concurrent instance.

## Start

`start` validates the requested configuration before acquiring the lock, then classifies existing state:

- No prior state: spawns a detached Bun worker, publishes secret, config, instance, and readiness records durably, and waits until the worker's `/api/health` reports a matching identity.
- Healthy instance with the exact same effective config: returns the existing PID and health result without spawning anything or writing a byte (idempotent).
- Healthy instance with a different requested config, or any foreign process holding the port: conflict, exit 4.
- Partial, unreadable, or schema-incompatible state: stale, exit 3, with no mutation.

If startup fails partway, cleanup removes only artifacts whose recorded digests still match this attempt, and terminates the spawned process only after verifying its PID, entrypoint, service root, and startup ID all converge. Anything indeterminate or foreign is preserved byte-for-byte and reported, never signaled.

## Status

`status` takes no lock. It reads the strict state twice around a live inspection of process, listener, port, and health identity. Any drift between the reads reports stale (exit 3) instead of guessing. A stopped system reports exit 1.

A proven-dead instance (process absent, port free, health absent, verified affirmatively) is archived under `control/archive/` and the next `start` recovers cleanly from empty state.

After an engine update or skill-tree change, a healthy registered worker whose recorded entrypoint bytes or engine version no longer match current disk state keeps serving: `status` still reports `running`, now with `restart_required: true`. Nothing restarts on its own; `restart` applies the update. If the current entrypoint bytes cannot be read at inspection time, the result reports the indeterminate condition instead of guessing.

## Stop

`stop` never sends signals to PIDs. It writes an HMAC-SHA-256-signed request with a fresh nonce into `control/pending/`. Only the worker whose instance ID, secret, nonce, time window, and canonical bytes all match consumes that request, by atomic claim. The worker then stops accepting connections, waits up to 5 seconds for in-flight requests, closes the listener, writes stopped state, removes its own capability files, and exits. Stopping an already-stopped service succeeds with exit 0.

`SIGINT`/`SIGTERM` delivered directly to the worker take the same graceful path once identity is established: the worker stops accepting connections, drains in-flight requests within a bounded window, removes its instance and control secret, writes the final log event, and exits 0. The finalization runs exactly once even if the signal arrives repeatedly or concurrently. Before identity is established, signals keep the operating-system default behavior; leftover startup artifacts recover through the proven-stale archive path.

## Restart

`restart` validates the replacement before stopping anything:

- No flags: reuses the current on-disk config verbatim.
- Flags given: merged onto the current config, fully validated, including a feasibility probe of the replacement port while the current instance still serves.

The authenticated stop runs only after validation passes. If the replacement fails to become healthy, exactly one rollback attempt restores the previous config, reported through `rollback_attempted` and `rollback_state` (`restored_previous` or `restore_failed`). If the authenticated stop itself fails, no start and no rollback happen; the original instance keeps running.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success, healthy idempotent result, or already stopped |
| 1 | `status` found the service stopped |
| 2 | Usage, configuration error, or unsupported environment (`SERVICE_UNSUPPORTED`) |
| 3 | Stale or inconsistent state |
| 4 | Conflict: different requested config, foreign process or listener, busy replacement port |
| 5 | Timeout during start, stop, or restart |
| 6 | Permission or I/O error on runtime state |

The same table applies on Windows, macOS, and Linux, in human output and `--json`.

## Logs and redaction

Worker stdout/stderr go to `logs/<startup-id>.log` inside the service root, one file per spawned instance. Command results that refer to a known instance carry that instance's own log reference in `log_path`; when no readable instance applies, `log_path` is the empty string. The field never invents a path. Command output carries IDs, ports, URLs, and digests only; secrets, tokens, log contents, and absolute internal paths of the host are never emitted.

The recorded `process_digest` is the SHA-256 of the raw worker entrypoint bytes: the manager computes it from those bytes before spawn, the worker re-verifies its own loaded entrypoint before serving, and every status inspection recomputes it fresh from disk.

Engine updates and reinstalls that replace skill trees leave the service state directory untouched.

## Operator recovery guide

**Running → stopped:** `nrv glance service stop`, wait for confirmation, then verify with `status`.

**Stale (exit 3):** Something diverged mid-flight or state is partial/incompatible. Do not hand-edit files under `service/` and do not delete `manager.lock` manually. Rerun the command once; transient double-read races resolve themselves. For persistent stale state, `start` performs the proven-stale archive path: it re-verifies full config digest, instance digest, and instance ID under the lock, archives the dead pair into `control/archive/`, proves absence again, and starts fresh. If the lock owner record is valid but undecidable (indeterminate), every mutating command fails closed with exit 3 or 6 until diagnosed; automatic recovery never deletes lock evidence.

**Conflict (exit 4):** A healthy instance is running with a different config, or something else holds the port. Use `restart` with explicit overrides to move the managed instance, or `stop` followed by a new `start`. Never kill the foreign holder yourself; identify it from the conflict result instead.

**Restore failed (exit 4/3 with `rollback_state: restore_failed`):** The previous config could not be republished. Inspect `config.json` presence and permissions under the service root, fix the underlying cause (disk, ACL), then `start` again. Archived pairs under `control/archive/` remain available as evidence.

**Crash or reboot:** State remains on disk describing a dead instance. Run `start`; the proven-stale path archives and recovers. There is no watchdog and no autostart by design.

**Timeout (exit 5):** A bounded wait expired (health within 15 seconds of spawn, spawn liveness within 2.5 seconds, stop confirmation). Check `logs/<startup-id>.log` for the worker's last words, then retry once before deeper diagnosis.

**I/O or permission errors (exit 6):** Verify you own `<NIRVANA_HOME>/.nirvana/glance/service/` and that no backup or sync tool holds the files. Nothing is archived automatically on I/O failure; state is left untouched for manual inspection.

**Unsupported environment (exit 2):** The platform adapter could not load a required native facility. Update Bun to a supported version rather than working around the check.

After any recovery, confirm with `status`: expect `running` with a fresh instance ID and uptime near zero, and an emptied set of pending control files.
