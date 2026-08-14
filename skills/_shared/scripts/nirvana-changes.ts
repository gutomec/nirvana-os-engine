#!/usr/bin/env bun
// nirvana-changes.ts — generates and queries the artifacts' contract surface.
//
//   gen <dir...> [--dry]     regenerates the surface, derives the bump and writes
//                            .nirvana-surface.json + CHANGES.json + CHANGELOG.md
//   gen --all [--dry]        sweeps ~/squads, ~/businesses and the clone library
//   diff <installed> <new>   compares two directories of the SAME artifact (JSON)
//   show <dir>               prints the current surface
//
// Idempotency is contract: running `gen` twice without touching anything must NOT
// change a single byte. The surface file enters the install's hashDir(), and an
// unstable generator would mark every artifact as updated on each build.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractSurface, readSurface, writeSurface, serializeSurface,
  detectKind, SURFACE_FILE, type Surface,
} from "../lib/surface.ts";
import { diffSurfaces, mergeBehaviorNotes, renderChangelogEntry, type DiffResult } from "../lib/surface-diff.ts";

const BEHAVIOR_FILE = ".nirvana-behavior.md";
const CHANGES_FILE = "CHANGES.json";
const CHANGELOG_FILE = "CHANGELOG.md";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.slice(1).filter((a) => !a.startsWith("--"));
const DRY = flags.has("--dry");

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function readBehaviorNotes(dir: string): string[] {
  const f = path.join(dir, BEHAVIOR_FILE);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Accumulated history of the artifact's changes, newest to oldest. */
function appendChanges(dir: string, version: string, result: DiffResult): void {
  const f = path.join(dir, CHANGES_FILE);
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(f, "utf8"))?.history ?? []; } catch { /* first record */ }
  history.unshift({
    version,
    from_version: result.from_version,
    bump: result.bump,
    breaking: result.breaking,
    changes: result.changes,
  });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, history }, null, 2) + "\n", "utf8");
}

function prependChangelog(dir: string, entry: string): void {
  if (!entry) return;
  const f = path.join(dir, CHANGELOG_FILE);
  const header = "# Changelog\n\n> Gerado por `nirvana-changes gen`. Não edite à mão: é saída, não fonte.\n\n";
  const existing = fs.existsSync(f)
    ? fs.readFileSync(f, "utf8").replace(/^# Changelog\n\n> [^\n]*\n\n/, "")
    : "";
  fs.writeFileSync(f, header + entry + "\n" + existing, "utf8");
}

interface GenOutcome { slug: string; kind: string; bump: string; version: string; breaking: number; changed: boolean; baseline: boolean }

function genOne(dir: string): GenOutcome | null {
  const kind = detectKind(dir);
  if (!kind) return null;

  const before = readSurface(dir);
  const next = extractSurface(dir, kind);
  let result = diffSurfaces(before, next);
  result = mergeBehaviorNotes(result, readBehaviorNotes(dir));

  const slug = path.basename(dir);
  const changed = result.changes.length > 0;
  const baseline = before === null;
  // Different schema = the extractor changed what it measures. The diff is
  // suppressed on purpose (it would otherwise flood buyers with phantom changes),
  // but the surface MUST be rewritten with the new schema. Without this the
  // suppression stops being a transition and becomes permanent: the file on disk
  // stays on the old schema forever and every future real change is silently swallowed.
  const rebaseline = before !== null && before.schema !== next.schema;

  // No change and no rebaseline: touch nothing. This is what guarantees idempotency.
  if (!changed && before && !rebaseline) {
    return { slug, kind, bump: "none", version: before.contract_version, breaking: 0, changed: false, baseline: false };
  }

  const finalSurface: Surface = { ...next, contract_version: result.next_version };

  if (!DRY) {
    writeSurface(dir, finalSurface);
    if (changed) {
      appendChanges(dir, result.next_version, result);
      prependChangelog(dir, renderChangelogEntry(slug, result));
      const bf = path.join(dir, BEHAVIOR_FILE);
      // The behavior note has already been absorbed into the history: keeping it
      // would make it reappear in every following release.
      if (fs.existsSync(bf)) fs.rmSync(bf);
    }
  }

  return { slug, kind, bump: result.bump, version: result.next_version, breaking: result.breaking, changed, baseline: baseline || rebaseline };
}

function collectAll(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, "squads"),
    path.join(home, "businesses"),
    path.join(home, "businesses", "_library", "dna"),
  ];
  const dirs: string[] = [];
  for (const root of roots) {
    let items: string[] = [];
    try { items = fs.readdirSync(root); } catch { continue; }
    for (const it of items) {
      if (it.startsWith("_") || it.startsWith(".")) continue;
      const d = path.join(root, it);
      try { if (fs.statSync(d).isDirectory() && detectKind(d)) dirs.push(d); } catch { /* ignore */ }
    }
  }
  return dirs;
}

