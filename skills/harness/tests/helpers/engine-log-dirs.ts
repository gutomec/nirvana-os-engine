// engine-log-dirs.ts — point the cockpit's log readers at a fixture, on any machine.
//
// Setting HARNESS_LOGS_DIR / MAESTRO_LOGS_DIR is not enough, and the reason is a
// trap worth naming: `_shared/lib/paths.js` exports a plain object resolved ONCE
// at require time (its own comment says so), and `bun-helpers.ts` caches that
// module. `invalidatePathsCache()` only drops bun-helpers' reference, so the next
// read re-requires the SAME frozen object out of the require cache and answers
// with the values captured when the first test file in the process loaded it.
// `listProjects`, `tailLogs`, `listAvailableLogDates` and `tailJsonlEvents` all
// read that object, so a file that runs second in a `bun test a.ts b.ts` gets the
// first file's directories. Alone it passes; in a suite it does not.
//
// Which copy is frozen is machine-dependent, and that is the second half of the
// trap. `bun-helpers` resolves `paths.js` under NIRVANA_SKILLS_DIR, else
// ~/.nirvana/skills, else ~/.claude/skills, and only then next to itself in the
// working tree. On a developer machine with the engine installed it holds the
// INSTALLED copy; on CI it holds the repository's. Pinning one of them is a test
// that is green on exactly one of the two. So every candidate that exists gets
// pinned, and restored.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const KEYS = ["HARNESS_LOGS_DIR", "MAESTRO_LOGS_DIR"] as const;
type LogKey = (typeof KEYS)[number];

function candidates(): Record<string, string>[] {
  const roots = [
    process.env.NIRVANA_SKILLS_DIR,
    path.join(os.homedir(), ".nirvana", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  ].filter(Boolean) as string[];
  const files = roots.map(root => path.join(root, "_shared", "lib", "paths.js"));
  files.push(path.resolve(import.meta.dir, "..", "..", "..", "_shared", "lib", "paths.js"));

  const loaded: Record<string, string>[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    try { loaded.push(require_(file)); } catch { /* a candidate that will not load is not the one in use */ }
  }
  return loaded;
}

export interface PinnedLogDirs {
  /** Point every reader at these directories. */
  use(dirs: Partial<Record<LogKey, string>>): void;
  /** Put back what was there, variables included. */
  restore(): void;
}

/** Pin the engine's log directories for the life of one test file. */
export function pinLogDirs(): PinnedLogDirs {
  const modules = candidates();
  const originalModules = modules.map(m => ({ module: m, values: Object.fromEntries(KEYS.map(k => [k, m[k]])) }));
  const originalEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]])) as Record<LogKey, string | undefined>;

  return {
    use(dirs) {
      for (const key of KEYS) {
        const value = dirs[key];
        if (!value) continue;
        // The variable serves log-paths.ts, which re-reads it on every call
        // (buildRuns); the module property serves the frozen snapshot.
        process.env[key] = value;
        for (const module of modules) module[key] = value;
      }
    },
    restore() {
      for (const key of KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key]!;
      }
      for (const { module, values } of originalModules) Object.assign(module, values);
    },
  };
}
