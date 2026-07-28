// clone-resolver.ts — the SINGLE canonical mind-clone persona resolver.
//
// Replaces the two divergent injection paths (the `dna/` walk that preferred the
// irregular LEGACY-SIMPLIFIED.md, and the assigned_mind_clones path that
// concatenated AGENT+SOUL+MANIFEST). Both the business loader (employee-prompt)
// and the squad loader resolve a clone's persona through THIS function, so the
// same clone always yields the same, complete embodiment.
//
// depth="full"    → AGENT.md + SOUL.md + dna/dna-schema.md  (complete embodiment)
// depth="concise" → AGENT.md only                            (catalog / preview)
//
// Resolution: read the clone's persona_files from the registry (fast); fall back
// to a scope-aware filesystem probe of scope.mindCloneDirs when the clone is not
// yet in the registry (fresh install before `nrv index`).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveScope } from "./scope.ts";
import { parseDnaSchema, type LayerKey } from "./dna-schema-parser.ts";

export type CloneDepth = "full" | "concise" | "fragments";

export type ClonePersona = {
  slug: string;
  display_name: string;
  content: string;
  files_used: string[];
  bytes: number;
  source: string;
  // Provenance (aditivo): de onde a persona foi resolvida e se houve degradação.
  resolved_by?: "registry" | "fs-probe";
  degraded?: boolean;
  reason?: string;
  // Fragments mode (aditivo): depth efetivo, camadas injetadas e o custo que um
  // dump full teria (para auditoria/economia de contexto).
  depth?: CloneDepth;
  layers_injected?: LayerKey[];
  full_bytes?: number;
};

export function cloneRegistryPath(): string {
  const scope = resolveScope();
  const dir = scope.projectRoot
    ? path.join(scope.projectRoot, ".nirvana")
    : path.join(os.homedir(), ".nirvana");
  return path.join(dir, ".mind-clones-registry.json");
}

export function loadCloneRegistry(): Record<string, any> {
  try {
    const p = cloneRegistryPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")).mind_clones || {};
    }
  } catch {
    /* fall through to empty — callers fall back to filesystem */
  }
  return {};
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Locate a clone's directory + persona files by slug, scope-aware, without the
 *  registry. Used as the fallback path. First matching root wins (project over
 *  global). */
function probeClone(slug: string): { dir: string; files: Record<string, string | null> } | null {
  const scope = resolveScope();
  for (const root of scope.mindCloneDirs) {
    const cand = path.join(root, slug);
    if (fs.existsSync(path.join(cand, "MANIFEST.yaml")) || fs.existsSync(path.join(cand, "manifest.yaml"))) {
      return {
        dir: cand,
        files: {
          agent: firstExisting(cand, ["agent/AGENT.md", "AGENT.md"]),
          soul: firstExisting(cand, ["agent/SOUL.md", "SOUL.md"]),
          dna_schema: firstExisting(cand, ["dna/dna-schema.md"]),
        },
      };
    }
  }
  return null;
}

/** Resolve a clone slug into its full persona content for prompt injection.
 *  Returns null if the clone does not exist anywhere in scope. */
function readFileSafe(f: string | null | undefined, used: string[]): string {
  if (f && fs.existsSync(f)) {
    try { const s = fs.readFileSync(f, "utf8"); used.push(f); return s; } catch { /* unreadable — skip */ }
  }
  return "";
}

