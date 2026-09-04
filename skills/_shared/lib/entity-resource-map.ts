// entity-resource-map.ts — what an entity carries beyond what the prompt inlines.
//
// A dispatched agent used to see only the fragment of its entity that the prompt
// assembled: for a squad, the agents and tasks its workflow names; for a
// business, the one employee file of the seat running. Everything else the
// author wrote — `references/`, `checklists/`, `templates/`, `standards/`,
// `schemas/`, `config/`, `scripts/`, `playbooks/`, `rubrics/`, `lib/` — was
// invisible, and the entity's own directory was never granted, so naming a path
// would not have helped either.
//
// This is the skill pattern applied to entities: the NAMES travel in the prompt,
// the BYTES stay on disk, and the agent loads in cascade only what its execution
// turns out to need. The map is one level deep — files by name, subdirectories
// with a trailing slash — because the point is to prove the tree exists and give
// a door into it, not to serialize it.
//
// The map is a map, not an instruction. What a step MUST obey stays inlined: a
// path is a request, and inlined text is a fact. The caller grants the entity
// directory alongside it, so the door the map names actually opens.
//
// It lives here, shared, because it was written for squads first and businesses
// needed exactly the same thing. A second copy is how the two would drift — the
// same reason `isRunStatePath` has one owner and this consults it rather than
// keeping a private list of what run state is called.

import * as fs from "node:fs";
import * as path from "node:path";
import { isRunStatePath } from "./run-state.ts";
import { enumerate, resolveScope } from "./scope.ts";
import { paths } from "./bun-helpers.ts";

/** Directories the map never names, on top of run state.
 *
 *  Build and dependency output, never authored content — and `node_modules`
 *  alone would bury the map it is listed in. Run state is NOT listed here:
 *  `isRunStatePath` owns that list (`.runs`, `outputs`, `projects`, `.nirvana`,
 *  …), and keeping a private second copy of it is precisely how a path that
 *  should never travel starts travelling again.
 *
 *  This is a DENYLIST on purpose. The first cut was an allowlist of five
 *  directory names chosen by hand, and surveying real entities showed what that
 *  costs: it would have hidden `config/`, `schemas/`, `scripts/`, `data/`,
 *  `tools/` and `lib/` outright, and `reference/` — the singular spelling some
 *  authors use — from everyone who spells it that way. A curated list of what an
 *  agent may see is a list of what one person happened to think of. Everything
 *  the entity ships, the agent is told about. */
const MAP_EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "__pycache__", ".venv", "venv",
]);

/**
 * A real cap, and NOT the silent-truncation mistake this codebase spent a day
 * undoing. That one dropped the documents a step depends on: content the run
 * cannot proceed without and cannot get any other way. This caps a directory
 * INDEX — the names are recoverable with one `ls` against a directory the
 * dispatch has already granted, and the overflow line says exactly that.
 *
 * Without a cap the map inherits the failure it replaced from the other side: an
 * entity with a `data/` of fifty thousand files would push megabytes of
 * filenames into every prompt it ever runs. A budget belongs where the content
 * is reproducible; it does not belong where the content is the instruction.
 */
const MAP_ENTRIES_PER_DIR = 50;

export interface ResourceMapOptions {
  /** `squads` or `businesses` — decides which run-state list applies. */
  kind: "squads" | "businesses";
  /** Directories the prompt already carries IN FULL, hidden from the map to
   *  avoid saying twice what was already said. Pass an empty set when the prompt
   *  carries only a sample of them: a squad's legacy fallback ships an
   *  alphabetical first-three under a "(top 3)" heading, which is not the same
   *  thing as carrying the directory, and hiding it there switched the map off
   *  for the one path with most of itself missing. */
  inlined?: Iterable<string>;
  /** Heading noun, e.g. "ESTE SQUAD" / "ESTA EMPRESA". */
  label: string;
  /** How the prose names the tree, e.g. "do squad" / "da empresa". Kept explicit
   *  rather than derived from `label`: a reader who is told "a fonte" and not
   *  "a fonte do squad" has to infer which tree the read-only rule covers, and
   *  the rule is exactly the one that must not need inferring. */
  sourceNoun?: string;
  /** Where deliverables go, named so the read-only rule has an alternative. */
  outputsHint?: string;
}

/**
 * The entity's other directories, as a map. Returns "" when there is nothing
 * beyond what the prompt already carries, so the section never appears empty.
 */
export function renderResourceMap(entityDir: string, opts: ResourceMapOptions): string {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(entityDir, { withFileTypes: true }); } catch { return ""; }
  const inlined = new Set(opts.inlined ?? []);
  const authored = entries.filter(e =>
    e.isDirectory() && !inlined.has(e.name) && !MAP_EXCLUDED_DIRS.has(e.name) && !isRunStatePath(e.name, opts.kind));

  const lines: string[] = [];
  for (const dir of authored.sort((a, b) => a.name.localeCompare(b.name))) {
    let inner: fs.Dirent[];
    try { inner = fs.readdirSync(path.join(entityDir, dir.name), { withFileTypes: true }); } catch { continue; }
    const names = inner
      .filter(e => !e.name.startsWith("."))
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .sort();
    if (!names.length) continue;
    const shown = names.slice(0, MAP_ENTRIES_PER_DIR).map(n => `\`${n}\``).join(", ");
    const rest = names.length - MAP_ENTRIES_PER_DIR;
    lines.push(`- \`${dir.name}/\` — ${shown}${rest > 0 ? ` … e mais ${rest}: rode \`ls\` nesse diretório para a lista inteira` : ""}`);
  }
  if (!lines.length) return "";

  const out = opts.outputsHint ?? "o diretório de saída indicado na sua tarefa";
  const noun = opts.sourceNoun ? ` ${opts.sourceNoun}` : "";
  return `## O QUE MAIS ${opts.label} CARREGA
Tudo abaixo existe em \`${entityDir}\` e **não** está neste prompt. Abra o que precisar, quando precisar, em cascata — nada aqui é obrigatório, e nada aqui foi resumido: o arquivo em disco é o conteúdo. Um nome terminado em \`/\` é subdiretório, desça nele.

Este diretório é a fonte${noun}, compartilhada por todo projeto desta máquina e lida por toda execução futura: **é somente leitura para você**. Não edite, crie nem apague nada aqui, nem para "corrigir" um template ou anotar um resultado. Todo arquivo que você produzir vai para ${out}.

${lines.join("\n")}`;
}

/**
 * Where an entity lives for THIS run: the project's copy when scope resolves one,
 * the global otherwise.
 *
 * It lives here because it grew a second consumer. `employee-prompt` uses it to
 * read the manifest and the seat; `team-orchestrator` needs the exact same path
 * to grant in the dispatch, and granting a different directory than the prompt
 * describes is worse than granting none — the agent gets the map of one tree and
 * the key to another.
 */
export function resolveEntityDir(kind: "businesses" | "squads", slug: string, projectDir: string): string {
  try {
    const hit = enumerate(resolveScope({ cwd: projectDir }), kind).find(e => e.slug === slug && !e.overridden);
    if (hit) return hit.dir;
  } catch { /* cai no global */ }
  return path.join(kind === "businesses" ? paths.BUSINESSES_DIR : paths.SQUADS_DIR, slug);
}
