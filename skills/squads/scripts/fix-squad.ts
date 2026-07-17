#!/usr/bin/env bun
// fix-squad.ts — `nrv fix-squad <slug|path> [--apply]`
//
// Auto-diagnóstico + auto-correção de squads. Sem --apply: escreve
// SQUAD-DOCTOR-REPORT.md (problema + por quê + como corrigir) e imprime o resumo.
// Com --apply: aplica os auto-fixes seguros (ex.: rebaixa fidelity validated não
// comprovada para experimental) e re-gera o relatório.

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { collectFindings, writeDoctorReport, applyAutofixes } from "../lib/squad-doctor.ts";

const { positional, flags } = parseArgs();
if (!positional[0] || flags.h || flags.help) {
  console.error("uso: nrv fix-squad <slug|path> [--apply]");
  process.exit(positional[0] ? EXIT.OK : EXIT.INVALID_ARGS);
}

let squadPath = positional[0];
if (!fs.existsSync(squadPath)) {
  const cand = path.join(paths.SQUADS_DIR, squadPath);
  if (fs.existsSync(cand)) squadPath = cand;
}
squadPath = path.resolve(squadPath);
if (!fs.existsSync(squadPath) || !fs.statSync(squadPath).isDirectory()) {
  console.error(`[FAIL] squad não encontrado: ${squadPath}`);
  process.exit(EXIT.FAILURES);
}

const slug = path.basename(squadPath);
const apply = !!flags.apply;

const findings = collectFindings(squadPath);
const report = writeDoctorReport(squadPath, findings, new Date().toISOString());
const nErr = findings.filter((f) => f.severity === "error").length;
const nWarn = findings.filter((f) => f.severity === "warn").length;

console.log(`Squad:     ${slug}`);
console.log(`Problemas: ${findings.length} (${nErr} erro, ${nWarn} aviso)`);
console.log(`Relatório: ${report}`);

if (!apply) {
  if (findings.length) console.log(`\nAplicar auto-fixes seguros: nrv fix-squad ${slug} --apply`);
  process.exit(EXIT.OK);
}

const { applied, manual } = applyAutofixes(squadPath);
console.log("");
if (applied.length) {
  console.log("✓ Auto-fixes aplicados:");
  applied.forEach((a) => console.log(`  - ${a}`));
} else {
  console.log("Nenhum auto-fix seguro aplicável (tudo é correção manual).");
}
if (manual.length) {
  console.log("\n⚠ Correção manual (detalhada no relatório):");
  manual.forEach((m) => console.log(`  - ${m}`));
}
// Re-gera o relatório refletindo o estado pós-fix.
writeDoctorReport(squadPath, collectFindings(squadPath), new Date().toISOString());
process.exit(EXIT.OK);
