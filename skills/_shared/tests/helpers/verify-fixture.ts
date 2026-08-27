// verify-fixture.ts — complete entities in a temp root for the admission-gate
// tests. Every fixture is admitted as built; a test breaks exactly one thing.
// Nothing here touches the installed library: every path is under mkdtemp and
// the CLI env redirects HOME-derived roots, state, logs and baselines there.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { extractSurface, writeSurface, type ArtifactKind } from "../../lib/surface.ts";

export const REPO = path.resolve(import.meta.dir, "..", "..", "..", "..");
export const VERIFY_CLI = path.join(REPO, "skills", "_shared", "scripts", "verify.ts");

export function tempRoot(prefix = "nrv-verify-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const d of ["home", "state", "logs", "dna", "squads", "businesses", "cwd"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

export function cliEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NIRVANA_HOME: path.join(root, "home"),
    NIRVANA_STATE_DIR: path.join(root, "state"),
    HARNESS_LOGS_DIR: path.join(root, "logs"),
    DNA_LIBRARY: path.join(root, "dna"),
    SQUADS_DIR: path.join(root, "squads"),
    BUSINESSES_DIR: path.join(root, "businesses"),
    NIRVANA_SKILLS_DIR: path.join(REPO, "skills"),
    NIRVANA_NO_UPDATE_CHECK: "1",
    NIRVANA_SCOPE: "global",
    ...extra,
  };
}

export function runCli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [VERIFY_CLI, ...args], { cwd: path.join(root, "cwd"), env: cliEnv(root, extra), encoding: "utf8" });
  let json: any = null;
  if (args.includes("--json")) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json };
}

export function writeSurfaceFor(dir: string, kind: ArtifactKind): void {
  writeSurface(dir, extractSurface(dir, kind));
}

const DOMAINS = [
  "tom de voz de marca", "brand tone of voice", "narrativa de marca", "brand narrative", "manifesto de marca", "brand manifesto",
  "posicionamento", "positioning", "arquétipo de marca", "brand archetype", "slogan", "tagline", "identidade verbal", "verbal identity",
  "storytelling corporativo", "corporate storytelling", "marca confusa", "ninguém entende o que a empresa faz", "reposicionar a marca",
  "rebranding", "brand voice guidelines", "guia de voz",
];

export interface CloneOpts {
  name?: string;
  category?: string;
  routing?: Record<string, unknown> | null;
  verdict?: string | null;
  sourceMaterial?: boolean;
  dnaLayers?: Record<string, number> | null;
  fonte?: boolean;
  artifacts?: Array<{ path: string; status?: string }>;
  surface?: boolean;
  scores?: Record<string, number> | null;
  extraManifest?: string;
}

function yamlList(items: string[], indent = "    "): string {
  return items.map((d) => `${indent}- ${JSON.stringify(d)}`).join("\n");
}

