#!/usr/bin/env bun
/**
 * install.ts — one-shot Nirvana installer / setup.
 *
 * Patches every supported agent runtime's settings.json with our audit hooks,
 * verifies the toolchain (bun, PATH), and smoke-tests the audit pipe. Safe to
 * run multiple times — it won't duplicate hooks already wired.
 *
 * Currently configures:
 *   - Claude Code   → ~/.claude/settings.json      (PreToolUse + PostToolUse)
 *   - Gemini-CLI    → ~/.gemini/settings.json       (BeforeTool + AfterTool + SessionStart)
 *   - Antigravity   → ~/.antigravity/settings.json  (BeforeTool + AfterTool + SessionStart)
 *
 * Codex is NOT wired here: it has no granular settings.json hook mechanism
 * (PreToolUse/BeforeTool, etc.) — its config is ~/.codex/config.toml and audit
 * comes from session transcripts + the ~/.harness-logs jsonl fallback. Other
 * future agents (Cursor, …) plug in by adding entries to AGENTS_TO_INSTALL.
 *
 * Usage:
 *   nrv install            # install / repair hooks + verify toolchain
 *   nrv install --dry      # show what would change, don't write
 *   nrv install --uninstall  # remove our hooks (keeps user's other settings)
 *   nrv install --check    # report installation status, exit 0/1
 *   nrv install -h         # this message
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs, EXIT, log } from "../lib/bun-helpers.ts";

// ─── Marker that identifies hooks added by this script ────────────────
// Any hook whose command contains one of these tokens is "ours" and is
// safe to overwrite/remove. Keeps user-added hooks untouched.
const NIRVANA_TOKENS = ["audit-emit-from-hook.ts", "gemini-session-start.ts"];

// Shared skills tree (Option B): prefer ~/.nirvana/skills so the audit-hook
// command paths written into each runtime's settings.json survive removal of
// ~/.claude. Falls back to the legacy location during transition.
const SKILLS_DIR = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const HOOK_SCRIPT = path.join(SKILLS_DIR, "_shared", "scripts", "audit-emit-from-hook.ts");
const SESSION_START_SCRIPT = path.join(SKILLS_DIR, "_shared", "scripts", "gemini-session-start.ts");

interface HookSpec {
  matcher?: string;
  hooks: Array<{ name?: string; type: "command"; command: string; timeout?: number; async?: boolean }>;
}

interface AgentInstallSpec {
  name: string;                   // human label
  settingsPath: string;           // absolute path
  groups: Record<string, HookSpec[]>;  // hooks block keyed by event name
}

const AGENTS_TO_INSTALL: AgentInstallSpec[] = [
  {
    name: "Claude Code",
    settingsPath: path.join(os.homedir(), ".claude", "settings.json"),
    groups: {
      PreToolUse: [{
        matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
        hooks: [{
          name: "nirvana-audit-pre",
          type: "command",
          command: `bun ${HOOK_SCRIPT} pre claude-code 2>/dev/null || true`,
          async: true,
          timeout: 5,
        }],
      }],
      PostToolUse: [{
        matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
        hooks: [{
          name: "nirvana-audit-post",
          type: "command",
          command: `bun ${HOOK_SCRIPT} post claude-code 2>/dev/null || true`,
          async: true,
          timeout: 5,
        }],
      }],
    },
  },
  {
    name: "Gemini-CLI",
    settingsPath: path.join(os.homedir(), ".gemini", "settings.json"),
    groups: {
      BeforeTool: [{
        matcher: "write_file|replace|run_shell_command",
        hooks: [{
          name: "nirvana-audit-pre",
          type: "command",
          command: `bun ${HOOK_SCRIPT} pre gemini-cli 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
      AfterTool: [{
        matcher: "write_file|replace|run_shell_command",
        hooks: [{
          name: "nirvana-audit-post",
          type: "command",
          command: `bun ${HOOK_SCRIPT} post gemini-cli 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
      SessionStart: [{
        hooks: [{
          name: "nirvana-session-start",
          type: "command",
          command: `bun ${SESSION_START_SCRIPT} 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
    },
  },
  {
    // Antigravity 2.0 — the gemini-cli successor (same Google backend), so it
    // carries the same settings.json hook schema. If a future version diverges,
    // these extra keys are simply ignored — they never break the config.
    name: "Antigravity",
    settingsPath: path.join(os.homedir(), ".antigravity", "settings.json"),
    groups: {
      BeforeTool: [{
        matcher: "write_file|replace|run_shell_command",
        hooks: [{
          name: "nirvana-audit-pre",
          type: "command",
          command: `bun ${HOOK_SCRIPT} pre antigravity-cli 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
      AfterTool: [{
        matcher: "write_file|replace|run_shell_command",
        hooks: [{
          name: "nirvana-audit-post",
          type: "command",
          command: `bun ${HOOK_SCRIPT} post antigravity-cli 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
      SessionStart: [{
        hooks: [{
          name: "nirvana-session-start",
          type: "command",
          command: `bun ${SESSION_START_SCRIPT} 2>/dev/null || true`,
          timeout: 5000,
        }],
      }],
    },
  },
];

// ─── settings.json patcher (idempotent) ──────────────────────────────
function isOurHook(h: any): boolean {
  if (!h?.hooks) return false;
  return h.hooks.some((x: any) => typeof x?.command === "string" && NIRVANA_TOKENS.some(tok => x.command.includes(tok)));
}

function patchSettings(spec: AgentInstallSpec, mode: "install" | "uninstall"): { changed: boolean; before: any; after: any } {
  let current: any = {};
  if (fs.existsSync(spec.settingsPath)) {
    try { current = JSON.parse(fs.readFileSync(spec.settingsPath, "utf8")); }
    catch { /* keep empty — we'll overwrite a malformed file */ }
  }
  const before = JSON.parse(JSON.stringify(current || {}));
  current.hooks = current.hooks || {};

  for (const [event, ourGroups] of Object.entries(spec.groups)) {
    const existing = Array.isArray(current.hooks[event]) ? current.hooks[event] : [];
    // Drop our previous hooks (matched by token) — preserve everything else
    const userKept = existing.filter((g: any) => !isOurHook(g));
    if (mode === "install") {
      current.hooks[event] = [...userKept, ...ourGroups];
    } else {
      current.hooks[event] = userKept;
      if (current.hooks[event].length === 0) delete current.hooks[event];
    }
  }
  if (Object.keys(current.hooks).length === 0) delete current.hooks;

  const changed = JSON.stringify(before) !== JSON.stringify(current);
  return { changed, before, after: current };
}

