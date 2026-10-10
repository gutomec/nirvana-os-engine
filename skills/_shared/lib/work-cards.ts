// work-cards.ts — the cards a solo worker reads instead of whole folders.
//
// A squad on disk can carry hundreds of kilobytes of agents, tasks and
// workflows (one measured at 357 KB of .md and .yaml). A worker that uses the
// squad by reading it needs a map, not the territory: one line per capability,
// agent, task and workflow, each with the path to open when a step needs it.
//
// The routing cards (harness/lib/routing-cards.ts) answer "which target?" in
// one line per entity. These answer "how do I work as it?", and are compiled
// per run from the files' frontmatter only, so they are never stale and never
// cached. Deterministic: no model is involved.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { squadEnvLines } from "./squad-env.ts";

const flat = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();

/** Clip at a sentence end when one sits in the last 40%, else at a word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : max)}…`;
}

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((x) => flat(x)).filter(Boolean) : [];

function readYaml(file: string): Record<string, any> | null {
  try {
    const parsed = parseYaml(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** The YAML frontmatter of a Markdown file, or {} when it has none or it does not parse. */
export function frontmatterOf(file: string): Record<string, any> {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    const parsed = m ? parseYaml(m[1]) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e)) && !f.startsWith(".")).sort();
  } catch { return []; }
}

/** A workflow reference resolved to the file that carries it (v6 Markdown, v5 YAML). */
function workflowFile(dir: string, ref: string): string | null {
  const base = path.join(dir, ref.replace(/\.(md|ya?ml)$/, ""));
  for (const ext of [".md", ".yaml", ".yml"]) if (fs.existsSync(base + ext)) return base + ext;
  return fs.existsSync(path.join(dir, ref)) ? path.join(dir, ref) : null;
}

function workflowDoc(file: string): Record<string, any> {
  return file.endsWith(".md") ? frontmatterOf(file) : readYaml(file) ?? {};
}

/** `id(agent)` per step, in declared order. */
function stepsLine(doc: Record<string, any>): string {
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  return steps
    .map((s: any) => {
      const id = flat(s?.id ?? s?.task ?? "");
      const agent = flat(s?.agent ?? "");
      return id ? (agent ? `${id} (${agent})` : id) : "";
    })
    .filter(Boolean)
    .join(" → ");
}

/**
 * The squad as a map: capabilities first (what it can deliver and how each is
 * run), then its agents, tasks and workflows, one line each, every line ending
 * in the file to open. Returns null when the folder has no squad.yaml.
 * `envProblems` are failures of the squad's environment the worker should know
 * about; the Python and Node lines come on their own when the squad's
 * environment has them (squad-env.ts squadEnvLines).
 */
export function squadWorkCard(slug: string, dir: string, envProblems: string[] = []): string | null {
  const manifest = readYaml(path.join(dir, "squad.yaml"));
  if (!manifest) return null;
  const lines: string[] = [];
  const version = manifest.version ? ` v${flat(manifest.version)}` : "";
  lines.push(`# Squad card: ${slug}${version}`, "");
  if (manifest.description) lines.push(clip(flat(manifest.description), 300), "");
  lines.push(`Folder: \`${dir}\``, "");
  const env = squadEnvLines(slug, envProblems);
  if (env.length) lines.push(...env, "");

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (capabilities.length) {
    lines.push("## Capabilities", "");
    for (const c of capabilities) {
      const id = flat(c?.id);
      if (!id) continue;
      const parts = [`- \`${id}\`: ${clip(flat(c?.description), 200)}`];
      const ref = flat(c?.invoke?.ref);
      if (ref) parts.push(`Runs ${flat(c?.invoke?.type) || "workflow"} \`${ref}\`.`);
      const produces = strList(c?.produces);
      if (produces.length) parts.push(`Produces: ${produces.join(", ")}.`);
      const acceptance = (Array.isArray(c?.acceptance) ? c.acceptance : [])
        .map((a: any) => flat(a?.id) + (a?.blocking ? "*" : ""))
        .filter((x: string) => x && x !== "*");
      if (acceptance.length) parts.push(`Acceptance: ${acceptance.join(", ")} (* blocking).`);
      lines.push(parts.join(" "));
    }
    lines.push("");
  }

  const section = (title: string, sub: string) => {
    const files = listFiles(path.join(dir, sub), [".md"]);
    if (!files.length) return;
    lines.push(`## ${title}`, "");
    for (const f of files) {
      const fm = frontmatterOf(path.join(dir, sub, f));
      const name = flat(fm.name) || path.basename(f, ".md");
      const desc = clip(flat(fm.description ?? fm.role ?? ""), 160);
      lines.push(`- \`${name}\`${desc ? `: ${desc}` : ""} → \`${sub}/${f}\``);
    }
    lines.push("");
  };
  section("Agents", "agents");
  section("Tasks", "tasks");

  const wfDir = path.join(dir, "workflows");
  const wfFiles = listFiles(wfDir, [".md", ".yaml", ".yml"]);
  if (wfFiles.length) {
    lines.push("## Workflows", "");
    for (const f of wfFiles) {
      const file = workflowFile(wfDir, f);
      if (!file) continue;
      const doc = workflowDoc(file);
      const name = flat(doc.name) || f.replace(/\.(md|ya?ml)$/, "");
      const desc = clip(flat(doc.description), 160);
      const steps = stepsLine(doc);
      lines.push(`- \`${name}\`${desc ? `: ${desc}` : ""}${steps ? `. Steps: ${steps}` : ""} → \`workflows/${f}\``);
    }
    lines.push("");
  }

  lines.push(
    "## Working as this squad",
    "",
    "Pick the capability your part needs, open its workflow or task, and for each step you run open that step's agent file: you work as that agent, with its method and its acceptance. Open nothing else unless a step needs it. Do not dispatch the squad; you are running it.",
  );
  return lines.join("\n") + "\n";
}

/**
 * Write the cards of `squads` under `cardsDir`, one file each, and return the
 * written paths by slug. A squad whose folder has no manifest gets no card.
 */
export function writeSquadCards(cardsDir: string, squads: string[], dirOf: (slug: string) => string,
  envProblems: Record<string, string[]> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slug of [...new Set(squads)]) {
    const card = squadWorkCard(slug, dirOf(slug), envProblems[slug]);
    if (!card) continue;
    fs.mkdirSync(cardsDir, { recursive: true });
    const file = path.join(cardsDir, `squad-${slug}.md`);
    fs.writeFileSync(file, card, "utf8");
    out[slug] = file;
  }
  return out;
}
