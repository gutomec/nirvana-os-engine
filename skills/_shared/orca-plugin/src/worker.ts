// Nirvana-OS inside Orca. The worker does two things:
//
//   1. When Orca creates a workspace, it runs `nrv init . --adopt` there, so the
//      workspace starts as a Nirvana project. `--adopt` writes only
//      `.nirvana/project.yaml` and is idempotent.
//   2. It reads the runs with `nrv supervisor status --all-projects --json` and
//      shows how many are in progress in the status bar item; the panel asks it
//      for the same list.
//
// Orca runs this file in a Node.js process with the user's own access, so `nrv`
// is a plain child process: no terminal is opened and nothing is typed anywhere.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { NirvanaRun, RunsSnapshot } from './protocol'

/** Event-driven reads are spaced at least this far apart. */
const MIN_REFRESH_MS = 30_000
/** The slow timer that catches runs no agent event announced. */
const TIMER_MS = 120_000
/** How many ended runs are read besides the open ones. */
const RECENT_RUNS = 20
/** How many runs the panel lists. */
const LIST_LIMIT = 30

/** The launcher the installer writes (`~/.local/bin/nrv`, `nrv.cmd` on Windows), else PATH. */
function nrvCommand(): string {
  const names = process.platform === 'win32' ? ['nrv.cmd', 'nrv.exe', 'nrv'] : ['nrv']
  for (const name of names) {
    const candidate = join(homedir(), '.local', 'bin', name)
    if (existsSync(candidate)) return candidate
  }
  return 'nrv'
}

/** Replaced by the tests, which never start a real `nrv`. */
export const seams = {
  /** Runs `nrv <args>` in `cwd` and resolves with its stdout; rejects on a non-zero exit. */
  run(args: string[], cwd: string): Promise<string> {
    // Windows starts a `.cmd` launcher only through its shell, which then needs the path quoted.
    const windows = process.platform === 'win32'
    const command = windows ? `"${nrvCommand()}"` : nrvCommand()
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, windowsHide: true, shell: windows, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr).trim() || error.message))
          else resolve(String(stdout))
        }
      )
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseRuns(stdout: string): RunsSnapshot {
  let data: { runs?: unknown }
  try {
    data = JSON.parse(stdout)
  } catch {
    // An engine older than the `--json` flag prints its table and exits 0.
    throw new Error('this Nirvana-OS engine does not list runs as JSON yet; update it with `nrv update`')
  }
  const rows = Array.isArray(data?.runs) ? (data.runs as Record<string, unknown>[]) : []
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  // In progress first, then the most recently updated. A ledger keeps every failed and
  // stalled run open until someone closes it, so the list is cut, never the count.
  const inProgress = (row: Record<string, unknown>): number => (row.in_progress === true ? 1 : 0)
  const active = rows.filter(inProgress).length
  rows.sort((a, b) => inProgress(b) - inProgress(a) || String(b.updated_at).localeCompare(String(a.updated_at)))
  const runs: NirvanaRun[] = rows.slice(0, LIST_LIMIT).map((row) => ({
    runId: String(row.run_id),
    projectId: text(row.project_id) ?? text(row.trace_id) ?? String(row.run_id),
    target: `${text(row.target_kind) ?? '?'}/${text(row.target_slug) ?? '?'}`,
    state: String(row.state),
    inProgress: row.in_progress === true,
    gate: text(row.gate),
    outputsRoot: text(row.outputs_root)
  }))
  return { runs, active, error: null }
}

/** Ends the timers of the running activation. */
let stopTimers = (): void => {}

export default function activate(orca: OrcaWorkerApi): void {
  let snapshot: RunsSnapshot = { runs: [], active: 0, error: null }
  let lastRead = 0
  let reading: Promise<RunsSnapshot> | null = null
  let queued: ReturnType<typeof setTimeout> | null = null

  async function read(): Promise<RunsSnapshot> {
    lastRead = Date.now()
    try {
      const stdout = await seams.run(
        ['supervisor', 'status', '--all-projects', '--json', '--recent', String(RECENT_RUNS)],
        homedir()
      )
      snapshot = parseRuns(stdout)
    } catch (error) {
      snapshot = { runs: [], active: 0, error: message(error) }
      orca.log(`could not read the runs: ${snapshot.error}`)
    }
    try {
      await orca.host.call('statusBar.update', {
        id: 'runs',
        text: snapshot.error ? 'Nirvana' : `Nirvana: ${snapshot.active}`,
        tone: snapshot.error ? 'warning' : snapshot.active > 0 ? 'accent' : 'neutral',
        tooltip: snapshot.error ?? `${snapshot.active} Nirvana-OS run(s) in progress`
      })
      orca.panels.post('runs.changed', snapshot)
    } catch (error) {
      orca.log(`could not show the runs: ${message(error)}`)
    }
    return snapshot
  }

  /** One read at a time: a caller that arrives during a read gets that read. */
  function refresh(): Promise<RunsSnapshot> {
    reading ??= read().finally(() => {
      reading = null
    })
    return reading
  }

  /** A read for an event: at most one every MIN_REFRESH_MS, however many events arrive. */
  function refreshSoon(): void {
    if (queued) return
    queued = setTimeout(
      () => {
        queued = null
        void refresh()
      },
      Math.max(0, lastRead + MIN_REFRESH_MS - Date.now())
    )
    queued.unref?.()
  }

  orca.events.on('workspace.created', async ({ path }) => {
    try {
      // A workspace on another host (SSH, a paired server) has no folder here.
      if (!existsSync(path)) return orca.log(`not adopted, no such folder on this machine: ${path}`)
      if (existsSync(join(path, '.nirvana', 'project.yaml'))) {
        return orca.log(`already a Nirvana project: ${path}`)
      }
      await seams.run(['init', '.', '--adopt'], path)
      orca.log(`adopted as a Nirvana project: ${path}`)
    } catch (error) {
      orca.log(`could not adopt ${path}: ${message(error)}`)
    }
  })

  // A dispatch starts and ends with an agent changing status; the timer covers the rest.
  orca.events.on('agent.status.changed', refreshSoon)
  const timer = setInterval(() => void refresh(), TIMER_MS)
  timer.unref?.()
  stopTimers = () => {
    clearInterval(timer)
    if (queued) clearTimeout(queued)
  }

  orca.panels.handle('runs.list', () => reading ?? snapshot)
  orca.panels.handle('runs.refresh', refresh)

  void refresh()
}

export function deactivate(): void {
  stopTimers()
}
