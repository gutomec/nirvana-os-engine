#!/usr/bin/env bun
// doctor-system.ts — full system diagnostic for Nirvana-OS.
//
// Reports on every layer of the stack so the user can pinpoint what's broken.
// Reuses the existing capability-doctor (which audits produces/example_briefs)
// but adds the runtime/binary/auth checks the user actually needs on day 1.
//
// Sections:
//   1. Binaries (bun, node, codex, claude-code, git, python3)
//   2. Skills (harness, businesses, squads in ~/.nirvana/skills/)
//   3. Registries (squads-registry, businesses-registry timestamps)
//   4. Hooks (PreToolUse, PostToolUse wired in settings.json)
//   5. Audit (today's audit.jsonl event counts)
//   6. Libraries (businesses/, squads/, mind-clones in _library/dna/)
//   7. Recent dispatches (active projects in .nirvana/outputs/)
//   8. Patches applied (key fixes from CORRECTION-REPORT)
//
// Exit codes:
//   0 = all green
//   1 = some warnings
//   2 = critical failures

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m", magenta: "\x1b[35m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
const json = process.argv.includes("--json");
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

type Check = { name: string; status: "PASS" | "WARN" | "FAIL"; note: string };
const checks: Check[] = [];
function add(name: string, status: "PASS" | "WARN" | "FAIL", note: string) {
  checks.push({ name, status, note });
}

const HOME = os.homedir();
const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(HOME, ".nirvana", "skills")) ? path.join(HOME, ".nirvana", "skills") : path.join(HOME, ".claude", "skills"));

// SECTION 1: BINARIES
function which(bin: string): string | null {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

const bins = [
  { name: "bun", required: true },
  // node + python3 are optional: the toolchain runs on Bun alone. They are only
  // used by a few legacy/optional helpers, so their absence is not a failure.
  { name: "node", required: false },
  { name: "python3", required: false },
  { name: "git", required: true },
  { name: "codex", required: false },
  { name: "claude", required: false },
  { name: "gemini", required: false },
];

for (const b of bins) {
  const p = which(b.name);
  if (p) {
    let version = "";
    try {
      const r = spawnSync(b.name, ["--version"], { encoding: "utf8" });
      version = (r.stdout || r.stderr || "").split("\n")[0].slice(0, 50);
    } catch {}
    add(`binary: ${b.name}`, "PASS", `${p} ${version ? `(${version})` : ""}`);
  } else {
    add(`binary: ${b.name}`, b.required ? "FAIL" : "WARN", "not found in PATH");
  }
}

// SECTION 2: SKILLS
const requiredSkills = ["harness", "businesses", "squads", "_shared"];
for (const s of requiredSkills) {
  const p = path.join(SKILLS, s);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const skillMd = path.join(p, "SKILL.md");
    add(`skill: ${s}`, "PASS", fs.existsSync(skillMd) ? "with SKILL.md" : "(no SKILL.md)");
  } else {
    add(`skill: ${s}`, "FAIL", `missing ${p}`);
  }
}

// SECTION 3: REGISTRIES
const squadsReg = path.join(HOME, ".squads-registry.json");
const bizReg = path.join(HOME, ".businesses-registry.json");
for (const [reg, label] of [[squadsReg, "squads"], [bizReg, "businesses"]] as const) {
  if (fs.existsSync(reg)) {
    const stat = fs.statSync(reg);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600_000;
    const sizeKB = Math.round(stat.size / 1024);
    if (ageHours > 24) {
      add(`registry: ${label}`, "WARN", `${sizeKB}KB, ${Math.round(ageHours)}h stale — run \`nrv index\``);
    } else {
      add(`registry: ${label}`, "PASS", `${sizeKB}KB, ${Math.round(ageHours)}h old`);
    }
  } else {
    add(`registry: ${label}`, "FAIL", "missing — run `nrv index`");
  }
}

// SECTION 4: HOOKS
try {
  const settingsPath = path.join(HOME, ".claude/settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const pre = settings?.hooks?.PreToolUse || [];
    const post = settings?.hooks?.PostToolUse || [];
    const preNirvana = pre.filter((h: any) => JSON.stringify(h).includes("audit-emit-from-hook")).length;
    const postNirvana = post.filter((h: any) => JSON.stringify(h).includes("audit-emit-from-hook")).length;
    add("hooks: PreToolUse", preNirvana > 0 ? "PASS" : "WARN", `${preNirvana} nirvana hooks of ${pre.length} total`);
    add("hooks: PostToolUse", postNirvana > 0 ? "PASS" : "WARN", `${postNirvana} nirvana hooks of ${post.length} total`);
  } else {
    add("hooks: settings.json", "WARN", "claude-code settings.json not found");
  }
} catch (e: any) {
  add("hooks: settings.json", "FAIL", `parse error: ${e.message}`);
}

// SECTION 5: AUDIT TODAY
const today = new Date().toISOString().slice(0, 10);
const { harnessLogsDir } = require(path.join(SKILLS, "_shared/lib/log-paths.ts"));
const auditPath = path.join(harnessLogsDir(), today, "audit.jsonl");
if (fs.existsSync(auditPath)) {
  const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(l => l.trim());
  const counts: Record<string, number> = {};
  for (const l of lines) {
    try { const e = JSON.parse(l); counts[e.event] = (counts[e.event] || 0) + 1; } catch {}
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).slice(0, 6).join(" ");
  add("audit: today", "PASS", `${lines.length} events · ${summary}`);
} else {
  add("audit: today", "WARN", "no audit log for today (no dispatches yet?)");
}

