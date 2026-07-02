// handoff-prompt.ts — builds the re-injection prompt when the cascade rotates
// from one agentic runtime to another mid-task. The new runtime is NOT
// resuming the old runtime's session (impossible — different vendor, different
// conversation history); it's receiving a hand-off briefing that explains
// (a) what the work is, (b) what's already done, (c) what's left, (d) the
// voice / style decisions to honor so the deliverable stays consistent.
//
// State sources (any may be missing — best-effort):
//   - HANDOFF.json in the project dir (phase, decisions, next_task)
//   - the original brief (passed in)
//   - file listing of outputs_root (what's on disk already)
//   - tail of the audit log (last N events for the project)

import * as fs from "node:fs";
import * as path from "node:path";
import type { Runtime } from "./host-agent-driver.ts";

export interface HandoffArgs {
  fromRuntime: Runtime;
  toRuntime: Runtime;
  reason: string;          // human-readable: "Claude Code 5-hour window reached"
  brief: string;           // the original brief
  projectDir: string;      // where HANDOFF.json + working files live
  outputsRoot: string;     // where the final deliverable goes
  taskHint?: string;       // e.g. "step 4/5 (ds-landing-designer)"
  auditTailLines?: string; // last N events (caller can pre-format)
}

function safeRead(p: string, max = 16000): string {
  try {
    const s = fs.readFileSync(p, "utf8");
    return s.length > max ? s.slice(0, max) + `\n... [truncated, file is ${s.length} chars]` : s;
  } catch { return ""; }
}

function listFiles(dir: string, max = 60): string {
  if (!fs.existsSync(dir)) return "(directory does not exist yet)";
  try {
    const out: string[] = [];
    const walk = (d: string, depth = 0) => {
      if (depth > 3 || out.length >= max) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= max) return;
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        try {
          const st = fs.statSync(full);
          out.push(`  ${path.relative(dir, full)}  (${st.size}B)`);
        } catch { /* skip */ }
      }
    };
    walk(dir);
    return out.length ? out.join("\n") : "(no files written yet)";
  } catch { return "(unable to list)"; }
}

export function buildHandoffPrompt(args: HandoffArgs): string {
  const handoffJsonPath = path.join(args.projectDir, "HANDOFF.json");
  const handoffContent = safeRead(handoffJsonPath, 8000);
  const filesList = listFiles(args.outputsRoot);
  const taskBlock = args.taskHint ? `\n## SUA POSIÇÃO NA CADEIA\n${args.taskHint}\n` : "";
  const auditBlock = args.auditTailLines ? `\n## ÚLTIMOS EVENTOS DA AUDITORIA\n${args.auditTailLines}\n` : "";

  return `# HANDOFF AGÊNTICO — CONTINUE O TRABALHO

Você é o agente **${args.toRuntime}**. Você está **continuando** um dispatch que o agente **${args.fromRuntime}** começou e teve que parar por:

> ${args.reason}

Não é um restart. Não é uma sessão nova do zero. É uma passagem de bastão. Mantenha voz, tom, e decisões já tomadas. **Não recomece, não duplique trabalho, não mude a abordagem** sem motivo claro.

---

## BRIEF ORIGINAL DO USUÁRIO (não mude o entendimento)

${args.brief}

---

## ESTADO ATUAL DO TRABALHO (HANDOFF.json)

${handoffContent ? "```json\n" + handoffContent + "\n```" : "(HANDOFF.json não encontrado — o agente anterior pode não ter inicializado o protocolo de fase)"}

---

## ARQUIVOS JÁ PRODUZIDOS EM \`${args.outputsRoot}\`

${filesList}

${taskBlock}${auditBlock}

---

## SUA TAREFA AGORA

1. **Leia rapidamente** os arquivos listados acima para entender onde o agente anterior parou. Não precisa re-ler tudo — passe por nomes e abra os 3-5 mais relevantes para a continuação.
2. **Identifique exatamente o que falta** para entregar o que o brief original pede.
3. **Continue de onde parou.** Se o agente anterior estava no meio de gerar um arquivo, complete-o. Se acabou de gerar e ia partir para o próximo, faça o próximo.
4. **Mantenha continuidade total**: mesma voz, mesmas decisões de design/copy/estrutura, mesmos paths de saída.
5. **Termine.** Quando o trabalho do brief estiver concluído, encerre normalmente — o harness vai pegar daqui (gate, verificação, etc).

## REGRAS DURAS DO HANDOFF

- ❌ Não pergunte ao usuário "por onde devo começar?" — você tem o brief inteiro acima.
- ❌ Não inicie uma nova abordagem só porque você é um modelo diferente. Use as decisões já materializadas no disco.
- ❌ Não duplique arquivos já entregues.
- ✅ Pode (e deve) ler os arquivos parciais e melhorar/completar o que ficou incompleto.
- ✅ Pode anotar no HANDOFF.json (campo \`decisions[]\` ou similar) que houve um handoff de ${args.fromRuntime} → ${args.toRuntime}, para auditoria.

Comece.`;
}
