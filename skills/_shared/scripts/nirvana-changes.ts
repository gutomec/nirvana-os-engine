#!/usr/bin/env bun
// nirvana-changes.ts — gera e consulta a superfície de contrato dos artefatos.
//
//   gen <dir...> [--dry]     regenera a superfície, deriva o bump e escreve
//                            .nirvana-surface.json + CHANGES.json + CHANGELOG.md
//   gen --all [--dry]        varre ~/squads, ~/businesses e a biblioteca de clones
//   diff <instalado> <novo>  compara dois diretórios do MESMO artefato (JSON)
//   show <dir>               imprime a superfície atual
//
// Idempotência é contrato: rodar `gen` duas vezes sem mexer em nada NÃO pode
// alterar byte nenhum. O arquivo de superfície entra no hashDir() do install, e
// um gerador instável marcaria todo artefato como atualizado a cada build.

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
  console.error(`erro: ${msg}`);
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

/** Histórico acumulado das mudanças do artefato, do mais recente ao mais antigo. */
function appendChanges(dir: string, version: string, result: DiffResult): void {
  const f = path.join(dir, CHANGES_FILE);
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(f, "utf8"))?.history ?? []; } catch { /* primeiro registro */ }
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
  // Schema diferente = o extrator mudou o que mede. O diff é suprimido de
  // propósito (senão inundaria compradores com mudanças fantasma), mas a
  // superfície PRECISA ser regravada com o schema novo. Sem isto a supressão
  // deixa de ser transição e vira permanente: o arquivo em disco fica no schema
  // antigo para sempre e toda mudança real futura é engolida em silêncio.
  const rebaseline = before !== null && before.schema !== next.schema;

  // Sem mudança e sem rebaseline: não toca em nada. É o que garante a idempotência.
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
      // A anotação de comportamento já foi absorvida no histórico: mantê-la faria
      // ela reaparecer em toda release seguinte.
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
      try { if (fs.statSync(d).isDirectory() && detectKind(d)) dirs.push(d); } catch { /* ignora */ }
    }
  }
  return dirs;
}

// ───────────────────────────── comandos ─────────────────────────────

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

  // Linha de base não é mudança: o artefato ainda não tinha superfície, então não
  // há nada a migrar. Contar junto faria a primeira execução parecer um desastre.
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

// ─────────────── pending / ack: o que o PROJETO ainda não viu ───────────────
//
// Changelog que o agente precisa abrir é changelog que o agente não lê. Estes dois
// comandos existem para que a mudança chegue pelo canal que ele JÁ lê — o brief de
// dispatch — e para que cada projeto seja avisado uma única vez.

const SEEN_FILE = "nirvana-seen.json";

function seenPath(projectDir: string): string {
  return path.join(projectDir, SEEN_FILE);
}

function readSeen(projectDir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(seenPath(projectDir), "utf8")) ?? {}; } catch { return {}; }
}

/** Diretório instalado de um `squads/<slug>` ou `businesses/<slug>`. */
function resolveEntity(entity: string): { dir: string; label: string } | null {
  // Caminho direto vence: cobre instalação fora do padrão e permite testar sem
  // depender do que está na biblioteca do usuário.
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
    // Artefato sem superfície não é erro: é um pack anterior a esta feature.
    console.log(JSON.stringify({ entity: resolved.label, pending: false, reason: "sem superfície" }));
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

  // Primeiro uso do projeto com esta entidade: nada mudou "para ele".
  if (!lastSeen || lastSeen === surface.contract_version) {
    console.log(JSON.stringify({ entity: resolved.label, version: surface.contract_version, pending: false }));
    process.exit(0);
  }

  // Junta as entradas do histórico posteriores à versão que o projeto conhece.
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(path.join(resolved.dir, CHANGES_FILE), "utf8"))?.history ?? []; } catch { /* sem histórico */ }
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
    // Bloco pronto para entrar no brief: o orquestrador cola, não reformula.
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

console.log(`nirvana-changes — superfície de contrato dos artefatos

  gen <dir...> [--dry]      regenera superfície, deriva bump, escreve ${CHANGES_FILE} + ${CHANGELOG_FILE}
  gen --all [--dry]         varre ~/squads, ~/businesses e a biblioteca de clones
  diff <instalado> <novo>   compara dois diretórios do mesmo artefato (JSON; sai 1 se houver quebra)
  show <dir>                imprime a superfície atual
  pending <ent> [--project <dir>]  mudanças que ESTE projeto ainda não viu (sai 1 se houver quebra)
  ack <ent> [--project <dir>]      marca a versão atual como vista por este projeto

Arquivos no artefato:
  ${SURFACE_FILE}   superfície (gerado, determinístico)
  ${CHANGES_FILE}            histórico tipado das mudanças (gerado)
  ${CHANGELOG_FILE}          leitura humana (gerado — não editar)
  ${BEHAVIOR_FILE}  anotação MANUAL de mudança de comportamento; consumida e apagada no gen`);
process.exit(cmd ? 2 : 0);
