#!/usr/bin/env bun
// search.ts — keyword + BM25 search across your Nirvana assets.
//
// Ranks the name/description/keywords fields in the registry JSON files (BM25-style).
//
// Usage:
//   nrv search "<query>"                      # all kinds
//   nrv search "<query>" --kind=business
//   nrv search "<query>" --kind=squad
//   nrv search "<query>" --kind=mind-clone
//   nrv search "<query>" --json
//   nrv search "<query>" --limit=10

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", lime: "\x1b[38;5;154m",
  magenta: "\x1b[35m", yellow: "\x1b[33m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const args = process.argv.slice(2);
const query = args.filter(a => !a.startsWith("--")).join(" ");
const kindArg = args.find(a => a.startsWith("--kind="))?.split("=")[1];
const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "15");
const jsonOut = args.includes("--json");

if (!query) {
  console.error("Uso: nrv search \"<query>\" [--kind=business|squad|mind-clone] [--limit=N]");
  console.error("");
  console.error("Exemplos:");
  console.error("  nrv search \"copy direct response\"");
  console.error("  nrv search \"image generation\" --kind=squad");
  console.error("  nrv search \"brand strategy\" --kind=mind-clone --limit=5");
  process.exit(2);
}

type Hit = {
  kind: "business" | "squad" | "mind-clone";
  slug: string;
  name: string;
  description: string;
  category?: string;
  score: number;
  matched_fields: string[];
};

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9çãáéíóúâêôüà]+/).filter(t => t.length > 1);
}

function scoreMatch(queryTokens: string[], targetText: string, fieldWeight: number): { score: number; matched: boolean } {
  if (!targetText) return { score: 0, matched: false };
  const lowered = targetText.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (lowered.includes(t)) hits++;
  }
  if (hits === 0) return { score: 0, matched: false };
  const score = (hits / queryTokens.length) * fieldWeight;
  return { score, matched: true };
}

const qTokens = tokenize(query);
const hits: Hit[] = [];

// SQUADS
if (!kindArg || kindArg === "squad") {
  const squadReg = path.join(os.homedir(), ".squads-registry.json");
  if (fs.existsSync(squadReg)) {
    try {
      const data = JSON.parse(fs.readFileSync(squadReg, "utf8"));
      const list = Array.isArray(data) ? data : (data.squads || Object.values(data));
      for (const sq of list) {
        const fields = [
          { text: sq.name || "", w: 2.0, name: "name" },
          { text: sq.description || "", w: 1.0, name: "description" },
          { text: (sq.tags || []).join(" "), w: 1.5, name: "tags" },
          { text: (sq.capabilities || []).map((c: any) => `${c.id || ""} ${c.description || ""}`).join(" "), w: 1.2, name: "capabilities" },
        ];
        let total = 0;
        const matched: string[] = [];
        for (const f of fields) {
          const r = scoreMatch(qTokens, f.text, f.w);
          total += r.score;
          if (r.matched) matched.push(f.name);
        }
        if (total > 0) {
          hits.push({
            kind: "squad",
            slug: sq.name || sq.slug || "(unknown)",
            name: sq.name || "(unknown)",
            description: (sq.description || "").slice(0, 120),
            score: total,
            matched_fields: matched,
          });
        }
      }
    } catch {}
  }
}

// BUSINESSES
if (!kindArg || kindArg === "business") {
  const bizReg = path.join(os.homedir(), ".businesses-registry.json");
  if (fs.existsSync(bizReg)) {
    try {
      const data = JSON.parse(fs.readFileSync(bizReg, "utf8"));
      const list = Array.isArray(data) ? data : (data.businesses || Object.values(data));
      for (const bz of list) {
        const fields = [
          { text: bz.name || "", w: 2.0, name: "name" },
          { text: bz.description || "", w: 1.0, name: "description" },
          { text: (bz.domains || []).join(" "), w: 1.5, name: "domains" },
          { text: (bz.keywords || []).join(" "), w: 1.5, name: "keywords" },
          { text: (bz.produces || []).join(" "), w: 1.2, name: "produces" },
          { text: (bz.example_briefs || []).join(" "), w: 1.3, name: "examples" },
        ];
        let total = 0;
        const matched: string[] = [];
        for (const f of fields) {
          const r = scoreMatch(qTokens, f.text, f.w);
          total += r.score;
          if (r.matched) matched.push(f.name);
        }
        if (total > 0) {
          hits.push({
            kind: "business",
            slug: bz.name || bz.slug || "(unknown)",
            name: bz.name || "(unknown)",
            description: (bz.description || "").slice(0, 120),
            score: total,
            matched_fields: matched,
          });
        }
      }
    } catch {}
  }
}