// ───────────────────────────── commands ─────────────────────────────

if (cmd === "gen") {
  const dirs = flags.has("--all") ? collectAll() : args.map((a) => path.resolve(a));
  if (!dirs.length) fail("nada para processar (informe diretórios ou use --all)");

  const outcomes: GenOutcome[] = [];
  for (const d of dirs) {
    const r = genOne(d);
    if (r) outcomes.push(r);
  }

  const touched = outcomes.filter((o) => o.changed);
  const baselines = outcomes.filter((o) => o.baseline);
  const breaking = touched.filter((o) => o.breaking > 0);

  // A baseline is not a change: the artifact had no surface yet, so there is
  // nothing to migrate. Counting it in would make the first run look like a disaster.
  console.log(
    `${DRY ? "[dry] " : ""}${outcomes.length} artefatos analisados · ` +
    `${baselines.length} linha de base · ${touched.length} com mudança · ${breaking.length} com quebra`,
  );
  for (const o of touched) {
    const mark = o.breaking > 0 ? "QUEBRA" : o.bump;
    console.log(`  ${mark.padEnd(8)} ${o.kind}/${o.slug} → ${o.version}${o.breaking ? ` (${o.breaking} quebra${o.breaking > 1 ? "s" : ""})` : ""}`);
  }
  process.exit(0);
}

if (cmd === "diff") {
  if (args.length !== 2) fail("uso: diff <dir-instalado> <dir-novo>");
  const [a, b] = args.map((x) => path.resolve(x));
  const before = readSurface(a);
  const after = readSurface(b) ?? extractSurface(b);
  const result = diffSurfaces(before, after);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.breaking > 0 ? 1 : 0);
}

if (cmd === "show") {
  if (!args[0]) fail("uso: show <dir>");
  const dir = path.resolve(args[0]);
  const s = readSurface(dir) ?? extractSurface(dir);
  console.log(serializeSurface(s));
  process.exit(0);
}

// ─────────────── pending / ack: what the PROJECT has not seen yet ───────────
//
// A changelog the agent has to open is a changelog the agent does not read. These
// two commands exist so the change arrives through the channel it ALREADY reads —
// the dispatch brief — and so each project is warned exactly once.

const SEEN_FILE = "nirvana-seen.json";

function seenPath(projectDir: string): string {
  return path.join(projectDir, SEEN_FILE);
}

function readSeen(projectDir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(seenPath(projectDir), "utf8")) ?? {}; } catch { return {}; }
}

/** Installed directory of a `squads/<slug>` or `businesses/<slug>`. */
function resolveEntity(entity: string): { dir: string; label: string } | null {
  // A direct path wins: it covers off-standard installs and allows testing
  // without depending on what is in the user's library.
  const asPath = path.resolve(entity);
  if (fs.existsSync(asPath) && detectKind(asPath)) {
    return { dir: asPath, label: `${detectKind(asPath)}/${path.basename(asPath)}` };
  }
  const home = os.homedir();
  const [kind, slug] = entity.includes("/") ? entity.split("/", 2) : ["", entity];
  const roots: Record<string, string> = {
    squads: path.join(home, "squads"),
    businesses: path.join(home, "businesses"),
    "mind-clones": path.join(home, "businesses", "_library", "dna"),
  };
  const tryDirs = kind && roots[kind]
    ? [[kind, path.join(roots[kind], slug)] as const]
    : Object.entries(roots).map(([k, r]) => [k, path.join(r, slug)] as const);
  for (const [k, d] of tryDirs) if (fs.existsSync(d) && detectKind(d)) return { dir: d, label: `${k}/${slug}` };
  return null;
}

