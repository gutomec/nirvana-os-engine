#!/usr/bin/env bun
/**
 * audit-mindclones-score.ts — score every mind-clone DNA file in
 * $BUSINESSES_LIBRARY/dna on a 5-criteria Nirvana rubric (100 pts total).
 *
 * Criteria:
 *   1. Frontmatter completeness (name + description≥50 + model + maxTurns + tools) — 25
 *   2. Body length ≥1000 chars — 20
 *   3. Section structure ≥3 H2/H3 — 20
 *   4. Specificity markers (frameworks/heuristics/models/examples) — 20
 *   5. Persona voice (1st person OR "mind-clone of") — 15
 *
 * Tier: red <60, yellow 60-79, green ≥80.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const YAML = require(path.join(paths.CLAUDE_SKILLS_DIR, "squads", "node_modules", "yaml"));

const { flags } = parseArgs();
const QUIET = !!flags.quiet || !!flags.q;
const JSON_OUT = !!flags.json;
const TOP_FAIL = !!flags["show-failures"];

const scope = resolveScope();
// Project root wins for persistence (covers BOTH project and merge mode):
// branch on scope.projectRoot, NOT mode === "project". Filename is
// `mindclones-scores.json` — distinct from squads' `scores.json` and the
// businesses scorer's `businesses-scores.json`, so the three coexist in the
// shared project .audit-state/ dir without collision.
const STATE_DIR = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana", ".audit-state")
  : path.join(paths.CLAUDE_SKILLS_DIR, "businesses", ".audit-state");
fs.mkdirSync(STATE_DIR, { recursive: true });

// Recursive walk that follows symlinks (DNA categories are symlinked).
function walkMd(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const fp = path.join(root, e.name);
    let st: fs.Stats;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.isDirectory()) walkMd(fp, out);
    else if (st.isFile() && fp.endsWith(".md")) out.push(fp);
  }
  return out;
}

function scoreClone(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const breakdown: any[] = [];
  let total = 0;

  // Criterion 1 — Frontmatter completeness (25 pts)
  const fmMatch = raw.match(/^---\n([\s\S]+?)\n---/);
  let c1 = 0;
  let evi1 = "no frontmatter";
  if (fmMatch) {
    let fm: any = null;
    try { fm = YAML.parse(fmMatch[1]); } catch {}
    if (fm) {
      const checks = {
        name: typeof fm.name === "string" && fm.name.length > 0,
        description: typeof fm.description === "string" && fm.description.length >= 50,
        model: typeof fm.model === "string" && fm.model.length > 0,
        maxTurns: typeof fm.maxTurns === "number" || /^\d+$/.test(String(fm.maxTurns || "")),
        tools: Array.isArray(fm.tools) && fm.tools.length > 0,
      };
      const pass = Object.values(checks).filter(Boolean).length;
      c1 = Math.round((pass / 5) * 25);
      evi1 = `${pass}/5 fields (` + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ") + ")";
      if (pass === 5) evi1 = "all 5 fields present";
    } else {
      c1 = 5;
      evi1 = "frontmatter unparseable YAML";
    }
  }
  breakdown.push({ id: 1, name: "frontmatter", score: c1, max: 25, evidence: evi1 });
  total += c1;

  // Criterion 2 — Body length (20 pts)
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  const len = body.length;
  let c2 = 0;
  if (len >= 5000) c2 = 20;
  else if (len >= 2000) c2 = 16;
  else if (len >= 1000) c2 = 12;
  else if (len >= 500) c2 = 6;
  breakdown.push({ id: 2, name: "body_length", score: c2, max: 20, evidence: `${len} chars` });
  total += c2;

  // Criterion 3 — Section structure (20 pts)
  const headings = (body.match(/^##+\s+/gm) || []).length;
  let c3 = 0;
  if (headings >= 7) c3 = 20;
  else if (headings >= 5) c3 = 16;
  else if (headings >= 3) c3 = 12;
  else if (headings >= 1) c3 = 6;
  breakdown.push({ id: 3, name: "sections", score: c3, max: 20, evidence: `${headings} headings` });
  total += c3;

  // Criterion 4 — Specificity markers (20 pts)
  const lower = body.toLowerCase();
  const markers = [
    "modelos mentais", "mental models",
    "heurísticas", "heuristics",
    "frameworks", "framework",
    "exemplos", "examples",
    "filosofia", "philosophy",
    "playbook", "rituals", "rituais",
    "worldview", "cosmovisão",
    "identidade", "identity",
    "posicionamento", "positioning",
    "verdades", "convictions", "crenças",
    "decisões", "decisions",
    "arquétipo", "archetype",
  ];
  const hits = markers.filter((m) => lower.includes(m)).length;
  let c4 = 0;
  if (hits >= 5) c4 = 20;
  else if (hits >= 3) c4 = 14;
  else if (hits >= 1) c4 = 8;
  breakdown.push({ id: 4, name: "specificity", score: c4, max: 20, evidence: `${hits} markers` });
  total += c4;

  // Criterion 5 — Persona voice (15 pts)
  // Accept either: explicit "mind-clone de/of" OR header "— Mind-Clone v…"
  // OR persona name used as subject ("Tiago é/decide/escolhe/transita") — 3rd
  // person descriptive of the mind-clone is a valid v5 voice.
  const hasMindCloneTag = /mind-clone\s+(de|of)/i.test(body) || /—\s*Mind-Clone\s+v/i.test(body);
  const firstPersonHits = (body.match(/\b(eu (sou|penso|escolho|decido)|você é|i think|i decide|i am)\b/gi) || []).length;
  // 3rd-person persona voice: capitalized name followed by a doing/being verb in PT or EN
  const thirdPersonHits = (body.match(/\b[A-Z][a-zà-ÿ]+\s+(é|tem|usa|escolhe|decide|opera|transita|defende|aplica|pensa|trabalha|is|has|uses|chooses|decides|operates|defends|applies|thinks|works)\b/g) || []).length;
  let c5 = 0;
  if (hasMindCloneTag && (firstPersonHits >= 2 || thirdPersonHits >= 5)) c5 = 15;
  else if (hasMindCloneTag || firstPersonHits >= 3 || thirdPersonHits >= 8) c5 = 10;
  else if (firstPersonHits >= 1 || thirdPersonHits >= 3) c5 = 5;
  breakdown.push({ id: 5, name: "persona_voice", score: c5, max: 15, evidence: `mindclone-tag=${hasMindCloneTag} · 1st=${firstPersonHits} · 3rd=${thirdPersonHits}` });
  total += c5;

  const tier = total >= 80 ? "green" : total >= 60 ? "yellow" : "red";
  return {
    file,
    slug: path.basename(file, ".md"),
    category: path.basename(path.dirname(file)),
    score: total, max: 100, tier,
    breakdown,
  };
}

const entries = enumerate(scope, "mind-clones").filter((e) => !e.overridden);
if (entries.length === 0) {
  console.error(`[audit-mindclones-score] no mind-clones in scope=${scope.mode}`);
  process.exit(EXIT.FAILURES);
}

const files = entries.flatMap((e) => walkMd(e.dir));
console.error(`[audit-mindclones-score] scope=${scope.mode} · scanning ${files.length} mind-clones...`);

const scores = files.map(scoreClone).sort((a, b) => a.score - b.score);
const byTier = scores.reduce((acc: any, s: any) => { acc[s.tier] = (acc[s.tier] || 0) + 1; return acc; }, {});
const avg = scores.length ? Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length) : 0;

const report = {
  generated_at: new Date().toISOString(),
  total: scores.length,
  by_tier: byTier,
  avg_score: avg,
  scores,
};
fs.writeFileSync(path.join(STATE_DIR, "mindclones-scores.json"), JSON.stringify(report, null, 2));

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(EXIT.OK);
}

if (TOP_FAIL) {
  console.log("── lowest-scoring 20 ──");
  for (const s of scores.slice(0, 20)) {
    console.log(`  ${s.tier.padEnd(6)} ${String(s.score).padStart(3)}  ${s.category}/${s.slug}`);
  }
}

if (!QUIET) console.log("");
console.log("──── totals ────");
console.log(`  red:    ${byTier.red || 0}`);
console.log(`  yellow: ${byTier.yellow || 0}`);
console.log(`  green:  ${byTier.green || 0}`);
console.log(`  total:  ${scores.length}`);
console.log(`  avg:    ${avg}/100`);

process.exit(EXIT.OK);