function backup(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.nirvana-backup.${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

// ─── Toolchain checks ─────────────────────────────────────────────────
function checkBun(): { ok: boolean; path?: string } {
  for (const p of [process.execPath, "/opt/homebrew/bin/bun", "/usr/local/bin/bun", path.join(os.homedir(), ".bun", "bin", "bun")]) {
    if (p && fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) return { ok: true, path: p };
      } catch {}
    }
  }
  return { ok: false };
}

function checkPath(): { ok: boolean; missing: string[] } {
  const PATH = process.env.PATH || "";
  const expected = [path.join(os.homedir(), ".local", "bin")];
  const missing = expected.filter(d => !PATH.split(":").includes(d));
  return { ok: missing.length === 0, missing };
}

function checkScripts(): { ok: boolean; missing: string[] } {
  const required = [HOOK_SCRIPT, SESSION_START_SCRIPT];
  const missing = required.filter(p => !fs.existsSync(p));
  return { ok: missing.length === 0, missing };
}

// ─── Runtime dependency installer ─────────────────────────────────────
// A fresh `git clone` has no node_modules (gitignored) and no Python deps.
// The skill scripts hard-require them at runtime:
//   - JS: registry.js does require('../node_modules/yaml'), etc.
//   - Python: validators.py imports pydantic v2 (StringConstraints/ConfigDict).
// Without this step, the registry rebuild + business validation break on any
// machine that didn't accumulate the deps over time. Idempotent: re-running
// is a no-op when everything is already present.
function installDependencies(repoRoot: string, dry: boolean): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const skillsDir = path.join(repoRoot, "skills");
  const rootNodeModules = path.join(repoRoot, "node_modules");

  // 1) bun install at the repo root (package.json declares 3 pure-JS deps;
  //    SQLite is Bun's built-in bun:sqlite — no native module, no Python).
  const pkgJson = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgJson)) {
    const haveDeps = fs.existsSync(path.join(rootNodeModules, "yaml"))
                  && fs.existsSync(path.join(rootNodeModules, "zod"))
                  && fs.existsSync(path.join(rootNodeModules, "js-yaml"));
    if (haveDeps) {
      notes.push("npm deps already present (skip)");
    } else if (dry) {
      notes.push("would run: npm install (root)");
    } else {
      const installer = spawnSync("bun", ["install"], { cwd: repoRoot, encoding: "utf8" });
      if (installer.status !== 0) {
        const npmTry = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoRoot, encoding: "utf8" });
        notes.push(npmTry.status === 0 ? "npm install ok (npm fallback)" : `npm install FAILED: ${(npmTry.stderr || installer.stderr || "").slice(0, 200)}`);
      } else {
        notes.push("bun install ok");
      }
    }
  } else {
    notes.push("no root package.json — skipping npm");
  }

  // 2) Symlink each skill's node_modules → repo-root node_modules, so the
  //    scripts' require('../node_modules/X') resolves. Done in BOTH places the
  //    skills can run from:
  //      - the source repo (<repo>/skills/*)        — running scripts directly
  //      - the deployment   (~/.claude/skills/*)    — where Claude Code loads them
  //    The deployment is the one that actually matters at runtime (the scripts
  //    use paths.CLAUDE_SKILLS_DIR = ~/.claude/skills). Both kept in sync.
  const linkInto = (dir: string, label: string) => {
    if (!fs.existsSync(rootNodeModules) || !fs.existsSync(dir)) return;
    let n = 0;
    for (const skill of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!skill.isDirectory() && !skill.isSymbolicLink()) continue;
      const target = path.join(dir, skill.name, "node_modules");
      if (fs.existsSync(target)) continue;
      if (dry) { notes.push(`would link ${label}/${skill.name}/node_modules`); continue; }
      try { fs.symlinkSync(rootNodeModules, target, "dir"); n++; } catch { /* best-effort */ }
    }
    if (!dry && n > 0) notes.push(`${label}: linked node_modules in ${n} skills`);
  };
  linkInto(skillsDir, "repo");
  linkInto(SKILLS_DIR, "deployment");  // shared skills tree (~/.nirvana/skills)

  // 3) pip install Python deps (pydantic v2 + pyyaml) — ONLY if Python is
  //    present. The canonical validators run on Bun (validators.ts); the Python
  //    validators are an optional legacy mirror. A Bun-only machine skips this.
  const reqs = path.join(repoRoot, "requirements.txt");
  if (fs.existsSync(reqs)) {
    const haveP = spawnSync("python3", ["-c", "import pydantic,sys; sys.exit(0 if pydantic.VERSION.startswith('2') else 1)"], { encoding: "utf8" });
    const pythonPresent = !haveP.error && haveP.status !== null;
    if (haveP.status === 0) {
      notes.push("pydantic v2 already present (skip)");
    } else if (!pythonPresent) {
      notes.push("python3 not installed — skipping pip (validators run on Bun)");
    } else if (dry) {
      notes.push("would run: pip install -r requirements.txt");
    } else {
      let p = spawnSync("pip3", ["install", "-q", "-r", reqs], { cwd: repoRoot, encoding: "utf8" });
      if (p.status !== 0) {
        // PEP 668 externally-managed env (Ubuntu 24.04 etc)
        p = spawnSync("pip3", ["install", "-q", "--break-system-packages", "--ignore-installed", "-r", reqs], { cwd: repoRoot, encoding: "utf8" });
      }
      notes.push(p.status === 0 ? "pip install ok" : `pip install FAILED: ${(p.stderr || "").slice(0, 200)}`);
    }
  } else {
    notes.push("no requirements.txt — skipping pip");
  }

  const ok = !notes.some(n => n.includes("FAILED"));
  return { ok, notes };
}