export function resolveClonePersona(
  slug: string,
  opts: { depth?: CloneDepth; layers?: LayerKey[]; byteBudget?: number } = {},
): ClonePersona | null {
  let depth = opts.depth || "full";
  const entry = loadCloneRegistry()[slug];
  let dir: string | null = entry?.dir || null;
  let files: Record<string, string | null> | null = entry?.persona_files || null;
  let resolved_by: "registry" | "fs-probe" = "registry";
  let degraded = false;
  let degradeReason = "";

  if (!dir || !files) {
    const probed = probeClone(slug);
    if (!probed) return null;
    dir = probed.dir;
    files = probed.files;
    resolved_by = "fs-probe";
    degraded = true;
    degradeReason = "clone fora do registry (fs-probe) — rode nrv index";
  }

  const used: string[] = [];
  // full_bytes: o que um dump completo (agent+soul+dna) custaria — para auditar a economia.
  const fullBytes = ["agent", "soul", "dna_schema"].reduce((n, k) => {
    const f = files![k];
    try { return f && fs.existsSync(f) ? n + fs.statSync(f).size : n; } catch { return n; }
  }, 0);

  let content = "";
  let layers_injected: LayerKey[] | undefined;

  if (depth === "fragments") {
    // O AGENT.md é a ESPINHA OPERACIONAL da persona: Princípios, Frameworks
    // nomeados, Commands, `What You Refuse to Do` e `Limitations`. Ele NÃO é
    // redundante com o dna-schema — o schema é uma derivação em cinco camadas,
    // não um substituto.
    //
    // Até 2026-07-27 o caminho fragmentado não o lia, e isso não era "seleção
    // por camada": era trocar a definição do agente pelo resumo derivado dela.
    // Medido: o AGENT.md é 36% de tudo que o full injeta, e num teste cego de
    // 5 pares a persona inteira venceu 4 vezes — com um dos juízes decidindo
    // explicitamente por `Limitations`, seção que o fragmento não tinha como
    // enxergar. A economia vem de escolher CAMADAS do schema pela fase, nunca
    // de amputar um artefato inteiro.
    const agent = readFileSafe(files["agent"], used);
    const soul = readFileSafe(files["soul"], used);
    const dnaPath = files["dna_schema"];
    const dnaRaw = dnaPath && fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, "utf8") : "";
    const parsed = dnaRaw ? parseDnaSchema(dnaRaw) : { ok: false, layers: {}, coherence_map: "" };
    if (parsed.ok) {
      // L1 (axiomas) sempre + as camadas pedidas; dedup preservando ordem.
      const want = (["L1", ...(opts.layers || ["L3"])] as LayerKey[]).filter((v, i, a) => a.indexOf(v) === i);

      // Unidades IDENTIFICADAS, não um texto já colado. O orçamento só pode
      // descartar unidade inteira; cortar no meio de uma camada entrega método
      // pela metade, que é pior que método caro.
      type Unit = { kind: "agent" | "soul" | "layer" | "coherence"; key?: LayerKey; text: string };
      const units: Unit[] = [];
      if (agent) units.push({ kind: "agent", text: agent });
      if (soul) units.push({ kind: "soul", text: soul });
      for (const k of want) {
        const layer = parsed.layers[k];
        if (layer) units.push({ kind: "layer", key: k, text: layer.raw });
      }
      if (parsed.coherence_map) units.push({ kind: "coherence", text: parsed.coherence_map });

      const sizeOf = (u: Unit) => Buffer.byteLength(u.text, "utf8");
      const totalOf = (list: Unit[]) => list.reduce((n, u) => n + sizeOf(u), 0) + Math.max(0, list.length - 1) * 2;

      if (opts.byteBudget && totalOf(units) > opts.byteBudget) {
        // Único descarte admissível: o mapa de coerência, que é derivado das
        // camadas e não carrega método próprio.
        const i = units.findIndex((u) => u.kind === "coherence");
        if (i >= 0) units.splice(i, 1);
      }

      // Se ainda estoura, o fragmento SAI COMPLETO mesmo assim. O teto é
      // consultivo, não uma tesoura: entregar SOUL + as camadas que a fase pediu
      // acima do orçamento continua sendo uma fração do full (média 9.2 KB contra
      // 20.4 KB), enquanto amputar destrói justamente a camada que a fase
      // escolheu — o corte era na cauda, e a cauda é a camada específica.
      const overBudget = Boolean(opts.byteBudget && totalOf(units) > opts.byteBudget);
      if (overBudget) {
        degraded = true;
        degradeReason = degradeReason || `fragmento acima do orçamento (${totalOf(units)}B > ${opts.byteBudget}B), entregue íntegro`;
      }

      if (dnaPath) used.push(dnaPath);
      content = units.map((u) => u.text).join("\n\n");
      layers_injected = units.filter((u): u is Unit & { key: LayerKey } => u.kind === "layer").map((u) => u.key);
    } else {
      // Schema ausente/ilegível → fallback para full (nunca perde a persona).
      depth = "full";
      degraded = true;
      degradeReason = degradeReason || (dnaRaw ? "dna-schema não parseável — fallback full" : "sem dna-schema.md — fallback full");
    }
    if (!content && depth === "fragments") depth = "full"; // soul+layers vazio → cai pro full
  }

  if (depth !== "fragments") {
    const order = depth === "full" ? ["agent", "soul", "dna_schema"] : ["agent"];
    const parts: string[] = [];
    for (const k of order) {
      const s = readFileSafe(files[k], used);
      if (s) parts.push(s);
    }
    if (!parts.length) return null;
    content = parts.join("\n\n");
  }

  // Byte budget: trunca numa quebra de linha (evita cortar no meio de uma frase).
  // O corte cego na cauda continua valendo só para os caminhos NÃO fragmentados
  // (full/concise), onde não há unidade semântica para descartar. No fragmentado
  // ele destruiria a camada da fase e preservaria a que entra sempre.
  if (depth !== "fragments" && opts.byteBudget && content.length > opts.byteBudget) {
    let cut = content.lastIndexOf("\n", opts.byteBudget);
    if (cut < opts.byteBudget * 0.6) cut = opts.byteBudget; // quebra cedo demais → corta direto
    content = content.slice(0, cut).trimEnd() + "\n\n…(persona truncada ao orçamento)";
    degraded = true;
    degradeReason = degradeReason || "persona truncada (byteBudget)";
  }

  if (!content) return null;
  return {
    slug,
    display_name: entry?.display_name || slug,
    content,
    files_used: used,
    bytes: content.length,
    source: dir,
    resolved_by,
    degraded,
    reason: degradeReason,
    depth,
    layers_injected,
    full_bytes: fullBytes,
  };
}
