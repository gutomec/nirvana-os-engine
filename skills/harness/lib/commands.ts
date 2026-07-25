// commands.ts — the SINGLE SOURCE OF TRUTH for the nrv command surface.
//
// Every subcommand is declared once here. Three consumers read this table so
// they can never silently diverge again:
//   1. bin/nrv (bash dispatcher)        — verified against this table
//   2. skills/harness/scripts/nrv.ts    — verified against this table (Windows)
//   3. the help text                    — GENERATED from this table (renderHelp)
//
// scripts/check-cli-parity.ts gates that (1) and (2) declare exactly the names
// here and that every non-custom target file exists. Adding/renaming a command
// is a one-line edit here; the parity check forces the dispatchers to follow.

export type Visibility = "user" | "dev";
export interface Command {
  name: string;            // canonical subcommand
  aliases?: string[];      // alternate names accepted by the dispatcher
  target?: string;         // script path relative to the skills root (omit for custom dispatch)
  custom?: boolean;        // dispatch has hand-written logic (overloading, sub-cases) — not a plain exec
  category: string;        // grouping key (see CATEGORY_ORDER)
  summary: string;         // one-line help
  visibility: Visibility;  // user = listed in main help; dev = listed under ADVANCED
  args?: string;           // optional arg hint shown in help
}

export const CATEGORY_ORDER = [
  "first-run", "install", "core", "dispatch", "distribution", "qol", "project", "libraries", "license", "dev",
] as const;

export const CATEGORY_TITLE: Record<string, string> = {
  "first-run": "FIRST RUN",
  install: "INSTALL & LIFECYCLE",
  core: "CORE",
  dispatch: "DISPATCH & EXECUTE",
  distribution: "DISTRIBUTION",
  qol: "QUALITY OF LIFE",
  project: "PROJECT",
  libraries: "LIBRARIES",
  license: "LICENSE",
  dev: "ADVANCED / DEV (not needed day to day)",
};

// Meta entries (version/help) exist in the dispatchers but are not listed as
// commands in the help body. The parity check knows to expect them.
export const META_NAMES = new Set(["version", "help"]);

