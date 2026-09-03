// squad-exec.test.ts — the extracted squad headless runner (Phase 4.1).
//
// team-orchestrator.ts now delegates its mandatory-squad execution here; the
// squad-only dispatch route uses the same code path. Pins: prompt content
// (team-mandatory framing byte-compatible with the pre-extraction
// team-orchestrator prompt), audit chain, session reuse with the one-cold-
// retry fallback, and the missing-squad failure. Zero-token via the
// runWithCascade seam.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSquadHeadless, buildSquadPrompt, capabilityContext, promptPath } from "../lib/squad-exec.ts";
import { sessionKey, putSession } from "../lib/session-store.ts";
import { SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";

let tmp: string;
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squadexec-"));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function scaffoldSquad(root: string, slug: string): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}\nMANIFEST-MARKER: yes\n`);
  fs.writeFileSync(path.join(dir, "agents", "lead.md"), "# Lead agent AGENT-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "do-it.md"), "# Do it TASK-MARKER");
  return dir;
}

function okCascadeResult(opts: any, sessionId: string | null = "sess-sq-1") {
  return {
    ok: true, runtime: opts.runtime, sessionId, result: "",
    costUsd: 0.02, exitCode: 0, stderr: "", durationMs: 7,
    handoffs: [], finalRuntime: opts.runtime,
  };
}

function readAudit(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, "logs", day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => parseAuditLine(l));
}

