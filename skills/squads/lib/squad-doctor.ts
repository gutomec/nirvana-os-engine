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
    problem, why: "fidelity.status: validated without proof is fabricated fidelity — the harness would route trusting a number nobody measured", fix,
    autofixable: true,
  });
  for (const cap of caps) {
    const fid = cap?.fidelity;
    if (!fid || fid.status !== "validated") continue;
    const id = cap.id || "(capability with no id)";
    const threshold = typeof fid.threshold === "number" ? fid.threshold : 0.85;
    const rel = fid.eval_results;
    if (!rel) {
      out.push(mk(id, "declares fidelity.status: validated but points at no eval_results", `generate an eval-results.json (cases + pass_rate) and point fidelity.eval_results at it, or downgrade to 'experimental'. The auto-fix downgrades to experimental.`));
      continue;
    }
    const evalPath = path.isAbsolute(rel) ? rel : path.join(squadDir, rel);
    if (!fs.existsSync(evalPath)) {
      out.push(mk(id, `fidelity.eval_results points at '${rel}', which is not on disk`, `create ${rel} with the evaluation cases (pass_rate>=${threshold}), or downgrade to experimental.`));
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(evalPath, "utf8"));
      let rate: number | null = typeof data.pass_rate === "number" ? data.pass_rate : null;
      if (rate === null && Array.isArray(data.cases) && data.cases.length) {
        rate = data.cases.filter((c: any) => c.passed).length / data.cases.length;
      }
      if (rate === null) {
        out.push(mk(id, `eval_results exists but carries neither 'pass_rate' nor 'cases[]' to recompute from`, `add pass_rate (0..1) or cases:[{id,passed}] to ${rel}.`));
      } else if (rate < threshold) {
        out.push(mk(id, `measured pass_rate ${rate.toFixed(2)} < threshold ${threshold}`, `improve the squad until pass_rate>=${threshold}, or downgrade to experimental.`));
      }
    } catch (e: any) {
      out.push(mk(id, `eval_results is not valid JSON: ${e.message}`, `fix the JSON in ${rel}.`));
    }
  }
  return out;
}

// ── item 5: non-portable leaks (Claude-specific terms) ────────────────────────
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /(^|[^\w/])CLAUDE\.md\b/, label: "reference to CLAUDE.md (a Claude Code-specific instruction file)" },
  { re: /~\/\.claude\b/, label: "the ~/.claude path (Claude Code-specific)" },
  { re: /\$\{?CLAUDE_PLUGIN_ROOT\}?/, label: "the CLAUDE_PLUGIN_ROOT variable" },
  { re: /\bclaude-(opus|sonnet|haiku|fable)[\w.-]*/i, label: "a pinned Claude model id" },
];
export function checkPortability(squadDir: string): Finding[] {
  const out: Finding[] = [];
  for (const sub of ["agents", "workflows", "tasks"]) {
    const dir = path.join(squadDir, sub);
    if (!fs.existsSync(dir)) continue;
    let names: string[] = [];
    // Workflows live in .yaml/.yml (v5) or .md (v6); agents and tasks in .md.
    // Filtering every dir on .md made the workflow scan a no-op.
    const isDoc = sub === "workflows" ? (n: string) => /\.(md|ya?ml)$/i.test(n) : (n: string) => n.endsWith(".md");
    try { names = fs.readdirSync(dir).filter(isDoc); } catch { continue; }
    for (const f of names) {
      let txt = "";
      try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
      if (/<!--\s*portability-ok\s*-->/i.test(txt)) continue; // explicit waiver
      for (const { re, label } of FORBIDDEN) {
        const m = txt.match(re);
        if (m) out.push({
          severity: "warn", code: "portability-leak", where: `${sub}/${f}`,
          problem: `non-portable leak: ${label} ("${m[0].trim()}")`,
          why: "a squad is meant to run on several runtimes (Codex, Gemini, Cursor…); a Claude-specific term breaks the conversion",
          fix: `replace it with a neutral term or use the target adapter's semantic_map; if it is deliberate, add '<!-- portability-ok -->' to the file`,
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

/**
 * Where a squad's diagnostic goes — and it is not into the squad.
 *
 * This used to write `SQUAD-DOCTOR-REPORT.md` into `squadDir` itself, which put
 * a machine-generated diagnostic inside the content tree. Two consequences, both
 * seen in the wild: seven squads carried one into the packs, so buyers received
 * a report about the seller's own machine; and because the file is stamped with
 * a fresh timestamp on every run, any two copies of a squad validated at
 * different moments differ forever — a slug that can never be reconciled.
 *
 * The squad directory is product. A diagnostic about the product belongs beside
 * the other per-squad state.
 */
function reportPathFor(squadDir: string): string {
  const slug = path.basename(squadDir);
  const { SQUADS_STATE_DIR } = require("../../_shared/lib/paths.js").resolvePaths();
  return path.join(SQUADS_STATE_DIR, slug, "SQUAD-DOCTOR-REPORT.md");
}

export function writeDoctorReport(squadDir: string, findings: Finding[], stampISO: string): string {
  const slug = path.basename(squadDir);
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  const autofix = findings.filter((f) => f.autofixable);
  const lines: string[] = [];
  lines.push(`# Squad doctor — \`${slug}\``);
  lines.push("");
  lines.push(`Generated: ${stampISO}`);
  lines.push(`Findings: ${findings.length} (${errors.length} error(s), ${warns.length} warning(s); ${autofix.length} auto-fixable)`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("No fidelity or portability problems found.");
  } else {
    lines.push("## How to fix");
    lines.push("");
    lines.push(`- Safe auto-fix (downgrades unproven fidelity and similar): \`nrv fix-squad ${slug} --apply\``);
    lines.push("- Anything not auto-fixable carries its manual fix in the block below.");
    lines.push("");
    lines.push("## Findings");
    findings.forEach((f, i) => {
      lines.push("");
      lines.push(`### ${i + 1}. [${f.severity}] ${f.code} — \`${f.where}\``);
      lines.push(`- **Problem:** ${f.problem}`);
      lines.push(`- **Why it matters:** ${f.why}`);
      lines.push(`- **How to fix:** ${f.fix}`);
      lines.push(`- **Auto-fixable:** ${f.autofixable ? "yes (`nrv fix-squad --apply`)" : "no — manual fix"}`);
    });
  }
  lines.push("");
  const out = reportPathFor(squadDir);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n"), "utf8");

  // A report left behind by the old location keeps shipping and keeps causing
  // drift, so retire it the first time this squad is diagnosed again.
  const legacy = path.join(squadDir, "SQUAD-DOCTOR-REPORT.md");
  try { if (fs.existsSync(legacy)) fs.rmSync(legacy); } catch { /* read-only tree: the gate still catches it */ }

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