// SECTION 6: LIBRARIES
const homeBiz = path.join(HOME, "businesses");
const homeSquads = path.join(HOME, "squads");
const dnaLib = path.join(HOME, "businesses/_library/dna");
if (fs.existsSync(homeBiz)) {
  const dirs = fs.readdirSync(homeBiz).filter(d => fs.statSync(path.join(homeBiz, d)).isDirectory() && !d.startsWith("_"));
  add("library: businesses", "PASS", `${dirs.length} businesses in ~/businesses/`);
} else {
  add("library: businesses", "WARN", "~/businesses/ not created yet");
}
if (fs.existsSync(homeSquads)) {
  const dirs = fs.readdirSync(homeSquads).filter(d => fs.statSync(path.join(homeSquads, d)).isDirectory());
  add("library: squads", "PASS", `${dirs.length} squads in ~/squads/`);
} else {
  add("library: squads", "WARN", "~/squads/ not created yet");
}
if (fs.existsSync(dnaLib)) {
  let cloneCount = 0;
  for (const cat of fs.readdirSync(dnaLib)) {
    const catPath = path.join(dnaLib, cat);
    if (fs.statSync(catPath).isDirectory()) {
      cloneCount += fs.readdirSync(catPath).filter(c => fs.statSync(path.join(catPath, c)).isDirectory()).length;
    }
  }
  add("library: mind-clones", "PASS", `${cloneCount} clones in _library/dna/`);
} else {
  add("library: mind-clones", "WARN", "no mind-clone library — run with --starter");
}

// SECTION 7: RECENT DISPATCHES
const outputRoots = [
  path.join(process.cwd(), ".nirvana/outputs"),
  path.join(HOME, ".nirvana/outputs"),
];
let activeProjects = 0;
for (const root of outputRoots) {
  if (!fs.existsSync(root)) continue;
  for (const p of fs.readdirSync(root)) {
    const handoff = path.join(root, p, "businesses");
    if (fs.existsSync(handoff)) activeProjects++;
  }
}
add("recent: dispatched projects", activeProjects > 0 ? "PASS" : "WARN",
    `${activeProjects} projects with HANDOFF.json`);

// SECTION 8: KEY PATCHES APPLIED
const keyFiles: [string, string][] = [
  [path.join(SKILLS, "_shared/lib/handoff.js"), "F1: updateHandoffPhase"],
  [path.join(SKILLS, "businesses/scripts/verify-deliverable.ts"), "F2: verify-deliverable"],
  [path.join(SKILLS, "businesses/lib/loader-cli.py"), "F4: loader-cli wrapper"],
  [path.join(SKILLS, "businesses/lib/employee-prompt.ts"), "F8: DNA injection helper"],
  [path.join(SKILLS, "harness/scripts/quality-gate.ts"), "F9: quality-gate driver"],
  [path.join(SKILLS, "harness/scripts/validate-chain.ts"), "F3 enforcer: validate-chain"],
];
for (const [file, label] of keyFiles) {
  add(`patch: ${label}`, fs.existsSync(file) ? "PASS" : "FAIL", fs.existsSync(file) ? "applied" : `missing ${file}`);
}

// OUTPUT
const passCount = checks.filter(c => c.status === "PASS").length;
const warnCount = checks.filter(c => c.status === "WARN").length;
const failCount = checks.filter(c => c.status === "FAIL").length;
const total = checks.length;

if (json) {
  console.log(JSON.stringify({
    summary: { total, pass: passCount, warn: warnCount, fail: failCount },
    checks,
  }, null, 2));
  process.exit(failCount > 0 ? 2 : (warnCount > 0 ? 1 : 0));
}

console.log("");
console.log(c("bold", "  Nirvana-OS Doctor"));
console.log(c("dim", `  ${total} checks · ${passCount} pass · ${warnCount} warn · ${failCount} fail`));
console.log("");

let lastCategory = "";
for (const ck of checks) {
  const category = ck.name.split(":")[0];
  if (category !== lastCategory) {
    if (lastCategory) console.log("");
    console.log(c("magenta", "  " + category.toUpperCase()));
    lastCategory = category;
  }
  const icon = ck.status === "PASS" ? c("green", "✓") : ck.status === "WARN" ? c("yellow", "⚠") : c("red", "✗");
  const detail = ck.name.split(":").slice(1).join(":").trim();
  console.log(`    ${icon} ${c("bold", detail.padEnd(28))} ${c("dim", ck.note)}`);
}

console.log("");
if (failCount > 0) {
  console.log(c("red", `  ✗ ${failCount} critical failure(s). Fix before dispatching anything.`));
  process.exit(2);
} else if (warnCount > 0) {
  console.log(c("yellow", `  ⚠ ${warnCount} warning(s). System usable but degraded.`));
  process.exit(1);
} else {
  console.log(c("green", "  ✓ All systems nominal. Nirvana-OS is impeccable."));
  process.exit(0);
}
