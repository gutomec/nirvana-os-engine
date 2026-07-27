#!/usr/bin/env bun
// launch.ts — orchestrate a multi-pillar 360° launch project.
//
// Replicates the nirvana-os-launch pipeline pattern (11 pillars, brief-business
// per pillar, validate per pillar) as a single command.
//
// Usage:
//   nrv launch <project_name>
//   nrv launch <project_name> --pillars=brand,legal,ads,gtm
//   nrv launch <project_name> --config=launch.yaml
//
// What it does (interactive):
//   1. Read or prompt for project_name
//   2. Read or prompt for pillar list (default: all 11)
//   3. For each pillar: prompt for business slug + brief + outputs dir
//   4. Run brief-business + build prompt per pillar
//   5. Emit the dispatch_business chain
//   6. Print the next step (paste prompts into runtime)
//
// This is NOT a fully autonomous orchestrator (that would need real subagent
// spawning from CLI). It's the setup + scaffolding so the user can paste
// pillar by pillar into Claude Code / Codex.
//
// For full autonomy, use within a Claude Code session via Skill("harness", ...).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  lime: "\x1b[38;5;154m", red: "\x1b[31m", magenta: "\x1b[35m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const projectName = process.argv[2];
if (!projectName || projectName.startsWith("--")) {
  console.error("Uso: nrv launch <project_name> [--pillars=a,b,c] [--config=launch.yaml]");
  console.error("");
  console.error("  Sem --pillars/--config: lista os defaults e pergunta antes de dispatchar.");
  console.error("");
  console.error("Exemplos:");
  console.error("  nrv launch my-product");
  console.error("  nrv launch my-product --pillars=brand,marketing,gtm");
  console.error("  nrv launch my-product --config=./launch.yaml");
  process.exit(2);
}

const arg = (name: string) => {
  const i = process.argv.findIndex(a => a.startsWith(name));
  if (i === -1) return null;
  const a = process.argv[i];
  return a.includes("=") ? a.split("=").slice(1).join("=") : process.argv[i + 1];
};

const pillarsArg = arg("--pillars");
const configFile = arg("--config");
const outputsRoot = arg("--outputs-root") || path.join(os.homedir(), projectName);

// Default pillar → business mapping (taken from the actual nirvana-os-launch)
const DEFAULT_PILLARS: { pillar: string; business: string; suggested_artifacts: string[] }[] = [
  { pillar: "01-brand", business: "brand-creative-studio", suggested_artifacts: ["manifesto.md", "voice-and-tone.md", "color-system.md", "typography.md", "logo-system.md", "design-tokens.json"] },
  { pillar: "02-legal", business: "juridical-singularity", suggested_artifacts: ["LICENSE.md", "ToS.md", "Privacy.md", "CLA.md"] },
  { pillar: "03-marketing", business: "niche-radar-studio-nirvana", suggested_artifacts: ["competitive-radar.md", "positioning.md", "icp-personas.md", "30-launch-posts.md"] },
  { pillar: "04-ads", business: "ads-intelligence", suggested_artifacts: ["ads-strategy.md", "meta-campaigns.md", "google-ads.md", "tiktok.md"] },
  { pillar: "05-gtm", business: "launch-lab-br", suggested_artifacts: ["master-gtm.md", "launch-week.md", "grand-slam-offer.md"] },
  { pillar: "06-product-bundle", business: "brand-creative-studio", suggested_artifacts: ["index-bundle.md"] },
  { pillar: "07-press", business: "niche-radar-studio-nirvana", suggested_artifacts: ["press-release-pt.md", "press-release-en.md", "media-kit.md"] },
  { pillar: "08-content", business: "content-social-factory", suggested_artifacts: ["blog-posts/", "essays/", "video-scripts/"] },
  { pillar: "09-pricing", business: "launch-lab-br", suggested_artifacts: ["pricing-strategy.md", "offer-architecture.md", "stripe-skus.md"] },
  { pillar: "10-site", business: "brand-creative-studio", suggested_artifacts: ["landing-copy.md", "docs-ia.md", "README-v2.md"] },
];