describe("buildSquadPrompt — framing per mode", () => {
  test("team-mandatory framing is byte-compatible with the pre-extraction prompt", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief",
      outDir: "/out/dir", mode: "team-mandatory",
      cloneInjection: { block: "", decision: "PADRÃO — nenhum clone útil" },
    });
    // The exact header + footer sentences the team orchestrator always sent.
    expect(p).toContain('Você É o squad "brandcraft" executando uma sub-tarefa de um business maior. Sua saída é input do synthesizer do business.');
    expect(p).toContain("Termine quando o trabalho estiver pronto para o synthesizer integrar.");
    expect(p).toContain("MANIFEST-MARKER");
    expect(p).toContain("AGENT-MARKER");
    expect(p).toContain("TASK-MARKER");
    expect(p).toContain("/out/dir");
  });

  test("squad-only framing addresses the end user, not a synthesizer", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief",
      outDir: "/out/dir", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" },
    });
    expect(p).toContain("de ponta a ponta");
    expect(p).toContain("ENTREGÁVEL FINAL");
    expect(p).not.toContain("synthesizer do business");
  });

  test("both framings carry the scope guard in PT-BR, inside the sub-task block", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    for (const mode of ["team-mandatory", "squad-only"] as const) {
      const p = buildSquadPrompt({ squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", mode, cloneInjection: { block: "", decision: "PADRÃO" } });
      const subTask = p.slice(p.indexOf("## SUA SUB-TAREFA"), p.indexOf("## SAÍDA"));
      expect(subTask).toContain(SCOPE_GUARD_PT_BR);
    }
  });

  // The whole string, not a set of substrings: without a resolved capability the
  // prompt is the one the engine has always sent — plus the resource map, which
  // is the ONE deliberate departure from that invariant.
  //
  // This path is the fallback, and the fallback is the worst one: it carries an
  // alphabetical first-three of the squad's agents and tasks under a "(top 3)"
  // heading that never says three OF HOW MANY. A squad with eight agents showed
  // three and named none of the rest, and it is the path every hand-written
  // squad without `capabilities[]` lands on. Withholding the map here to keep
  // the pin green would have kept the invariant by keeping the defect.
  test("no capability: the prompt is the historical one plus the resource map", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const expected = `Você É o squad "brandcraft" executando o brief do cliente de ponta a ponta. Sua saída é o ENTREGÁVEL FINAL para o usuário.

## SUA IDENTIDADE (squad.yaml)
\`\`\`yaml
name: brandcraft
MANIFEST-MARKER: yes

\`\`\`

## SEUS AGENTES (top 3)
--- lead.md ---
# Lead agent AGENT-MARKER

## SUAS TASKS (top 3)
--- do-it.md ---
# Do it TASK-MARKER

## O QUE MAIS ESTE SQUAD CARREGA
Tudo abaixo existe em \`${squadDir}\` e **não** está neste prompt. Abra o que precisar, quando precisar, em cascata — nada aqui é obrigatório, e nada aqui foi resumido: o arquivo em disco é o conteúdo. Um nome terminado em \`/\` é subdiretório, desça nele.

Este diretório é a fonte do squad, compartilhada por todo projeto desta máquina e lida por toda execução futura: **é somente leitura para você**. Não edite, crie nem apague nada aqui, nem para "corrigir" um template ou anotar um resultado. Todo arquivo que você produzir vai para o diretório de saída indicado na sua sub-tarefa.

- \`agents/\` — \`lead.md\`
- \`tasks/\` — \`do-it.md\`

## MIND-CLONES QUE VOCÊ INCORPORA (decisão: PADRÃO)
> Incorpore por inteiro; entregue COMO SE o clone tivesse produzido, sob a especialidade do squad.
(sem clone para esta tarefa — opere com a especialidade padrão do squad)

## BRIEF ORIGINAL DO CLIENTE
the brief

## SUA SUB-TAREFA
Execute a SUA especialidade aplicada ao brief acima. Escreva arquivos sob \`/out/dir\` (HTML, CSS, JS, MD, PNG/JPG via skills de imagem, o que for da sua expertise). Não invoque a skill harness, não rode \`nrv run\`/\`nrv dispatch\` para este mesmo brief (anti-loop). Pode usar Bash, Read, Write, Edit, geração de imagem (nano-banana-pro), e qualquer ferramenta disponível para entregar o melhor possível.

Se o brief mencionar você por nome (ex.: "use o squad brandcraft"), priorize fazer EXATAMENTE o que o usuário pediu nesse parágrafo. O usuário manda.

${SCOPE_GUARD_PT_BR} Escopo é o brief acima e os critérios de aceitação da sua sub-tarefa.

## SAÍDA
Arquivos no diretório acima. Não printe sumário — entregue arquivos. Termine quando o trabalho estiver pronto para entrega ao usuário.`;
    const args = { squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", mode: "squad-only" as const, cloneInjection: { block: "", decision: "PADRÃO" } };
    expect(buildSquadPrompt(args)).toBe(expected);
    // The three ways of saying "no capability" all land on the same bytes.
    expect(buildSquadPrompt({ ...args, capabilityId: null })).toBe(expected);
    expect(buildSquadPrompt({ ...args, capabilityId: "squad.execute" })).toBe(expected);
    // As does a capability id the manifest does not declare.
    expect(buildSquadPrompt({ ...args, capabilityId: "branding.nothing.here" })).toBe(expected);
  });
});

// ── the capability sections (Squad Protocol v6 §32) ─────────────────────────

/** A squad whose capability names a workflow, with two agents and two tasks on
 *  disk of which the workflow runs one each. */
function scaffoldCapabilitySquad(root: string, slug = "guided", opts: { workflow?: string; body?: string } = {}): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}
version: 1.0.0
protocol: "6.0"
capabilities:
  - id: analysis.report.produce
    description: Produce the guided analysis report for one account.
    produces:
      - report.md
      - dataset.json
    acceptance:
      - id: ac-sources
        description: Every claim cites a dated source.
        blocking: true
        minimumScore: 0.9
      - id: ac-length
        description: The report stays under twelve pages.
    invoke:
      type: workflow
      ref: workflows/guided-analysis
  - id: analysis.dataset.extract
    description: Extract the raw dataset only.
    invoke:
      type: workflow
      ref: workflows/extract-only
`);
  fs.writeFileSync(path.join(dir, "agents", "analyst.md"), "# Analyst ANALYST-MARKER");
  fs.writeFileSync(path.join(dir, "agents", "aardvark.md"), "# Aardvark AARDVARK-MARKER");
  fs.writeFileSync(path.join(dir, "agents", "writer.md"), "# Writer WRITER-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "collect.md"), "# Collect COLLECT-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "aaa-first.md"), "# Alphabetically first AAA-MARKER");
  fs.writeFileSync(path.join(dir, "workflows", "guided-analysis.md"), opts.workflow ?? `---
