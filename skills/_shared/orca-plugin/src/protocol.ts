// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** One row of `nrv supervisor status --json`, as the panel shows it. */
export type NirvanaRun = {
  runId: string
  projectId: string
  /** `<kind>/<slug>` of the business, squad or agent the run was dispatched to. */
  target: string
  /** The ledger state: running, verifying, delivered, withheld, failed, stalled... */
  state: string
  /** Whether the ledger still reads the run as being worked on. */
  inProgress: boolean
  /** The gate verdict the delivery pipeline recorded; null while there is none. */
  gate: string | null
  /** The folder the deliverables are written to; null when the run recorded none. */
  outputsRoot: string | null
}

export type RunsSnapshot = {
  /** Runs in progress first, then the most recently updated ones. */
  runs: NirvanaRun[]
  /** How many runs are in progress. */
  active: number
  /** Why the runs could not be read; null when they were. */
  error: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** What the worker last read. */
    'runs.list': { output: RunsSnapshot }
    /** Reads the runs again now. */
    'runs.refresh': { output: RunsSnapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each read. */
    'runs.changed': RunsSnapshot
  }
}