export const COMMANDS: Command[] = [
  // meta (custom; not listed in help body)
  { name: "version", aliases: ["--version", "-v", "-V"], custom: true, category: "first-run", summary: "Print version + edition", visibility: "user" },
  { name: "help", aliases: ["--help", "-h"], custom: true, category: "first-run", summary: "Show this help", visibility: "user" },

  // install & lifecycle
  { name: "install", custom: true, category: "install", args: "<source> | --bootstrap | --check", summary: "Install an asset (squad/business/clone/pack); --bootstrap wires audit hooks", visibility: "user" },
  { name: "uninstall", custom: true, category: "install", args: "<name> | --engine | --hooks", summary: "Remove an asset, the engine (keeps content), or just the hooks", visibility: "user" },
  { name: "installed", aliases: ["list-installed"], target: "_shared/scripts/list-installed.ts", category: "install", summary: "List active installations", visibility: "user" },
  { name: "update", aliases: ["self-update", "upgrade"], target: "harness/scripts/update.ts", category: "install", args: "[--check]", summary: "Update the engine: git pull (dev) or re-fetch the latest release (npx)", visibility: "user" },

  // core
  { name: "glance", target: "harness/scripts/glance.ts", category: "core", args: "[--allow-actions]", summary: "Open the Glance web cockpit", visibility: "user" },
  { name: "tui", aliases: ["cockpit-tui"], target: "harness/scripts/tui.ts", category: "core", summary: "Terminal cockpit (live audit + projects + registries)", visibility: "user" },
  { name: "doctor", aliases: ["capability-doctor"], custom: true, category: "core", args: "[--system|--capability]", summary: "Full system diagnostic", visibility: "user" },
  { name: "route", target: "harness/scripts/route.ts", category: "core", args: '"<brief>"', summary: "Route a brief (HIGH/AMBIGUOUS/NO_MATCH)", visibility: "user" },
  { name: "find", target: "harness/scripts/find.ts", category: "core", args: '"<query>"', summary: "Dry-run capability discovery", visibility: "user" },
  { name: "validate", target: "harness/scripts/validate.ts", category: "core", summary: "Self-test (delegates to doctor: binaries, skills, registries, hooks)", visibility: "user" },
  { name: "index", target: "harness/scripts/index.ts", category: "core", summary: "Re-index squads + businesses", visibility: "user" },

  // dispatch & execute
  { name: "dispatch", target: "harness/scripts/dispatch.ts", category: "dispatch", args: '<business> "<brief>"', summary: "Scaffold a run (brief + DNA injection + audit; no exec)", visibility: "user" },
  { name: "run", aliases: ["autopilot"], custom: true, category: "dispatch", args: '<business> "<brief>" [--zip --pdf --html]', summary: "Autopilot: dispatch + execute + verify + gate", visibility: "user" },
  { name: "auto", custom: true, category: "dispatch", args: '"<brief>" [--zip --pdf --html]', summary: "Autopilot with auto-selected business (= run --auto)", visibility: "user" },
  { name: "revise", target: "harness/scripts/revise.ts", category: "dispatch", args: '<project> "<change>"', summary: "Apply a change keeping the same runtime session", visibility: "user" },
  { name: "ask", target: "harness/scripts/ask.ts", category: "dispatch", args: "<clone> [question]", summary: "Talk to a single mind-clone (DNA injected)", visibility: "user" },
  { name: "launch", target: "harness/scripts/launch.ts", category: "dispatch", args: "<name> [--pillars=...]", summary: "Scaffold a multi-pillar 360 launch", visibility: "user" },
  { name: "clean", aliases: ["clean-project", "purge"], target: "harness/scripts/clean-project.ts", category: "dispatch", args: "<project> [--hard]", summary: "Remove a project scaffold (trash by default)", visibility: "user" },

  // distribution
  { name: "pack", target: "harness/scripts/pack.ts", category: "distribution", args: "create|inspect|publish", summary: "Bundle / inspect / publish an asset pack", visibility: "dev" },

  // quality of life
  { name: "audit-view", aliases: ["audit"], target: "harness/scripts/audit-view.ts", category: "qol", args: "<project>", summary: "Chronological viewer of a project's audit chain", visibility: "user" },
  { name: "search", target: "harness/scripts/search.ts", category: "qol", args: '"<query>"', summary: "Keyword + BM25 search across your libraries", visibility: "user" },
  { name: "export", target: "harness/scripts/export.ts", category: "qol", args: "<project>", summary: "Bundle a project's outputs (.zip/.tgz)", visibility: "user" },

  // project
  { name: "init", aliases: ["init-project"], target: "_shared/scripts/init-project.ts", category: "project", args: "<dir> [--copy|--scope=project]", summary: "Create a new Nirvana project", visibility: "user" },
  { name: "resume", aliases: ["resume-project"], target: "_shared/scripts/resume-project.ts", category: "project", args: "<project>", summary: "Resume an incomplete project", visibility: "user" },

  // libraries
  { name: "list-squads", aliases: ["squads-list"], target: "squads/scripts/list-squads.ts", category: "libraries", summary: "List squads in your library", visibility: "user" },
  { name: "list-businesses", aliases: ["businesses-list"], target: "businesses/scripts/list-businesses.ts", category: "libraries", summary: "List businesses in your library", visibility: "user" },
  { name: "list-clones", aliases: ["clones-list", "list-mind-clones", "mind-clones"], target: "_shared/scripts/list-clones.ts", category: "libraries", summary: "List mind-clones in your DNA library", visibility: "user" },
  { name: "inspect-clone", aliases: ["clone-inspect", "inspect-mind-clone"], target: "_shared/scripts/inspect-clone.ts", category: "libraries", args: "<slug>", summary: "Inspect a single mind-clone", visibility: "user" },
  { name: "find-clone", aliases: ["clone-find", "find-mind-clone"], target: "_shared/scripts/find-clone.ts", category: "libraries", args: '"<query>"', summary: "Find a mind-clone by query", visibility: "user" },

  // license
  { name: "license", aliases: ["verify-license", "whoami"], target: "_shared/scripts/license.ts", category: "license", args: "[status|check|activate]", summary: "Show your copy's provenance; activate or heartbeat-check (offline-safe)", visibility: "user" },

  // advanced / dev
  { name: "setup", target: "_shared/scripts/install.ts", category: "dev", summary: "Re-wire audit hooks (= install --bootstrap)", visibility: "dev" },
  { name: "install-content", target: "_shared/scripts/install-content.ts", category: "dev", args: "<dir> --slug <slug>", summary: "Overlay a content pack onto the engine (used by a pack's setup.ts)", visibility: "dev" },
  { name: "use-businesses", aliases: ["business", "businesses"], target: "harness/scripts/route.ts", category: "dev", summary: "Route forcing business-first preference", visibility: "dev" },
  { name: "use-squads", aliases: ["squad", "squads"], target: "harness/scripts/route.ts", category: "dev", summary: "Route forcing squad-first preference", visibility: "dev" },
  { name: "watch", aliases: ["tail"], target: "harness/scripts/watch.ts", category: "dev", summary: "Tail audit events live in the terminal", visibility: "dev" },
  { name: "watch-fs", aliases: ["fswatch"], target: "harness/scripts/watch-fs.ts", category: "dev", summary: "Filesystem-evidence audit daemon (defense-in-depth)", visibility: "dev" },
  { name: "baseline", target: "harness/scripts/baseline.ts", category: "dev", summary: "Snapshot system KPIs from the audit log", visibility: "dev" },
  { name: "improver", target: "harness/scripts/improver.ts", category: "dev", summary: "Meta-Nirvana: mine the audit log, propose improvements", visibility: "dev" },
  { name: "embeddings", aliases: ["embedder"], target: "harness/scripts/embeddings.ts", category: "dev", args: "<status|enable|disable|reindex>", summary: "Optional neural dense arm for the router (BM25 + embeddings via RRF)", visibility: "dev" },
  { name: "gate", custom: true, category: "dev", summary: "Quality gate (voice-fidelity)", visibility: "dev" },
  { name: "guard", target: "harness/scripts/guard.ts", category: "dev", args: "tick --project <dir> --action <sig>", summary: "Loop-guard tick — circuit breaker for the maestro loop", visibility: "dev" },
  { name: "fix-squad", aliases: ["doctor-squad"], target: "squads/scripts/fix-squad.ts", category: "libraries", args: "<slug|path> [--apply]", summary: "Diagnose and auto-fix a squad", visibility: "user" },
  { name: "memory", aliases: ["mem"], target: "harness/scripts/memory.ts", category: "qol", args: "<add|list|supersede> ...", summary: "Temporal cross-session memory (supersede-never-delete)", visibility: "user" },
  { name: "validate-chain", aliases: ["chain-validate", "chain"], target: "harness/scripts/validate-chain.ts", category: "dev", args: "<project> [--strict|--all]", summary: "Audit-chain integrity check", visibility: "dev" },
  { name: "validate-trace", aliases: ["trace-validate"], target: "harness/scripts/validate-trace.ts", category: "dev", summary: "Validate a single audit trace", visibility: "dev" },
  { name: "validate-mind-clones", aliases: ["mc-validate"], target: "_shared/scripts/validate-mind-clones.ts", category: "dev", summary: "Audit mind-clone canonical files", visibility: "dev" },
  { name: "pack-manifest", aliases: ["gen-pack-manifest"], target: "_shared/scripts/gen-pack-manifest.ts", category: "dev", summary: "Generate a pack manifest", visibility: "dev" },
  { name: "validate-starter", aliases: ["starter-validate"], custom: true, category: "dev", summary: "Dev-only: validate a starter/content pack (needs the source repo)", visibility: "dev" },
];

