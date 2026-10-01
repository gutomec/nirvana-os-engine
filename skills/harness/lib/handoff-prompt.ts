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

/**
 * What the previous runtime already produced.
 *
 * This stopped at 60 entries and said nothing, under a prompt whose hard rules
 * tell the incoming runtime "do not duplicate files already delivered". Not redoing
 * finished work is the entire job of a handoff, and the list it was given could
 * be a fraction of what exists: a rotation mid-book, after 140 chapter files,
 * handed the next runtime 60 of them, no `capitulo-08.md` among the rest, and
 * an instruction to avoid duplicating what it could not see. `safeRead` in this
 * same file has always announced its own truncation; this one did not.
 *
 * The cap stays, because a directory index is recoverable — the handoff prompt
 * already tells the runtime where the project is — but it now states the count
 * it withheld and how to get the rest, so "not listed" can never read as
 * "not written".
 */
function listFiles(dir: string, max = 60): string {
  if (!fs.existsSync(dir)) return "(directory does not exist yet)";
  try {
    const out: string[] = [];
    let total = 0;
    const walk = (d: string, depth = 0) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        total++;
        if (out.length >= max) continue;
        try {
          const st = fs.statSync(full);
          out.push(`  ${path.relative(dir, full)}  (${st.size}B)`);
        } catch { /* skip */ }
      }
    };
    walk(dir);
    if (!out.length) return "(no files written yet)";
    const hidden = total - out.length;
    return hidden > 0
      ? `${out.join("\n")}\n  … and ${hidden} more file(s) NOT listed here (total ${total}). List the directory before writing: a file missing from this list may already exist.`
      : out.join("\n");
  } catch { return "(unable to list)"; }
}

export function buildHandoffPrompt(args: HandoffArgs): string {
  const handoffJsonPath = path.join(args.projectDir, "HANDOFF.json");
  const handoffContent = safeRead(handoffJsonPath, 8000);
  const filesList = listFiles(args.outputsRoot);
  const taskBlock = args.taskHint ? `\n## YOUR POSITION IN THE CHAIN\n${args.taskHint}\n` : "";
  const auditBlock = args.auditTailLines ? `\n## LATEST AUDIT EVENTS\n${args.auditTailLines}\n` : "";

  return `# AGENTIC HANDOFF: CONTINUE THE WORK

You are the **${args.toRuntime}** agent. You are **continuing** a dispatch that the **${args.fromRuntime}** agent started and had to stop because of:

> ${args.reason}

This is not a restart. This is not a brand-new session. It is a baton pass. Keep the voice, the tone and the decisions already made. **Do not start over, do not duplicate work, do not change the approach** without a clear reason.

---

## USER'S ORIGINAL BRIEF (do not change the understanding)

${args.brief}

---

## CURRENT STATE OF THE WORK (HANDOFF.json)

${handoffContent ? "```json\n" + handoffContent + "\n```" : "(HANDOFF.json not found: the previous agent may not have initialized the phase protocol)"}

---

## FILES ALREADY PRODUCED IN \`${args.outputsRoot}\`

${filesList}

${taskBlock}${auditBlock}

---

## YOUR TASK NOW

1. **Skim** the files listed above to understand where the previous agent stopped. You do not need to re-read everything: go through the names and open the 3-5 most relevant for the continuation.
2. **Identify exactly what is missing** to deliver what the original brief asks for.
3. **Continue where it stopped.** If the previous agent was in the middle of generating a file, complete it. If it had just finished one and was about to start the next, do the next.
4. **Keep full continuity**: same voice, same design/copy/structure decisions, same output paths. Deliverables follow the language of the request.
5. **Finish.** When the brief's work is done, end normally. The harness takes over from there (gate, verification, etc).

## HARD HANDOFF RULES

- ❌ Do not ask the user "where should I start?": you have the whole brief above.
- ❌ Do not start a new approach just because you are a different model. Use the decisions already materialized on disk.
- ❌ Do not duplicate files already delivered.
- ✅ You may (and should) read the partial files and improve or complete what was left incomplete.
- ✅ You may note in HANDOFF.json (the \`decisions[]\` field or similar) that a handoff from ${args.fromRuntime} → ${args.toRuntime} happened, for audit.

Begin.`;
}