if (cmd === "pending" || cmd === "ack") {
  const projectDir = path.resolve(
    argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : process.cwd(),
  );
  const entity = args[0];
  if (!entity) fail(`uso: ${cmd} <squads/slug|businesses/slug> [--project <dir>]`);

  const resolved = resolveEntity(entity);
  if (!resolved) fail(`entidade não encontrada instalada: ${entity}`);

  const surface = readSurface(resolved.dir);
  if (!surface) {
    // An artifact without a surface is not an error: it is a pack predating this feature.
    console.log(JSON.stringify({ entity: resolved.label, pending: false, reason: "no surface" }));
    process.exit(0);
  }

  const seen = readSeen(projectDir);
  const lastSeen = seen[resolved.label] ?? null;

  if (cmd === "ack") {
    seen[resolved.label] = surface.contract_version;
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(seenPath(projectDir), JSON.stringify(seen, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ entity: resolved.label, acked: surface.contract_version }));
    process.exit(0);
  }

  // First use of the project with this entity: nothing changed "for it".
  if (!lastSeen || lastSeen === surface.contract_version) {
    console.log(JSON.stringify({ entity: resolved.label, version: surface.contract_version, pending: false }));
    process.exit(0);
  }

  // Collects the history entries newer than the version the project knows.
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(path.join(resolved.dir, CHANGES_FILE), "utf8"))?.history ?? []; } catch { /* no history */ }
  const relevant: any[] = [];
  for (const h of history) {
    if (h.version === lastSeen) break;
    relevant.push(...(h.changes ?? []));
  }
  const breaking = relevant.filter((c) => c.severity === "breaking");

  console.log(JSON.stringify({
    entity: resolved.label,
    from_version: lastSeen,
    version: surface.contract_version,
    pending: true,
    breaking: breaking.length,
    changes: relevant,
    // Block ready to enter the brief: the orchestrator pastes it, never rephrases.
    brief_block: breaking.length
      ? [
          `ATENÇÃO — ${resolved.label} mudou de ${lastSeen} para ${surface.contract_version} desde a última execução deste projeto.`,
          `${breaking.length} mudança(s) QUEBRAM contrato:`,
          ...breaking.map((c: any) => `- ${c.detail}${c.migration ? ` (${c.migration})` : ""}`),
          "Verifique se o trabalho existente deste projeto depende de algum item acima antes de prosseguir.",
        ].join("\n")
      : null,
  }, null, 2));
  process.exit(breaking.length ? 1 : 0);
}

console.log(`nirvana-changes — contract surface of the artifacts

  gen <dir...> [--dry]      regenerate the surface, derive the bump, write ${CHANGES_FILE} + ${CHANGELOG_FILE}
  gen --all [--dry]         scan ~/squads, ~/businesses and the clone library
  diff <installed> <new>    compare two directories of the same artifact (JSON; exits 1 on a break)
  show <dir>                print the current surface
  pending <ent> [--project <dir>]  changes THIS project has not seen yet (exits 1 on a break)
  ack <ent> [--project <dir>]      mark the current version as seen by this project

Files in the artifact:
  ${SURFACE_FILE}   surface (generated, deterministic)
  ${CHANGES_FILE}            typed history of the changes (generated)
  ${CHANGELOG_FILE}          human reading (generated — do not edit)
  ${BEHAVIOR_FILE}  MANUAL note of a behavior change; consumed and deleted on gen`);
process.exit(cmd ? 2 : 0);
