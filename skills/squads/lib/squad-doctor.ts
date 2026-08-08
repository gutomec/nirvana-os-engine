// squad-doctor.ts — diagnoses a squad's problems and teaches/applies the fix.
//
// When a check "fails silently" (e.g.: a capability declares
// fidelity.status: validated without proven eval-results, or a file leaks a
// Claude-specific term), the doctor does not vanish the problem: it becomes a
// structured finding, enters a SQUAD-DOCTOR-REPORT.md report (problem + why +
// how to fix) and, when safe, is auto-fixable via applyAutofixes.
//
// Severities: "error" (blocks/breaks) vs "warn" (does not break the catalog,
// but needs attention — the fidelity/portability case). validate-squad uses
// this to generate the report without failing squads en masse.

import * as fs from "node:fs";
import * as path from "node:path";

const YAML = require("yaml");

export type Finding = {
  severity: "error" | "warn";
  code: string;       // "fidelity-unverified" | "portability-leak" | "schema" | ...
  where: string;      // capability id or file path
  problem: string;
  why: string;
  fix: string;
  autofixable: boolean;
};

// ── item 4: fidelity declared as validated but not proven ─────────────────────
export function checkFidelity(squadDir: string, manifest: any): Finding[] {
  const out: Finding[] = [];
  const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  const mk = (id: string, problem: string, fix: string): Finding => ({
    severity: "warn", code: "fidelity-unverified", where: id,
    problem, why: "fidelity.status: validated sem prova é fidelidade fabricada — o harness rotearia confiando num número que ninguém mediu", fix,
    autofixable: true,
  });
  for (const cap of caps) {
    const fid = cap?.fidelity;
    if (!fid || fid.status !== "validated") continue;
    const id = cap.id || "(capability sem id)";
    const threshold = typeof fid.threshold === "number" ? fid.threshold : 0.85;
    const rel = fid.eval_results;
    if (!rel) {
      out.push(mk(id, "declara fidelity.status: validated mas não aponta eval_results", `gere um eval-results.json (casos + pass_rate) e aponte fidelity.eval_results para ele, ou rebaixe para 'experimental'. Auto-fix rebaixa para experimental.`));
      continue;
    }
    const evalPath = path.isAbsolute(rel) ? rel : path.join(squadDir, rel);
    if (!fs.existsSync(evalPath)) {
      out.push(mk(id, `fidelity.eval_results aponta para '${rel}', que não existe no disco`, `crie ${rel} com os casos de avaliação (pass_rate>=${threshold}), ou rebaixe para experimental.`));
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(evalPath, "utf8"));
      let rate: number | null = typeof data.pass_rate === "number" ? data.pass_rate : null;
      if (rate === null && Array.isArray(data.cases) && data.cases.length) {
        rate = data.cases.filter((c: any) => c.passed).length / data.cases.length;
      }
      if (rate === null) {
        out.push(mk(id, `eval_results existe mas não tem 'pass_rate' nem 'cases[]' para recomputar`, `adicione pass_rate (0..1) ou cases:[{id,passed}] a ${rel}.`));
      } else if (rate < threshold) {
        out.push(mk(id, `pass_rate medido ${rate.toFixed(2)} < threshold ${threshold}`, `melhore o squad até pass_rate>=${threshold}, ou rebaixe para experimental.`));
      }
    } catch (e: any) {
      out.push(mk(id, `eval_results não é JSON válido: ${e.message}`, `conserte o JSON de ${rel}.`));
    }
  }
  return out;
}

// ── item 5: non-portable leaks (Claude-specific terms) ────────────────────────
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /(^|[^\w/])CLAUDE\.md\b/, label: "referência a CLAUDE.md (instrução específica do Claude Code)" },
  { re: /~\/\.claude\b/, label: "caminho ~/.claude (específico do Claude Code)" },
  { re: /\$\{?CLAUDE_PLUGIN_ROOT\}?/, label: "variável CLAUDE_PLUGIN_ROOT" },
  { re: /\bclaude-(opus|sonnet|haiku|fable)[\w.-]*/i, label: "id de modelo Claude pinado" },
];
export function checkPortability(squadDir: string): Finding[] {
  const out: Finding[] = [];
  for (const sub of ["agents", "workflows", "tasks"]) {
    const dir = path.join(squadDir, sub);
    if (!fs.existsSync(dir)) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")); } catch { continue; }
    for (const f of names) {
      let txt = "";
      try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
      if (/<!--\s*portability-ok\s*-->/i.test(txt)) continue; // explicit waiver
      for (const { re, label } of FORBIDDEN) {
        const m = txt.match(re);
        if (m) out.push({
          severity: "warn", code: "portability-leak", where: `${sub}/${f}`,
          problem: `vazamento não-portável: ${label} ("${m[0].trim()}")`,
          why: "o squad é projetado para vários runtimes (Codex/Gemini/Cursor...); um termo Claude-specific quebra a conversão",
          fix: `troque por um termo neutro ou use o semantic_map do adapter alvo; se for intencional, adicione '<!-- portability-ok -->' ao arquivo`,
          autofixable: false,
        });
      }
    }
  }
  return out;
}