/** A complete, admitted mind-clone at <root>/dna/<slug>. */
export function cloneFixture(root: string, slug: string, o: CloneOpts = {}): string {
  const dir = path.join(root, "dna", slug);
  fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dna"), { recursive: true });
  const routing = o.routing === null ? null : {
    one_liner: "Jane Doe — the choice for brand tone of voice and verbal identity",
    domains: DOMAINS,
    serves: "Choose Jane Doe when a brand needs a verbal identity: tone of voice, manifesto, positioning language.",
    not_for: "Visual identity and logo design (see a design clone).",
    refuses: ["logo design"],
    ...(o.routing ?? {}),
  };
  const dnaLayers = o.dnaLayers === null ? null : { L1_philosophies: 3, L2_mental_models: 4, L3_heuristics: 5, L4_frameworks: 3, L5_methodologies: 1, ...(o.dnaLayers ?? {}) };
  const artifacts = o.artifacts ?? [
    { path: "agent/AGENT.md", status: "present" }, { path: "agent/SOUL.md", status: "present" },
    { path: "agent/DNA-CONFIG.yaml", status: "present" }, { path: "dna/dna-schema.md", status: "present" },
  ];
  const scores = o.scores === null ? null : { template_compliance: 1.0, source_coverage: 0.9, coherence: 0.85, completeness: 1.0, ...(o.scores ?? {}) };
  const lines: string[] = [];
  lines.push("# fixture manifest — this comment must survive a --fix");
  lines.push("manifest:");
  lines.push(`  name: ${o.name ?? slug}`);
  lines.push(`  display_name: "Jane Doe"`);
  lines.push("  version: 1.0.0");
  lines.push(`  category: ${o.category ?? "marketing"}`);
  lines.push("  tags: [brand, voice, storytelling]");
  lines.push("  compiled_at: \"2026-08-26\"");
  if (routing) {
    lines.push("");
    lines.push("routing:");
    for (const [k, v] of Object.entries(routing)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) { lines.push(`  ${k}:`); lines.push(v.map((x) => `    - ${typeof x === "string" ? JSON.stringify(x) : x}`).join("\n")); }
      else lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("");
  lines.push("artifacts:");
  for (const a of artifacts) { lines.push(`  - path: ${a.path}`); if (a.status) lines.push(`    status: ${a.status}`); }
  if (o.sourceMaterial !== false) {
    lines.push("");
    lines.push("source_material:");
    lines.push("  primary:");
    lines.push(yamlList(["Jane Doe, Brand Voice (2019)", "Jane Doe, talks 2020-2024"]));
  }
  if (scores) {
    lines.push("");
    lines.push("scores:");
    for (const [k, v] of Object.entries(scores)) lines.push(`  ${k}: ${v}`);
  }
  if (o.verdict !== null) lines.push("", `validation_verdict: ${o.verdict ?? "APPROVED"}`);
  if (dnaLayers) {
    lines.push("", "dna_layers:");
    for (const [k, v] of Object.entries(dnaLayers)) lines.push(`  ${k}: ${v}`);
  }
  if (o.extraManifest) lines.push("", o.extraManifest);
  fs.writeFileSync(path.join(dir, "MANIFEST.yaml"), lines.join("\n") + "\n", "utf8");

  fs.writeFileSync(path.join(dir, "agent", "AGENT.md"), [
    "---",
    `name: ${slug}`,
    'description: "Use quando precisar de identidade verbal de marca. Invocar para: tom de voz, manifesto. NÃO usar para: identidade visual."',
    "---",
    "",
    "# Jane Doe — Mind-Clone",
    "",
    "## Identity", "", "A brand voice strategist.", "",
    "## How You Think", "", "Voice before visuals.", "",
    "## Frameworks", "", "The verbal identity ladder.", "",
    "## Limitations", "", "No logo design.", "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(dir, "agent", "SOUL.md"), "# SOUL\n\nVoice: warm, precise.\n", "utf8");
  fs.writeFileSync(path.join(dir, "agent", "DNA-CONFIG.yaml"), "voice:\n  tone: warm\n", "utf8");

  const tag = o.fonte === false ? "" : " ^[FONTE:SOUL.md#V1]";
  const li = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. **Item ${i + 1}.** Statement ${i + 1}.${tag}`).join("\n");
  const h3 = (n: number, label: string) => Array.from({ length: n }, (_, i) => `### ${label} ${i + 1} — Name\n\nBody ${i + 1}.${tag}`).join("\n\n");
  fs.writeFileSync(path.join(dir, "dna", "dna-schema.md"), [
    "# DNA Schema — Jane Doe", "",
    "## L1 — Philosophies", "", li(3), "",
    "## L2 — Mental Models", "", li(4), "",
    "## L3 — Heuristics", "", li(5), "",
    "## L4 — Frameworks", "", h3(3, "Framework"), "",
    "## L5 — Methodologies", "", h3(1, "Method"), "",
  ].join("\n") + "\n", "utf8");

  if (o.surface !== false) writeSurfaceFor(dir, "mind-clone");
  return dir;
}

export function squadFixture(root: string, slug: string, o: { surface?: boolean; manifest?: string } = {}): string {
  const dir = path.join(root, "squads", slug);
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), o.manifest ?? `name: ${slug}\nversion: 1.0.0\nprotocol: "5.0"\n`, "utf8");
  fs.writeFileSync(path.join(dir, "tasks", "main.md"), "# main\n\nDo the thing.\n", "utf8");
  if (o.surface !== false) writeSurfaceFor(dir, "squad");
  return dir;
}

export function businessFixture(root: string, slug: string, o: { surface?: boolean; manifest?: string } = {}): string {
  const dir = path.join(root, "businesses", slug);
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  fs.writeFileSync(path.join(dir, "business.yaml"), o.manifest ?? `name: ${slug}\nversion: 1.0.0\nprotocol: "1.0"\n`, "utf8");
  fs.writeFileSync(path.join(dir, "employees", "ceo.md"), "---\nname: ceo\nrole: CEO\n---\n\n# CEO\n", "utf8");
  if (o.surface !== false) writeSurfaceFor(dir, "business");
  return dir;
}

/** sha of every file under dir, for byte-identical assertions. */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = Bun.hash(fs.readFileSync(path.join(dir, r))).toString(16);
    }
  };
  walk("");
  return out;
}

export function rmrf(dir: string): void {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e: any) { if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(e?.code) || i === 9) throw e; Bun.sleepSync(100); }
  }
}
