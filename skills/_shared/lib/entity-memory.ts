// entity-memory.ts — where this machine keeps what it learned about an entity.
//
// The rule, and the reason for it: memory NEVER lives inside a business, a squad
// or a mind-clone. Those directories are the product. They are replaced wholesale
// when a pack updates, when `nrv migrate` rewrites them, when a buyer reinstalls
// — so anything accumulated there is written on a surface designed to be
// overwritten. The engine already has two places that exist precisely for state
// that must outlive the thing it describes: `~/.nirvana` for what belongs to the
// machine, and `<projectRoot>/.nirvana` for what belongs to one project.
//
// **The scope is a judgement, not a location.** Which of those two homes a fact
// belongs in is decided by the agent recording it, from the meaning of the fact
// — never inferred from the directory a command happened to run in. "This client
// approves by WhatsApp" is true of the business wherever it works, and belongs to
// the machine. "For this engagement the deadline is the 15th" is true here and
// nowhere else, and belongs to the project. Deriving that from cwd would file the
// first one under whichever project was open at the time, and hide it from every
// other project that needed it — which is the same class of loss as keeping it
// inside the entity, one level up.
//
// So a WRITE always states its scope, and a READ always returns both, labelled,
// because both are true and the agent has to be able to tell them apart.
//
// Layout, per scope:
//   <.nirvana>/memory/<kind>/<slug>/permanent.md   curated by the owner
//   <.nirvana>/memory/<kind>/<slug>/learned.md     promoted from past runs
//
// Legacy: a business shipped `memory/permanent.md` inside its own directory, and
// packs still seed one. That file is treated as a SEED — read once to populate
// the GLOBAL home when it is empty (a globally installed entity's shipped
// knowledge is machine-wide by construction), never written to, and never read
// again. A pack update then refreshes the seed without touching what the owner
// accumulated, which is the failure this module exists to end.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EntityKind = "businesses" | "squads" | "mind-clones";

/**
 * Where a fact is true. Chosen by whoever records it, from what the fact means.
 *
 * NOT the same thing as `resolveScope()`, and the collision of the word is worth
 * naming because it is easy to conflate. That scope answers exactly one
 * question — do the businesses and squads of this run come from `~/businesses`
 * and `~/squads`, or from the project's own copies. It decides WHERE ENTITIES
 * COME FROM, and nothing else.
 *
 * This one decides where a piece of knowledge belongs, and the answer comes from
 * the knowledge: something that has to hold everywhere goes to `~/.nirvana`;
 * something that is only true of this project's application of the entity goes
 * to `./.nirvana`. A globally sourced business can perfectly well accumulate
 * project memory, and a project-local squad can teach the machine something
 * general — so reading one from the other would be wrong in both directions.
 */
export type MemoryScope = "global" | "project";

/** The two files a curated memory is made of, in the order a reader should meet
 *  them: what the owner wrote by hand, then what past runs proposed and a human
 *  promoted. `learned.md` had a reader in the docs and none in the code — the
 *  businesses SKILL.md has said "both are read at dispatch" while nothing in the
 *  engine ever opened it. */
export const MEMORY_FILES = ["permanent.md", "learned.md"] as const;

/** The machine's `.nirvana`.
 *
 *  Honours `NIRVANA_HOME` like every other path in the engine (`bun-helpers.ts`
 *  resolves SQUADS_DIR, BUSINESSES_DIR and the rest the same way), so a redirected
 *  install keeps its memory beside its entities instead of in the real home —
 *  and so a test can exercise the global scope without writing into the owner's. */
export function globalMemoryHome(): string {
  return path.join(process.env.NIRVANA_HOME || os.homedir(), ".nirvana");
}

/**
 * The home for an explicitly chosen scope.
 *
 * `project` needs a project to be in; asking for it without one is a caller
 * error rather than a reason to silently write somewhere else, because writing a
 * project fact into the machine's memory would leak it into every other project.
 */
export function memoryHomeFor(scope: MemoryScope, projectRoot?: string): string {
  if (scope === "global") return globalMemoryHome();
  if (!projectRoot) throw new Error("memory scope 'project' needs a projectRoot — refusing to fall back to global");
  return path.join(projectRoot, ".nirvana");
}

/** Where an entity's curated memory lives for one scope. Never inside the entity. */
export function entityMemoryDir(
  kind: EntityKind, slug: string, scope: MemoryScope = "global", projectRoot?: string,
): string {
  return path.join(memoryHomeFor(scope, projectRoot), "memory", kind, slug);
}

/** A stub is a seeded heading with nothing under it; it must not occupy the
 *  prompt as if it were curated knowledge. Same test the previous in-business
 *  reader used, so a business that was already skipped stays skipped. */
