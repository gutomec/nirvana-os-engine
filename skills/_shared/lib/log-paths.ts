// log-paths.ts — typed ESM face of log-paths.js.
//
// The implementation lives in the CJS sibling so a `.js` caller
// (context-budget.js) can `require()` it directly, and so the project-root
// walk it depends on (project-root.js) never crosses the ESM boundary that
// only Windows' Bun enforces as a hard error for a `.ts` whose dependency
// chain carries a top-level await (require() of an ESM module throws
// "require() async module" there, and tolerates it on macOS/ubuntu). An ESM
// `import` of a CJS module never crosses that broken boundary, on any
// platform — mirrors brief-excerpt.ts/.js.
//
// All read/write callers (audit emit, audit-view, validate-chain, quality-gate,
// employee-prompt, doctor, tui, baseline, etc.) MUST use this helper. Hardcoded
// `~/.harness-logs` paths create split brain: writes go per-project, reads still
// hit $HOME, the audit chain breaks.
//
// Resolution order (first match wins):
//   1. $HARNESS_LOGS_DIR (explicit override, honored everywhere)
//   2. <projectRoot>/.nirvana/logs/harness/   (when running inside a project)
//   3. ~/.harness-logs/                       (fallback, no project context)

import * as impl from "./log-paths.js";

export interface LogPathsOptions {
  cwd?: string;
  projectRoot?: string | null;
}

export const harnessLogsDir: (opts?: LogPathsOptions) => string = impl.harnessLogsDir;
export const maestroLogsDir: (opts?: LogPathsOptions) => string = impl.maestroLogsDir;
export const todayAuditFile: (opts?: LogPathsOptions) => string = impl.todayAuditFile;
