#!/usr/bin/env bun
// check-skillmd-command-parity.ts — parity gate between the commands the
// docs tell the model to run and the commands that actually exist.
//
// Extracts:
//   - `nrv <subcommand>` mentions from skills/harness/SKILL.md,
//     skills/harness/references/*.md, and the AUTONOMOUS_DIRECTIVE block in
//     skills/harness/lib/host-agent-driver.ts;
//   - backticked star-commands (`*audit`, `*find`, ...) from the same
//     markdown files — the in-skill quick-command surface that is expected
//     to map onto nrv subcommands.
//
// Diffs against the command table (skills/harness/lib/commands.ts: names +
// aliases + META) and the bin/nrv bash case labels, and reports mentions of
// commands that exist nowhere (the phantom set — `inspect-squad`, `*cost`,
// `*list`, `*inspect`, `*brief` — was purged in routing-360 Phase 5).
// Default run is report-only (exit 0); --strict exits 1 when any nonexistent
// command is mentioned, and is wired into `bun run check:all`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, META_NAMES } from "../skills/harness/lib/commands.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");

// ── known command surface ───────────────────────────────────────────────────

const keep = (tok: string): boolean => tok !== "" && tok !== "*" && !tok.startsWith("-");
const clean = (tok: string): string => tok.replace(/^["']|["']$/g, "");

const known = new Set<string>();
for (const c of COMMANDS) {
  known.add(c.name);
  for (const a of c.aliases ?? []) if (keep(a)) known.add(a);
}
for (const n of META_NAMES) known.add(n);
// bin/nrv bash case labels (same pattern as scripts/check-cli-parity.ts).
{
  const src = readFileSync(join(ROOT, "bin", "nrv"), "utf8");
  for (const m of src.matchAll(/^ {2}(\S[^)\n]*)\)/gm)) {
    for (const raw of m[1].split("|")) {
      const tok = clean(raw);
      if (keep(tok)) known.add(tok);
    }
  }
}

// ── doc sources ─────────────────────────────────────────────────────────────

interface Source { label: string; text: string; }

function autonomousDirectiveBlock(): string {
  const file = join(SKILLS, "harness", "lib", "host-agent-driver.ts");
  const src = readFileSync(file, "utf8");
  const start = src.indexOf("export const AUTONOMOUS_DIRECTIVE");
  if (start === -1) return "";
  const end = src.indexOf("].join", start);
  return end === -1 ? "" : src.slice(start, end);
}

const sources: Source[] = [];
{
  const skillMd = join(SKILLS, "harness", "SKILL.md");
  sources.push({ label: "skills/harness/SKILL.md", text: readFileSync(skillMd, "utf8") });
  const refsDir = join(SKILLS, "harness", "references");
  for (const f of readdirSync(refsDir).filter((n) => n.endsWith(".md")).sort()) {
    sources.push({ label: `skills/harness/references/${f}`, text: readFileSync(join(refsDir, f), "utf8") });
  }
  sources.push({ label: "skills/harness/lib/host-agent-driver.ts (AUTONOMOUS_DIRECTIVE)", text: autonomousDirectiveBlock() });
}

// ── mention extraction ──────────────────────────────────────────────────────

interface Mention { command: string; form: "nrv" | "star"; sources: string[]; }

const mentions = new Map<string, Mention>();
function add(command: string, form: "nrv" | "star", label: string) {
  const key = `${form}:${command}`;
  const m = mentions.get(key) || { command, form, sources: [] };
  if (!m.sources.includes(label)) m.sources.push(label);
  mentions.set(key, m);
}

for (const { label, text } of sources) {
  // nrv subcommand mentions ("nrv audit emit" counts as subcommand "audit").
  for (const m of text.matchAll(/\bnrv\s+([a-z][a-z0-9-]*)\b/g)) add(m[1], "nrv", label);
  // Backticked star-commands: `*cost ...` (markdown only; the directive block
  // has none, and the regex simply finds nothing there).
  for (const m of text.matchAll(/`\*([a-z][a-z0-9-]*)/g)) add(m[1], "star", label);
}

// ── report ──────────────────────────────────────────────────────────────────

const strict = process.argv.includes("--strict");
const all = [...mentions.values()].sort((a, b) => a.command.localeCompare(b.command));
const missing = all.filter((m) => !known.has(m.command));
const ok = all.filter((m) => known.has(m.command));

console.log(`SKILL.md COMMAND PARITY${strict ? " (--strict)" : " (report-only)"}`);
console.log(`  known commands (table + aliases + bin/nrv) . ${known.size}`);
console.log(`  distinct doc mentions ...................... ${all.length} (${ok.length} exist, ${missing.length} do not)`);
console.log("");

console.log(`MENTIONED but NONEXISTENT (${missing.length}):`);
if (missing.length === 0) console.log("  (none)");
for (const m of missing) {
  const shown = m.form === "star" ? `*${m.command}` : `nrv ${m.command}`;
  console.log(`  ${shown.padEnd(18)} <- ${m.sources.join(", ")}`);
}
console.log("");

console.log(`Existing commands mentioned in the docs (${ok.length}):`);
console.log("  " + ok.map((m) => (m.form === "star" ? `*${m.command}` : m.command)).join(" · "));

if (strict && missing.length > 0) process.exit(1);
process.exit(0);