// MIND-CLONES — scan ~/businesses/_library/dna/<cat>/<slug>/MANIFEST.yaml
if (!kindArg || kindArg === "mind-clone") {
  const dnaRoot = path.join(os.homedir(), "businesses/_library/dna");
  if (fs.existsSync(dnaRoot)) {
    for (const cat of fs.readdirSync(dnaRoot)) {
      const catPath = path.join(dnaRoot, cat);
      if (!fs.statSync(catPath).isDirectory()) continue;
      for (const slug of fs.readdirSync(catPath)) {
        const clonePath = path.join(catPath, slug);
        if (!fs.statSync(clonePath).isDirectory()) continue;
        const manifestPath = path.join(clonePath, "MANIFEST.yaml");
        if (!fs.existsSync(manifestPath)) continue;
        const m = fs.readFileSync(manifestPath, "utf8");
        const displayName = m.match(/display_name:\s*["']?([^"'\n]+)/)?.[1]?.trim() || slug;
        const tags = m.match(/tags:\s*\[([^\]]+)\]/)?.[1] || "";
        const description = m.match(/description:\s*["']?([^"'\n]+)/)?.[1]?.trim() || "";

        const fields = [
          { text: slug, w: 2.0, name: "slug" },
          { text: displayName, w: 1.8, name: "name" },
          { text: cat, w: 1.5, name: "category" },
          { text: tags, w: 1.3, name: "tags" },
          { text: description, w: 1.0, name: "description" },
        ];
        let total = 0;
        const matched: string[] = [];
        for (const f of fields) {
          const r = scoreMatch(qTokens, f.text, f.w);
          total += r.score;
          if (r.matched) matched.push(f.name);
        }
        if (total > 0) {
          hits.push({
            kind: "mind-clone",
            slug,
            name: displayName,
            description: description.slice(0, 120),
            category: cat,
            score: total,
            matched_fields: matched,
          });
        }
      }
    }
  }
}

hits.sort((a, b) => b.score - a.score);
const top = hits.slice(0, limit);

if (jsonOut) {
  console.log(JSON.stringify({ query, results: top, total: hits.length }, null, 2));
  process.exit(0);
}

console.log("");
console.log(c("bold", `Search: "${query}"`) + c("dim", `  ·  ${hits.length} matches, showing top ${top.length}`));
console.log("");
for (const h of top) {
  const kindColor: keyof typeof ANSI = h.kind === "squad" ? "lime" : h.kind === "business" ? "magenta" : "cyan";
  const scoreBar = "█".repeat(Math.min(15, Math.round(h.score * 5)));
  console.log(`  ${c(kindColor, h.kind.padEnd(11))} ${c("bold", h.slug.padEnd(40))} ${c("yellow", h.score.toFixed(2))} ${c("dim", scoreBar)}`);
  if (h.category) console.log(`    ${c("dim", "category:")} ${h.category}`);
  console.log(`    ${c("dim", h.description)}`);
  console.log(`    ${c("dim", "matched: " + h.matched_fields.join(", "))}`);
  console.log("");
}

if (hits.length === 0) {
  console.log(c("yellow", "  Nenhum match. Tente termos mais genéricos ou verifique:"));
  console.log("    " + c("yellow", "nrv index") + c("dim", "  # rebuild registries"));
  console.log("    " + c("yellow", "nrv doctor") + c("dim", "  # check library counts"));
}

process.exit(0);