name: guided-analysis
steps:
  - id: collect
    agent: analyst
    task: collect
    creates: [dataset.json]
  - id: write
    agent: writer
    requires: [collect]
    creates: [report.md]
---

## collect

BODY-COLLECT-MARKER: read the account and write the dataset.
`);
  fs.writeFileSync(path.join(dir, "workflows", "extract-only.yaml"), `name: extract-only
steps:
  - id: extract
    agent: analyst
    task: collect
`);
  return dir;
}

describe("promptPath — the workflow reference reads the same on every platform", () => {
  // The Windows runner failed both capability cases of this file: `path.relative`
  // answers `workflows\guided-analysis.md` there, and the prompt then showed a
  // reference no `invoke.ref` ever declared. Forcing a literal backslash proves
  // the normalization off Windows too, instead of trusting the runner to catch it.
  test("a Windows separator becomes the POSIX one; a POSIX path is untouched", () => {
    expect(promptPath("workflows\\guided-analysis.md")).toBe("workflows/guided-analysis.md");
    expect(promptPath("workflows/guided-analysis.md")).toBe("workflows/guided-analysis.md");
    expect(promptPath(["workflows", "extract-only.yaml"].join(path.sep))).toBe("workflows/extract-only.yaml");
    expect(promptPath(promptPath("a\\b/c"))).toBe("a/b/c");
  });

  test("the context carries the reference the capability declares, never a native path", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;
    expect(ctx.workflow!.file).toBe("workflows/guided-analysis.md");
    expect(ctx.workflow!.file).not.toContain("\\");
  });
});

describe("buildSquadPrompt — the event-contract block (event-contract cut)", () => {
  // Cut 1 (#157) measured the gap this closes: 286 rogue event types across
  // 964 occurrences, and zero correctly `x_`-prefixed sites in the library —
  // because nothing the dispatched agent reads told it the vocabulary exists.
  test("a prompt built for a squad with a resolved capability contains the contract", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "analise a conta", outDir: "/out/dir",
      mode: "squad-only", cloneInjection: { block: "", decision: "PADRÃO" },
      capabilityId: "analysis.report.produce", traceId: "01HZ-trace-x",
    });
    expect(p).toContain("## COMO REPORTAR EVENTOS");
    expect(p).toContain("nrv audit emit");
    expect(p).toContain("--squad=guided");
    expect(p).toContain("--trace=01HZ-trace-x");
    expect(p).toContain("prefixo `x_`");
    // No payload/secret guidance, stated explicitly rather than implied.
    expect(p).toContain("nunca o brief inteiro, um output completo ou um segredo");
    // Rides right after the capability block, before the agents/tasks sections.
    expect(p.indexOf("## SUA CAPABILITY")).toBeLessThan(p.indexOf("## COMO REPORTAR EVENTOS"));
    expect(p.indexOf("## COMO REPORTAR EVENTOS")).toBeLessThan(p.indexOf("## SEUS AGENTES"));
  });

  test("without a trace id, the example command falls back to a placeholder instead of dropping the block", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      mode: "squad-only", cloneInjection: { block: "", decision: "PADRÃO" },
      capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## COMO REPORTAR EVENTOS");
    expect(p).toContain("--trace=<trace_id>");
  });

  test("a squad with no resolved capability gets no contract block — the historical prompt is untouched", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir",
      mode: "squad-only", cloneInjection: { block: "", decision: "PADRÃO" },
    });
    expect(p).not.toContain("## COMO REPORTAR EVENTOS");
  });
});

describe("buildSquadPrompt — with a resolved capability", () => {
  test("the capability, its workflow and only the referenced components reach the prompt", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "analise a conta", outDir: "/out/dir",
      mode: "squad-only", cloneInjection: { block: "", decision: "PADRÃO" },
      capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## SUA CAPABILITY");
    expect(p).toContain("- **id**: `analysis.report.produce`");
    expect(p).toContain("- **descrição**: Produce the guided analysis report for one account.");
    expect(p).toContain("- **produces**: report.md, dataset.json");
    expect(p).toContain("- `ac-sources` (bloqueante, nota mínima 0.9) — Every claim cites a dated source.");
    expect(p).toContain("- `ac-length` — The report stays under twelve pages.");

    expect(p).toContain("## SEU WORKFLOW (`workflows/guided-analysis.md`)");
    expect(p).toContain("| 1 | `collect` | `analyst` | `collect` | — | dataset.json |");
    expect(p).toContain("| 2 | `write` | `writer` | — | `collect` | report.md |");
    // The prose body of a Markdown workflow travels with the graph.
    expect(p).toContain("BODY-COLLECT-MARKER");

    // Referenced components only, in step order — never the alphabetical top 3.
    expect(p).toContain("## SEUS AGENTES\n");
    expect(p).not.toContain("(top 3)");
    expect(p).toContain("ANALYST-MARKER");
    expect(p).toContain("WRITER-MARKER");
    expect(p).not.toContain("AARDVARK-MARKER");
    expect(p).toContain("COLLECT-MARKER");
    expect(p).not.toContain("AAA-MARKER");
    expect(p.indexOf("ANALYST-MARKER")).toBeLessThan(p.indexOf("WRITER-MARKER"));
  });

  test("a legacy YAML workflow normalizes through the same reader", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o", mode: "team-mandatory",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.dataset.extract",
    });
    expect(p).toContain("## SEU WORKFLOW (`workflows/extract-only.yaml`)");
    expect(p).toContain("| 1 | `extract` | `analyst` | `collect` | — | — |");
    expect(p).toContain("ANALYST-MARKER");
    expect(p).not.toContain("WRITER-MARKER");
    // The team framing is untouched by the capability sections.
    expect(p).toContain("Sua saída é input do synthesizer do business.");
  });

  test("a capability whose invoke.ref resolves to nothing keeps the top-3 blocks and says so", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.rmSync(path.join(squadDir, "workflows", "extract-only.yaml"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.dataset.extract",
    });
    expect(p).toContain("- **id**: `analysis.dataset.extract`");
    expect(p).toContain("não aponta para um workflow legível");
    expect(p).toContain("## SEUS AGENTES (top 3)");
    expect(p).toContain("AARDVARK-MARKER");
  });

  test("the components ceiling is a target, not a cut: every document ships in full", () => {
    const max = Number(LIMITS.squad_prompt_components_bytes_max);
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.writeFileSync(path.join(squadDir, "agents", "analyst.md"), "A".repeat(max + 4096));
    fs.writeFileSync(path.join(squadDir, "agents", "writer.md"), "WRITER-MARKER");
    // A task big enough that the TASKS half would also have been cut by the old
    // ceiling: asserting only the agents half let a task-side regression pass.
    fs.writeFileSync(path.join(squadDir, "tasks", "collect.md"), "C".repeat(20_000) + "COLLECT-TAIL");
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;
    expect(ctx.components).not.toBeNull();
    // Over the ceiling, on purpose: no document on EITHER side is cut or dropped.
    expect(Buffer.byteLength(ctx.components!.agents, "utf8")).toBeGreaterThan(max);
    expect(ctx.components!.agents).toContain("A".repeat(max + 4096));
    expect(ctx.components!.agents).toContain("WRITER-MARKER");
    expect(ctx.components!.tasks).toContain("C".repeat(20_000));
    expect(ctx.components!.tasks).toContain("COLLECT-TAIL");
    for (const section of [ctx.components!.agents, ctx.components!.tasks]) {
      expect(section).not.toContain("truncado no teto");
      expect(section).not.toContain("documento(s) omitido(s)");
    }
    // The crossing is flagged, not hidden — on the LAST section shown, so the
    // reader meets it after the content it measures, and exactly once across
    // the pair (a note emitted per section is the bug the sibling test pins).
    const both = `${ctx.components!.agents}\n${ctx.components!.tasks}`;
    expect(both.match(/acima do teto de/g)).toHaveLength(1);
    expect(ctx.components!.tasks).toContain(`acima do teto de ${max}`);
    // It answers for the ceiling only, so it never contradicts a missing-file note.
    expect(both).not.toContain("nada foi omitido");
  });

  // The regression this test exists for: the note used to be emitted from
  // inside the per-section renderer, which sees half the total. When the agents
  // section crossed the ceiling on its own, it reported ITS overage and silenced
  // the tasks section that would have counted the rest — understating by more
  // than 3x wherever the agents half was the large one.
  test("the overage counts BOTH sections, even when agents alone already crossed", () => {
    const max = Number(LIMITS.squad_prompt_components_bytes_max);
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.writeFileSync(path.join(squadDir, "agents", "analyst.md"), "A".repeat(max + 1_000));
    fs.writeFileSync(path.join(squadDir, "agents", "writer.md"), "W");
    fs.writeFileSync(path.join(squadDir, "tasks", "collect.md"), "C".repeat(50_000));
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;

    const real = Buffer.byteLength(ctx.components!.agents, "utf8")
      + Buffer.byteLength(ctx.components!.tasks, "utf8");
    const m = ctx.components!.tasks.match(/somam (\d+) bytes, (\d+) acima do teto de (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBe(max);
    // The reported total is the measured content; only the note's own bytes,
    // appended after the measurement, separate it from the rendered length.
    expect(Number(m![1])).toBeGreaterThan(max + 50_000);
    expect(real - Number(m![1])).toBeLessThan(256);
    expect(Number(m![2])).toBe(Number(m![1]) - max);
    // And the whole reason the note exists: nothing was lost to say it.
    expect(ctx.components!.agents).toContain("A".repeat(max + 1_000));
    expect(ctx.components!.tasks).toContain("C".repeat(50_000));
  });

  test("capabilityContext returns null on every path that must keep the historical prompt", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    expect(capabilityContext(squadDir, "squad.execute")).toBeNull();
    expect(capabilityContext(squadDir, "analysis.nothing.here")).toBeNull();
    expect(capabilityContext(path.join(tmp, "squads", "no-such-squad"), "analysis.report.produce")).toBeNull();
  });
});

// Everything a squad ships beyond agents/ and tasks/ used to be invisible to the
// agent running it: references/, checklists/, templates/, standards/, schemas/,
// config/, scripts/, data/, tools/ and lib/ are all common in real squads, and
// none of it was named in the prompt or reachable — the directory itself was
// never granted.
describe("buildSquadPrompt — the resource map", () => {
  /** Add authored directories to a scaffolded squad. */
  function withResources(squadDir: string): string {
    fs.mkdirSync(path.join(squadDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "checklists"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "references", "deep"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, "references", "state-of-the-art.md"), "x");
    fs.writeFileSync(path.join(squadDir, "references", ".hidden"), "x");
    fs.writeFileSync(path.join(squadDir, "checklists", "pre-flight.md"), "x");
    fs.writeFileSync(path.join(squadDir, "node_modules", "left-pad", "index.js"), "x");
    // Run state, which a squad materializes by being run in and which must never
    // be advertised as content.
    fs.mkdirSync(path.join(squadDir, ".runs", "demo"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, ".runs", "demo", "out.md"), "x");
    fs.mkdirSync(path.join(squadDir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, "outputs", "leftover.md"), "x");
    return squadDir;
  }

  // The exclusion list for run state has one owner, `isRunStatePath`. A private
  // second copy here is how a path that must never travel starts travelling.
  test("run state is never advertised, and the list that decides is the shared one", () => {
    const squadDir = withResources(scaffoldCapabilitySquad(path.join(tmp, "squads")));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.report.produce",
    });
    const map = p.slice(p.indexOf("## O QUE MAIS ESTE SQUAD CARREGA"));
    expect(map).not.toContain(".runs");
    expect(map).not.toContain("outputs/");
    expect(map).not.toContain("leftover.md");
    // Authored content beside it is untouched.
    expect(map).toContain("`references/`");
  });

  test("names every authored directory, one level deep, and never node_modules", () => {
    const squadDir = withResources(scaffoldCapabilitySquad(path.join(tmp, "squads")));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## O QUE MAIS ESTE SQUAD CARREGA");
    expect(p).toContain("`references/` — `deep/`, `state-of-the-art.md`");
    expect(p).toContain("`checklists/` — `pre-flight.md`");
    // A subdirectory is named with a trailing slash so the agent knows to descend.
    expect(p).toContain("`deep/`");
    // Dependency output would bury the map it is listed in.
    expect(p).not.toContain("node_modules");
    // Dotfiles are not authored content.
    expect(p).not.toContain(".hidden");
    // The three the prompt already carries are never repeated as a path.
    expect(p).not.toContain("`agents/` —");
    expect(p).not.toContain("`tasks/` —");
    expect(p).not.toContain("`workflows/` —");
  });

  // The gate the map deliberately does NOT ride: a legacy squad's prompt carries
  // an arbitrary alphabetical top-3 of its agents and tasks, so it is the one
  // with most of itself missing.
  test("a squad with no resolved capability gets the map too", () => {
    const squadDir = withResources(scaffoldSquad(path.join(tmp, "squads"), "legacy"));
    const p = buildSquadPrompt({
      squadSlug: "legacy", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" },
    });
    expect(p).toContain("## SEUS AGENTES (top 3)");
    expect(p).toContain("## O QUE MAIS ESTE SQUAD CARREGA");
    expect(p).toContain("`references/`");
  });

  // What keeps the byte-identical pin honest rather than merely passing: a squad
  // that ships nothing outside the three inlined directories gets no section.
  test("a squad that ships nothing extra gets no section at all", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"), "bare");
    const p = buildSquadPrompt({
      squadSlug: "bare", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.report.produce",
    });
    expect(p).not.toContain("O QUE MAIS ESTE SQUAD CARREGA");
  });

  // The cap the map DOES have, and why it is not the mistake this file just
  // undid: a directory index is recoverable with one `ls`, so capping it costs
  // nothing, while an uncapped one would push a `data/` of fifty thousand files
  // into every prompt the squad ever runs.
  test("a huge directory is capped, and the overflow says how to see the rest", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "bulky");
    fs.mkdirSync(path.join(squadDir, "data"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(squadDir, "data", `row-${String(i).padStart(4, "0")}.csv`), "x");
    }
    const p = buildSquadPrompt({
      squadSlug: "bulky", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" },
    });
    const map = p.slice(p.indexOf("## O QUE MAIS ESTE SQUAD CARREGA"));
    expect(map).toContain("`row-0000.csv`");
    expect(map).toContain("e mais 350");
    expect(map).toContain("`ls`");
    // Bounded: the index cannot grow without limit with the directory.
    expect(Buffer.byteLength(map, "utf8")).toBeLessThan(4_096);
    // And it never claims the listing is the content.
    expect(map).toContain("o arquivo em disco é o conteúdo");
  });

  // An empty directory is a directory with nothing to open.
  test("an empty authored directory is not advertised", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"), "hollow");
    fs.mkdirSync(path.join(squadDir, "references"), { recursive: true });
    const p = buildSquadPrompt({
      squadSlug: "hollow", squadDir, brief: "b", outDir: "/o", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" }, capabilityId: "analysis.report.produce",
    });
    expect(p).not.toContain("O QUE MAIS ESTE SQUAD CARREGA");
  });
});

describe("runSquadHeadless", () => {
  test("dispatches through the cascade seam and emits dispatch_squad + agent_executed", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a brand",
      projectId: "proj-sq-1", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "DIRECTIVE-MARKER ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("sess-sq-1");
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain("MANIFEST-MARKER");
    expect(seen[0].appendSystemPrompt).toContain("DIRECTIVE-MARKER");
    const events = readAudit();
    const ds = events.find(e => e.event === "dispatch_squad");
    expect(ds).toBeTruthy();
    expect(ds.squad_slug).toBe("brandcraft");
    expect(ds.mode).toBe("squad-only");
    const ax = events.find(e => e.event === "agent_executed");
    expect(ax).toBeTruthy();
    expect(ax.mode).toBe("squad-only");
    expect(ax.employee).toBe("squad:brandcraft");
    // The size of what we just built, on the event where runs are inspected —
    // and the number that decides whether the run crossed the argv threshold.
    expect(ds.prompt_bytes).toBe(Buffer.byteLength(seen[0].prompt, "utf8"));
  });

  // The resource map names paths under the squad; on claude-code and agy an
  // ungranted path is refused, so without this the map would be a sign on a
  // locked door.
  test("the squad's own directory is granted, so the map it advertises can be opened", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a brand",
      projectId: "proj-sq-grant", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(seen[0].addDirs).toContain(squadDir);
    // Without displacing the two it already granted.
    expect(seen[0].addDirs).toContain(tmp);
    expect(seen[0].addDirs).toContain(path.join(tmp, "out"));
  });

  test("team-mandatory mode keeps the team audit contract (business_slug + squad-mandatory)", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-sq-2", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out2"), runtime: "claude-code",
      businessSlug: "parent-biz", mode: "team-mandatory",
      autonomousDirective: "D",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => okCascadeResult(opts)) as any,
    });
    const events = readAudit();
    const ds = events.find(e => e.event === "dispatch_squad");
    expect(ds.business_slug).toBe("parent-biz");
    expect(ds.mode).toBe("team-mandatory");
    const ax = events.find(e => e.event === "agent_executed");
    expect(ax.mode).toBe("squad-mandatory"); // pre-extraction field value, unchanged
    expect(ax.business_slug).toBe("parent-biz");
  });

  test("missing squad dir → ok:false + squad_run_failed, cascade never invoked", () => {
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "no-such-squad", brief: "b",
      projectId: "proj-sq-3", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out3"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "D",
      squadsRoot: path.join(tmp, "squads-empty"),
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("squad dir not found");
    expect(seen).toHaveLength(0);
    expect(readAudit().some(e => e.event === "squad_run_failed")).toBe(true);
  });

  test("session reuse: prior session is resumed; a failed resume retries ONCE cold", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const key = sessionKey("claude-code", "squad", "brandcraft");
    putSession(tmp, key, "claude-code", "stale-session-id");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-sq-4", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out4"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "D",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => {
        seen.push(opts);
        if (opts.sessionId === "stale-session-id") {
          return { ...okCascadeResult(opts, null), ok: false, exitCode: 1, error: "resume failed" };
        }
        return okCascadeResult(opts, "fresh-session");
      }) as any,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].sessionId).toBe("stale-session-id");
    expect(seen[1].sessionId).toBeUndefined(); // cold retry
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fresh-session");
    expect(readAudit().some(e => e.event === "session_resume_failed")).toBe(true);
  });
});

// A squad slug reaches runSquadHeadless unvalidated: the explicit-target layer
// of the dispatch cascade returns what the caller named with no registry lookup,
// and the target pattern admits dots and separators. `--squad=..` resolved to the
// parent of the squads root — the user's home on a default install — and both the
// resource map and the addDirs grant then treated it as the squad.
describe("runSquadHeadless — the slug cannot leave the squads root", () => {
  test("a traversing slug is refused before anything reads or grants it", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    // A sibling of the squads root, standing in for the user's home.
    fs.mkdirSync(path.join(tmp, "private"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "private", "id_rsa"), "SECRET-MARKER");

    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: path.join("..", "private"), brief: "b",
      projectId: "proj-esc", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only", autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("escapes the squads root");
    // Never dispatched: nothing was granted and no prompt was built from it.
    expect(seen).toHaveLength(0);
    const failed = readAudit().find(e => e.event === "squad_run_failed");
    expect(failed?.reason).toBe("squad slug escapes the squads root");
  });

  test("an ordinary slug still resolves", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-ok", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only", autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
