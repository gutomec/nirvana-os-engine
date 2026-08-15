#!/usr/bin/env bun
/**
 * check-capability-clones.ts — when two squads say the same thing, the router
 * has no way to choose between them.
 *
 * A capability id may legitimately have several providers: nine squads can all
 * define a design language, and the router is meant to pick the one whose angle
 * fits the brief. It picks by BM25 over each provider's own description,
 * keywords and example_briefs. So the moment two providers carry byte-identical
 * text, that mechanism has nothing to work with — both score the same, the
 * decision falls to tie-breaking noise, and a confident-looking HIGH is a coin
 * toss.
 *
 * This is not hypothetical. Two bulk injections shipped the same capability into
 * many squads at once with the text copied verbatim: `media.video.compose` into
 * ten squads and three `frontend.*` capabilities into seven to nine each. Nine
 * of the ten video copies carried NO keywords and NO example_briefs at all —
 * the two fields the index weights ×3 and ×2 — so the injected capability
 * competed on description alone, identically, everywhere.
 *
 * Measured after differentiating the video ten: held-out briefs that a person
 * might actually type went from routing to nothing or to the wrong squad, to
 * six of seven landing on the right one with HIGH confidence. The seventh
 * returns AMBIGUOUS, which is the router declining to guess — a correct answer,
 * not a miss.
 *
 * What this gate reports is the identical text, not the shared id. Sharing an id
 * is the design. Sharing the words is the defect.
 *
 * Usage:
 *   bun scripts/check-capability-clones.ts              # report
 *   bun scripts/check-capability-clones.ts --strict     # exit 1 if any clone
 *   bun scripts/check-capability-clones.ts --json
 *   bun scripts/check-capability-clones.ts <capability-id>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const registryLoader = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "registry-loader.js"));

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const asJson = argv.includes("--json");
/** A capabilities map to read instead of the live registry. Without it the only
 *  testable path is "this machine happens to be clean", which proves nothing
 *  about the case the gate exists to catch. */
const fixture = argv.includes("--registry") ? argv[argv.indexOf("--registry") + 1] : null;
const only = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--registry");

const md5 = (v: unknown) => createHash("md5").update(JSON.stringify(v ?? null)).digest("hex");

/** The fields the index actually scores a provider on. Two providers that agree
 *  on all three are indistinguishable to BM25, whatever else differs. */
const signature = (c: Record<string, unknown>) => md5([c.description, c.keywords, c.example_briefs]);

interface Group { id: string; providers: number; camps: string[][]; cloned: number; }

const caps: Record<string, Array<Record<string, unknown>>> = fixture
  ? JSON.parse(readFileSync(fixture, "utf8"))
  : (registryLoader.loadAll()?.squads?.capabilities ?? {});
const groups: Group[] = [];

for (const [id, list] of Object.entries(caps)) {
  if (only && id !== only) continue;
  const provs = list.filter((c) => c.squad);
  if (provs.length < 2) continue;
  const bySig = new Map<string, string[]>();
  for (const c of provs) {
    const s = signature(c);
    bySig.set(s, [...(bySig.get(s) ?? []), String(c.squad)]);
  }
  const camps = [...bySig.values()];
  const cloned = camps.filter((g) => g.length > 1).reduce((n, g) => n + g.length, 0);
  groups.push({ id, providers: provs.length, camps, cloned });
}

const shared = groups.length;
const instances = groups.reduce((n, g) => n + g.providers, 0);
const clones = groups.reduce((n, g) => n + g.cloned, 0);
const affected = groups.filter((g) => g.cloned > 0);

if (asJson) {
  console.log(JSON.stringify({
    shared_ids: shared,
    provider_instances: instances,
    cloned_instances: clones,
    affected: affected.map((g) => ({ id: g.id, providers: g.providers, cloned: g.cloned, camps: g.camps.filter((c) => c.length > 1) })),
  }, null, 2));
  process.exitCode = strict && clones ? 1 : 0;
} else {
  console.log(`\n${BOLD}CAPABILITY CLONES — can the router tell these apart?${RST}`);
  console.log(`${DIM}  ${shared} capability ids have more than one provider (${instances} instances)${RST}`);
  console.log(`${DIM}  compared on the fields BM25 scores: description, keywords, example_briefs${RST}\n`);

  if (clones === 0) {
    console.log(`${GRN}  Every provider of a shared capability describes itself differently.${RST}\n`);
    process.exitCode = 0;
  } else {
    const pct = Math.round((100 * clones) / Math.max(instances, 1));
    console.log(`  indistinguishable: ${clones > 0 ? RED : GRN}${clones}/${instances} (${pct}%)${RST}\n`);

    for (const g of affected.sort((a, b) => b.cloned - a.cloned)) {
      console.log(`  ${RED}▼${RST} ${BOLD}${g.id}${RST} ${DIM}— ${g.cloned} of ${g.providers} providers${RST}`);
      for (const camp of g.camps.filter((c) => c.length > 1)) {
        console.log(`      ${YEL}identical${RST}  ${camp.join(", ")}`);
      }
      for (const camp of g.camps.filter((c) => c.length === 1)) {
        console.log(`      ${DIM}distinct   ${camp[0]}${RST}`);
      }
    }

    console.log(`\n${DIM}  Sharing an id is the design — several squads can do the same kind of work.`);
    console.log(`  Sharing the words is the defect: give each provider the keywords and`);
    console.log(`  example_briefs of ITS angle. Removing the capability is not the fix.${RST}\n`);
    process.exitCode = strict ? 1 : 0;
  }
}