/** Render the full `nrv` help text from the table. The one help source. */
export function renderHelp(): string {
  const lines: string[] = [];
  lines.push("nrv — Nirvana harness master command", "", "USAGE", "  nrv <subcommand> [args]", "");
  const pad = (s: string) => (s.length >= 30 ? s + " " : s.padEnd(30));
  for (const cat of CATEGORY_ORDER) {
    const cmds = COMMANDS.filter((c) => c.category === cat && c.visibility !== "dev" || (cat === "dev" && c.visibility === "dev"));
    // dev category: list compactly; others: full lines
    const inCat = COMMANDS.filter((c) => c.category === cat && !META_NAMES.has(c.name) && (cat === "dev" ? true : c.visibility === "user"));
    if (inCat.length === 0) continue;
    lines.push(CATEGORY_TITLE[cat] || cat.toUpperCase());
    if (cat === "dev") {
      const names = inCat.map((c) => c.name).join(" · ");
      lines.push("  " + names, "  These still work; run `nrv <cmd> --help` for details.");
    } else {
      for (const c of inCat) {
        const left = `  ${c.name}${c.args ? " " + c.args : ""}`;
        lines.push(`${pad(left)} ${c.summary}`);
      }
    }
    lines.push("");
  }
  lines.push("For each subcommand, pass --help to see its full options.");
  return lines.join("\n");
}