// ─── Main ─────────────────────────────────────────────────────────────
function main() {
  const { flags } = parseArgs();
  if (flags.h || flags.help) {
    console.log(`nrv install — one-shot Nirvana setup

USAGE
  nrv install              install / repair hooks across all agents
  nrv install --dry        show what would change, don't write anything
  nrv install --check      report status (exit 0 = ready, 1 = needs setup)
  nrv install --uninstall  remove our hooks (keeps user's other settings)
  nrv install -h           this help

WHAT IT DOES
  1. Verifies toolchain (bun installed, PATH includes ~/.local/bin)
  2. Patches every agent's settings.json with audit hooks, idempotent
       - Claude Code: ~/.claude/settings.json (PreToolUse + PostToolUse)
       - Gemini-CLI:  ~/.gemini/settings.json  (BeforeTool/AfterTool/SessionStart)
  3. Creates timestamped backups before modifying any file
  4. Smoke-tests the audit pipe (writes a sentinel event)

After install, every Write/Edit/Bash by Claude Code OR Gemini-CLI lands in
~/.harness-logs/<today>/audit.jsonl automatically. Watch with 'nrv watch'
or open the cockpit with 'nrv glance'.
`);
    process.exit(EXIT.OK);
  }

  const dryRun = !!flags.dry;
  const uninstall = !!flags.uninstall;
  const check = !!flags.check;
  const mode = uninstall ? "uninstall" : "install";

  console.log(`Nirvana ${check ? "status check" : (mode === "install" ? "installer" : "uninstaller")}\n`);

  // Toolchain
  console.log("Toolchain");
  const bun = checkBun();
  console.log(`  ${bun.ok ? "✓" : "✗"} bun ${bun.ok ? `(${bun.path})` : "not found — install: https://bun.sh"}`);
  const pth = checkPath();
  console.log(`  ${pth.ok ? "✓" : "⚠"} PATH includes ~/.local/bin${pth.ok ? "" : ` — add: export PATH="$HOME/.local/bin:$PATH"`}`);
  const scripts = checkScripts();
  console.log(`  ${scripts.ok ? "✓" : "✗"} hook scripts present${scripts.ok ? "" : ` — missing: ${scripts.missing.join(", ")}`}`);

  if (!scripts.ok) {
    console.log("\n✗ Cannot proceed: hook scripts missing. Re-install Nirvana skills.");
    process.exit(EXIT.FAILURES);
  }

  // Runtime dependencies (npm + pip). Resolve the repo root from this script's
  // location: <repo>/skills/_shared/scripts/install.ts → up 3 levels. Falls
  // back to ~/.claude (deployment) if no package.json there (then deps come
  // from the source repo install). Skipped on uninstall.
  if (mode === "install") {
    console.log("\nDependencies");
    const here = path.dirname(new URL(import.meta.url).pathname);
    let repoRoot = path.resolve(here, "..", "..", "..");
    if (!fs.existsSync(path.join(repoRoot, "package.json"))) {
      // deployment layout (~/.claude/skills/...) — look for a sibling repo
      const guess = path.join(os.homedir(), "nirvana-os");
      if (fs.existsSync(path.join(guess, "package.json"))) repoRoot = guess;
    }
    const dep = installDependencies(repoRoot, !!flags.dry);
    for (const n of dep.notes) console.log(`  ${n.includes("FAILED") ? "✗" : "✓"} ${n}`);
    if (!dep.ok) console.log("  ⚠ some deps failed — registry/validators may not work until fixed");
  }

  // Per-agent
  console.log("\nAgents");
  let anyChange = false;
  let installedCount = 0;
  for (const spec of AGENTS_TO_INSTALL) {
    const exists = fs.existsSync(spec.settingsPath);
    if (!exists) {
      console.log(`  ◌ ${spec.name} — not installed (no ${spec.settingsPath})`);
      if (mode === "install" && !check && !dryRun) {
        // Create the dir + file with just our hooks
        fs.mkdirSync(path.dirname(spec.settingsPath), { recursive: true });
        const { after } = patchSettings(spec, "install");
        fs.writeFileSync(spec.settingsPath, JSON.stringify(after, null, 2) + "\n", "utf8");
        console.log(`     → created ${spec.settingsPath} with hooks`);
        anyChange = true;
        installedCount++;
      }
      continue;
    }
    const result = patchSettings(spec, mode);
    if (!result.changed) {
      console.log(`  ✓ ${spec.name} — already ${mode === "install" ? "installed" : "uninstalled"}`);
      if (mode === "install") installedCount++;
      continue;
    }
    if (check) {
      console.log(`  ⚠ ${spec.name} — needs ${mode}`);
      anyChange = true;
      continue;
    }
    if (dryRun) {
      console.log(`  ⚠ ${spec.name} — would ${mode}`);
      anyChange = true;
      continue;
    }
    const bak = backup(spec.settingsPath);
    fs.writeFileSync(spec.settingsPath, JSON.stringify(result.after, null, 2) + "\n", "utf8");
    console.log(`  ✓ ${spec.name} — ${mode}ed${bak ? ` (backup: ${path.basename(bak)})` : ""}`);
    anyChange = true;
    if (mode === "install") installedCount++;
  }

  // Smoke
  if (mode === "install" && !check && !dryRun) {
    console.log("\nSmoke");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const auditDir = path.join(os.homedir(), ".harness-logs", today);
      fs.mkdirSync(auditDir, { recursive: true });
      const file = path.join(auditDir, "audit.jsonl");
      const sentinel = { ts: new Date().toISOString(), trace_id: "nirvana-install-smoke", host: "nirvana-installer", event: "watch_started", cwd: process.cwd() };
      fs.appendFileSync(file, JSON.stringify(sentinel) + "\n", "utf8");
      console.log(`  ✓ wrote sentinel event to ${file}`);
      console.log(`  → verify: tail -1 ${file}`);
    } catch (e: any) {
      console.log(`  ✗ smoke failed: ${e.message}`);
    }
  }

  // Summary
  console.log("");
  if (check) {
    process.exit(anyChange ? EXIT.FAILURES : EXIT.OK);
  }
  if (dryRun) {
    console.log("(dry run — no files modified)");
    process.exit(EXIT.OK);
  }
  if (mode === "install") {
    if (installedCount === 0) {
      console.log("Done. No agents detected — install Claude Code and/or Gemini-CLI, then re-run.");
    } else {
      console.log(`Done. ${installedCount} agent(s) configured. New sessions will emit audit events automatically.`);
      console.log(`Watch with: ${anyChange ? "(may need to restart your agent for hooks to load) " : ""}nrv watch  or  nrv glance --allow-actions`);
    }
  } else {
    console.log("Done. Hooks removed. Other settings preserved.");
  }
  process.exit(EXIT.OK);
}

main();