function loadManifest(squadDir: string): any {
  try { return YAML.parse(fs.readFileSync(path.join(squadDir, "squad.yaml"), "utf8")) || {}; }
  catch { return {}; }
}

export function collectFindings(squadDir: string): Finding[] {
  const manifest = loadManifest(squadDir);
  return [...checkFidelity(squadDir, manifest), ...checkPortability(squadDir)];
}

export function writeDoctorReport(squadDir: string, findings: Finding[], stampISO: string): string {
  const slug = path.basename(squadDir);
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  const autofix = findings.filter((f) => f.autofixable);
  const lines: string[] = [];
  lines.push(`# Squad doctor — diagnóstico de \`${slug}\``);
  lines.push("");
  lines.push(`Gerado: ${stampISO}`);
  lines.push(`Problemas: ${findings.length} (${errors.length} erro(s), ${warns.length} aviso(s); ${autofix.length} auto-corrigível(eis))`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("Nenhum problema de fidelity/portabilidade encontrado. ✅");
  } else {
    lines.push("## Como corrigir");
    lines.push("");
    lines.push(`- Auto-fix seguro (rebaixa fidelity não comprovada etc.): \`nrv fix-squad ${slug} --apply\``);
    lines.push("- Itens não auto-corrigíveis têm a correção manual em cada bloco.");
    lines.push("");
    lines.push("## Problemas");
    findings.forEach((f, i) => {
      lines.push("");
      lines.push(`### ${i + 1}. [${f.severity}] ${f.code} — \`${f.where}\``);
      lines.push(`- **Problema:** ${f.problem}`);
      lines.push(`- **Por quê importa:** ${f.why}`);
      lines.push(`- **Como corrigir:** ${f.fix}`);
      lines.push(`- **Auto-corrigível:** ${f.autofixable ? "sim (`nrv fix-squad --apply`)" : "não — correção manual"}`);
    });
  }
  lines.push("");
  const out = path.join(squadDir, "SQUAD-DOCTOR-REPORT.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  return out;
}

// Applies only the safe fixes. Fidelity: downgrades 'validated' → 'experimental'
// via text substitution ONLY when every 'validated' is flagged (it does not
// touch a legitimate validated). Portability always stays manual.
export function applyAutofixes(squadDir: string): { applied: string[]; manual: string[] } {
  const applied: string[] = [];
  const manual: string[] = [];
  const mf = path.join(squadDir, "squad.yaml");
  let raw = "";
  try { raw = fs.readFileSync(mf, "utf8"); } catch { return { applied, manual: ["squad.yaml ilegível"] }; }
  const fid = checkFidelity(squadDir, loadManifest(squadDir));
  const validatedCount = (raw.match(/status:\s*validated/g) || []).length;
  if (fid.length > 0 && validatedCount > 0 && fid.length === validatedCount) {
    const fixed = raw.replace(/status:\s*validated/g, "status: experimental  # auto-rebaixado pelo squad-doctor: validated sem eval-results comprovado");
    fs.writeFileSync(mf, fixed, "utf8");
    applied.push(`fidelity: ${validatedCount} capability(ies) rebaixada(s) validated → experimental`);
  } else if (fid.length > 0) {
    manual.push(`fidelity: ${validatedCount} 'validated' no arquivo mas ${fid.length} flagado(s) — rebaixe manualmente só os flagados (o auto-fix não toca para não rebaixar um validated legítimo)`);
  }
  for (const f of checkPortability(squadDir)) manual.push(`${f.where}: ${f.problem} → ${f.fix}`);
  return { applied, manual };
}
