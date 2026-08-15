#!/usr/bin/env bun
/**
 * coverage-ratchet.ts — an entity may not quietly know less than it did.
 *
 * Every gate we have asks whether an entity can still be found. None of them
 * asks whether it still covers what it used to. Delete five capabilities and
 * their briefs and every gate stays green: the survivors self-retrieve fine,
 * the neighbours are untouched, the YAML validates. The library got smaller and
 * nothing said so.
 *
 * That is the exact shape of the damage the routing contract already carries a
 * correction for — descriptions truncated mid-word at 500 characters, across the
 * whole library, to save space. Losing coverage is invisible in a way that
 * losing correctness is not, which is why it needs its own gate.
 *
 * So: record what each entity covers, and refuse a silent decrease. Removal
 * stays possible — it just has to be said out loud.
 *
 *   bun coverage-ratchet.ts --check                  # every entity, warn on drops
 *   bun coverage-ratchet.ts --check --strict         # exit 1 on any undeclared drop
 *   bun coverage-ratchet.ts --check <slug>           # one entity
 *   bun coverage-ratchet.ts --accept <slug> --reason "merged into X"
 *   bun coverage-ratchet.ts --record                 # re-baseline everything
 *
 * The baseline lives beside the registries so it travels with the scope it
 * describes, and it is meant to be committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths as nrvPaths, parseArgs } from "../lib/bun-helpers.ts";

// parseArgs takes no options here and returns `positional`, not `positionals`.
const { flags, positional } = parseArgs(process.argv.slice(2));

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const BASELINE = join(
  dirname((nrvPaths as Record<string, string>).SQUADS_REGISTRY_PATH ?? "."),
  ".coverage-baseline.json",
);

interface Coverage {
  capabilities: number;
  example_briefs: number;
  keywords: number;
  /** Capability ids, so a swap of equal count is still visible. */
  ids: string[];
}
interface Baseline {
  recorded_at: string;
  entities: Record<string, Coverage>;
  /** Accepted decreases: slug → why. Cleared for an entity when it grows again. */
  accepted: Record<string, { reason: string; at: string; from: Coverage }>;
}

function loadBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    return { recorded_at: "", entities: {}, accepted: {} };
  }
}

/** What every entity in the live registries covers right now. */
function measure(): Record<string, Coverage> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registries = require("../../harness/lib/registry-loader.js").loadAll();
  const out: Record<string, Coverage> = {};
  const bump = (slug: string, cap: Record<string, unknown>, id: string) => {
    const c = (out[slug] ??= { capabilities: 0, example_briefs: 0, keywords: 0, ids: [] });
    c.capabilities++;
    c.ids.push(id);
    c.example_briefs += ((cap.example_briefs as unknown[]) ?? []).length;
    c.keywords += ((cap.keywords as unknown[]) ?? []).length;
  };
  for (const [id, list] of Object.entries(registries?.squads?.capabilities ?? {})) {
    for (const cap of (Array.isArray(list) ? list : []) as Array<Record<string, unknown>>) {
      const slug = (cap.squad ?? cap.business) as string | undefined;
      if (slug) bump(slug, cap, id);
    }
  }
  for (const [slug, b] of Object.entries(registries?.businesses?.businesses ?? {})) {
    const biz = b as Record<string, unknown>;
    const c = (out[slug] ??= { capabilities: 0, example_briefs: 0, keywords: 0, ids: [] });
    c.example_briefs += ((biz.example_briefs as unknown[]) ?? []).length;
    c.keywords += ((biz.keywords as unknown[]) ?? []).length;
  }
  for (const c of Object.values(out)) c.ids.sort();
  return out;
}

interface Drop { slug: string; field: string; from: number; to: number; lostIds?: string[]; }

function compare(base: Baseline, now: Record<string, Coverage>, only?: string): Drop[] {
  const drops: Drop[] = [];
  for (const [slug, before] of Object.entries(base.entities)) {
    if (only && slug !== only) continue;
    const after = now[slug];
    if (!after) {
      drops.push({ slug, field: "entity", from: 1, to: 0 });
      continue;
    }
    for (const f of ["capabilities", "example_briefs", "keywords"] as const) {
      if (after[f] < before[f]) drops.push({ slug, field: f, from: before[f], to: after[f] });
    }
    // A swap keeps the count and still loses coverage, so compare the ids too.
    const lost = before.ids.filter((id) => !after.ids.includes(id));
    if (lost.length) drops.push({ slug, field: "capability ids", from: before.ids.length, to: after.ids.length, lostIds: lost });
  }
  return drops;
}

const baseline = loadBaseline();
const now = measure();

if (flags.record) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ recorded_at: new Date().toISOString(), entities: now, accepted: baseline.accepted ?? {} }, null, 2) + "\n");
  console.log(`${GRN}Baseline recorded${RST} — ${Object.keys(now).length} entities → ${BASELINE.replace(process.env.HOME ?? "~", "~")}`);
  process.exit(0);
}

if (typeof flags.accept === "string") {
  const slug = flags.accept;
  const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
  if (!reason) {
    console.error(`${RED}--accept needs --reason "why this entity covers less now"${RST}`);
    console.error(`${DIM}A decrease without a stated reason is exactly what this gate exists to catch.${RST}`);
    process.exit(2);
  }
  baseline.accepted ??= {};
  baseline.accepted[slug] = { reason, at: new Date().toISOString(), from: baseline.entities[slug] };
  baseline.entities[slug] = now[slug] ?? { capabilities: 0, example_briefs: 0, keywords: 0, ids: [] };
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`${GRN}Accepted${RST} ${slug}: ${reason}`);
  process.exit(0);
}

// default: --check
if (!baseline.recorded_at) {
  console.log(`${YEL}No baseline yet.${RST} Run: bun coverage-ratchet.ts --record`);
  process.exit(0);
}

const only = positional[0];
const drops = compare(baseline, now, only).filter((d) => !baseline.accepted?.[d.slug]);

if (flags.json) {
  console.log(JSON.stringify({ baseline_at: baseline.recorded_at, drops }, null, 2));
  process.exit(drops.length && flags.strict ? 1 : 0);
}

console.log(`\n${BOLD}COVERAGE RATCHET${RST}`);
console.log(`${DIM}  baseline ${baseline.recorded_at.slice(0, 19)} · ${Object.keys(baseline.entities).length} entities${RST}\n`);

if (drops.length === 0) {
  console.log(`${GRN}  No entity knows less than it did.${RST}\n`);
  process.exit(0);
}

for (const d of drops) {
  console.log(`  ${RED}▼${RST} ${d.slug.padEnd(32)} ${d.field}: ${d.from} → ${d.to}`);
  if (d.lostIds?.length) for (const id of d.lostIds.slice(0, 5)) console.log(`      ${DIM}lost ${id}${RST}`);
}
console.log(`\n${DIM}  Removal is allowed; silent removal is not. If the decrease is intended:${RST}`);
console.log(`${DIM}    bun coverage-ratchet.ts --accept <slug> --reason "..."${RST}`);
console.log(`${DIM}  If it is not, restore it. Cutting content to reduce tokens is prohibited —${RST}`);
console.log(`${DIM}  see ROUTING_METADATA_CONTRACT §8bis.${RST}\n`);
process.exit(flags.strict ? 1 : 0);