// Optionally load custom config
let pillars = DEFAULT_PILLARS;
if (configFile) {
  if (!fs.existsSync(configFile)) {
    console.error(c("red", `Config file não existe: ${configFile}`));
    process.exit(1);
  }
  // Naive YAML parse via JSON for now
  console.error(c("yellow", "WARN: --config YAML parser ainda não implementado; usando defaults"));
}

if (pillarsArg) {
  const selected = pillarsArg.split(",").map(s => s.trim());
  pillars = pillars.filter(p => selected.includes(p.pillar.replace(/^\d+-/, "")) || selected.includes(p.pillar));
  if (pillars.length === 0) {
    console.error(c("red", `Nenhum pillar match: ${pillarsArg}`));
    console.error("Pillars disponíveis: " + DEFAULT_PILLARS.map(p => p.pillar).join(", "));
    process.exit(1);
  }
}

// Create the outputs root
fs.mkdirSync(outputsRoot, { recursive: true });
fs.mkdirSync(path.join(outputsRoot, ".nirvana"), { recursive: true });
console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv launch — ${projectName}`));
console.log(c("dim", `  outputs: ${outputsRoot}`));
console.log(c("dim", `  pillars: ${pillars.length} (${pillars.map(p => p.pillar).join(", ")})`));
console.log("");

// Generate per-pillar brief-business invocations
const briefBiz = path.join(SKILLS_ROOT, "businesses/scripts/brief-business.ts");
const runPlan: { pillar: string; cmd: string }[] = [];

for (const p of pillars) {
  const pillarDir = path.join(outputsRoot, p.pillar);
  fs.mkdirSync(pillarDir, { recursive: true });
  const projectId = `${projectName}-${p.pillar}`;
  const briefText = `Pillar ${p.pillar} do lançamento ${projectName}. Output dir: ${pillarDir}/. Suggested artifacts: ${p.suggested_artifacts.join(", ")}. (Customize before dispatching for real production.)`;

  // Auto-generate deliverables.json
  const deliverables = p.suggested_artifacts.map(a => path.join(pillarDir, a));
  const briefFile = path.join(pillarDir, "brief.md");
  const manifestFile = path.join(pillarDir, "deliverables.json");
  fs.writeFileSync(briefFile, briefText);
  fs.writeFileSync(manifestFile, JSON.stringify({ deliverables, source: "nrv-launch-scaffold" }, null, 2));

  // Run brief-business
  console.log(c("cyan", `  → ${p.pillar} via ${p.business}`));
  const r = spawnSync("bun", [briefBiz, p.business, briefText, "--project", projectId, "--manifest", manifestFile], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(c("red", `    ✗ brief-business failed for ${p.pillar}:`));
    console.error(c("dim", "    " + (r.stderr || r.stdout || "").split("\n")[0]));
    continue;
  }
  const intake = r.stdout.match(/Intake:\s+(\S+)/)?.[1] || "(?)";
  console.log(c("dim", `    intake: ${intake} · project: ${projectId}`));
  runPlan.push({ pillar: p.pillar, cmd: `nrv dispatch ${p.business} --brief-file=${briefFile} --manifest=${manifestFile} --project=${projectId}` });
}

// Print run plan
console.log("");
console.log(c("lime", "▶") + c("bold", " Run plan"));
console.log("");
console.log(c("dim", "  Para cada pillar, rode:"));
console.log("");
for (const r of runPlan) {
  console.log(c("yellow", `  ${r.cmd}`));
}
console.log("");
console.log(c("cyan", "  Ou em sequência:"));
console.log("    " + c("yellow", `nrv launch ${projectName} --pillars=... && nrv launch-run`));
console.log("");
console.log(c("green", `✓ Scaffold criado em ${outputsRoot}/`));
console.log(c("dim", "  Cada pillar tem brief.md + deliverables.json prontos para dispatch."));

process.exit(0);