function isStub(text: string): boolean {
  const head = text.slice(0, 120).toLowerCase();
  return !text
    || /^#?\s*(permanent|learned)\s+memory\s*$/i.test(text)
    || /\(\s*(empty|vazio)/.test(head)
    || /_vazio_/.test(head);
}

/**
 * Copy an entity's shipped `memory/*.md` into the GLOBAL home, once.
 *
 * Global and not project-scoped on purpose: what a pack ships is knowledge about
 * an entity installed machine-wide, so it is true wherever that entity works.
 * Only fills a file the home does not already have, so it can run on every
 * dispatch and is a no-op after the first. Never deletes, and never writes back
 * into the entity: the seed stays where the pack put it and is simply not read
 * again.
 */
export function seedFromEntity(kind: EntityKind, slug: string, entityDir: string): string[] {
  const dest = entityMemoryDir(kind, slug, "global");
  const seeded: string[] = [];
  for (const name of MEMORY_FILES) {
    const to = path.join(dest, name);
    if (fs.existsSync(to)) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(entityDir, "memory", name), "utf8"); } catch { continue; }
    if (isStub(text.trim())) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(to, text, "utf8");
      seeded.push(name);
    } catch { /* unwritable home — the read below simply finds nothing */ }
  }
  return seeded;
}

/** One scope's curated content, already read. */
export interface ScopedMemory { scope: MemoryScope; dir: string; files: string[]; bytes: number; text: string }

export interface EntityMemory {
  /** Prompt-ready block, or "" when nothing is curated in either scope. */
  block: string;
  /** What each scope contributed. */
  scopes: ScopedMemory[];
  /** Bytes of memory content carried, both scopes together. */
  bytes: number;
  /** Files copied out of the entity into the global home on this call. */
  seeded: string[];
}

function readScope(kind: EntityKind, slug: string, scope: MemoryScope, projectRoot?: string): ScopedMemory | null {
  let dir: string;
  try { dir = entityMemoryDir(kind, slug, scope, projectRoot); } catch { return null; }
  const parts: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  for (const name of MEMORY_FILES) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, name), "utf8").trim(); } catch { continue; }
    if (isStub(text)) continue;
    files.push(name);
    bytes += Buffer.byteLength(text, "utf8");
    parts.push(`#### ${name}\n\n${text}`);
  }
  return parts.length ? { scope, dir, files, bytes, text: parts.join("\n\n") } : null;
}

/**
 * Read an entity's curated memory from BOTH scopes, whole.
 *
 * Both are returned, labelled, rather than the nearer one winning: a project
 * fact does not replace a machine fact, it narrows it, and an agent that cannot
 * tell which is which cannot decide correctly when they disagree.
 *
 * Nothing is cut. The previous reader clamped at 8,000 characters with a
 * four-word marker naming neither the size nor the path, so a business whose
 * memory had grown past it honored a fraction of its own record and no one — not
 * the model, not the audit log, not the owner — was told which fraction. When a
 * memory is large enough to be worth noticing, the block says so and says where
 * the file is, so the reader can go to the source instead of guessing at a
 * silence.
 */
export function readEntityMemory(
  kind: EntityKind,
  slug: string,
  opts: { projectRoot?: string; entityDir?: string; noticeBytes?: number } = {},
): EntityMemory {
  const seeded = opts.entityDir ? seedFromEntity(kind, slug, opts.entityDir) : [];
  const notice = opts.noticeBytes ?? 8_000;

  const scopes = [
    readScope(kind, slug, "global"),
    opts.projectRoot ? readScope(kind, slug, "project", opts.projectRoot) : null,
  ].filter((s): s is ScopedMemory => s !== null);
  if (!scopes.length) return { block: "", scopes: [], bytes: 0, seeded };

  const bytes = scopes.reduce((n, s) => n + s.bytes, 0);
  const label: Record<MemoryScope, string> = {
    global: "GLOBAL — vale para esta entidade em qualquer projeto",
    project: "DESTE PROJETO — vale só aqui, e prevalece quando contradiz a global",
  };
  const body = scopes
    .map((s) => `### ${label[s.scope]}\n> \`${s.dir}\`\n\n${s.text}`)
    .join("\n\n");
  const over = bytes > notice
    ? `\n\n> Esta memória soma ${bytes} bytes, acima do ponto de atenção de ${notice} — ela chega **inteira** mesmo assim.`
    : "";

  const block = `## MEMÓRIA DESTA ENTIDADE — ${slug} (entre sessões)\n\n`
    + `> Lições, decisões e princípios que sobreviveram a execuções anteriores. Honre-os.\n`
    + `> Ficam fora do diretório da entidade, porque a entidade é substituída quando atualiza.\n\n`
    + `${body}${over}\n\n`
    + `> Para registrar algo novo, **você decide o escopo pelo que o fato significa**, não pelo diretório em que está: `
    + `\`nrv memory add ${slug} "<fato>" --scope global\` quando é verdade sobre a entidade em qualquer lugar, `
    + `\`--scope project\` quando só vale nesta execução/cliente. Na dúvida entre os dois, é project.\n\n---\n\n`;
  return { block, scopes, bytes, seeded };
}
