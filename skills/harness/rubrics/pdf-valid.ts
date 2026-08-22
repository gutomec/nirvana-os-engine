// pdf-valid.ts — structural PDF gate (offline-safe, zero hard deps).
//
// PDF is one of the most common deliverable formats and the auto gate never
// covered it: a PDF-only delivery came out INDETERMINATE, and the first field
// run to notice (VPS, 2026-08-22) had to gate by hand with qpdf and emit
// x_quality_gate_tooling_gap. This rubric closes that gap at the structural
// level: header, EOF marker, stub floor, page count. Like html-valid, it is
// a smoke gate, not a visual judgment — whether the RENDERED pages match the
// brief remains the maestro's read or the LLM judge.
//
// Page counting prefers real tools when present (qpdf, then pdfinfo). With
// neither on PATH, the fallback counts /Type /Page objects — which reads 0 on
// object-stream-compressed PDFs (the exact trap the field run hit), so a
// compressed PDF with valid header/EOF passes structurally with the count
// declared unverified instead of failing on a broken heuristic.

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

function toolPages(artifact: string): number | null {
  for (const [bin, args, parse] of [
    ["qpdf", ["--show-npages", artifact], (o: string) => parseInt(o.trim(), 10)],
    ["pdfinfo", [artifact], (o: string) => {
      const m = o.match(/^Pages:\s+(\d+)/m);
      return m ? parseInt(m[1], 10) : NaN;
    }],
  ] as const) {
    try {
      const r = spawnSync(bin as string, args as string[], { encoding: "utf8", timeout: 20_000 });
      if (r.status === 0) {
        const n = parse(r.stdout || "");
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch { /* tool absent — try the next */ }
  }
  return null;
}

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const fix_list: string[] = [];
  let score = 1.0;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(args.artifact);
  } catch (e) {
    return { name: "pdf-valid", passed: false, score: 0, reasoning: `unreadable file: ${(e as Error).message}`, fix_list: ["Write the PDF file."] };
  }

  const head = bytes.subarray(0, 1024).toString("latin1");
  if (!head.startsWith("%PDF-")) {
    fix_list.push("Missing %PDF- header — the file is not a PDF.");
    score -= 0.6;
  }

  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    fix_list.push("Missing %%EOF trailer — the PDF is truncated or still being written.");
    score -= 0.4;
  }

  if (bytes.length < 5_000) {
    fix_list.push(`File is only ${bytes.length} bytes — looks like a stub, not a document.`);
    score -= 0.4;
  }

  let pages = toolPages(args.artifact);
  let pagesNote: string;
  if (pages !== null) {
    pagesNote = `pages=${pages} (tool-verified)`;
    if (pages < 1) {
      fix_list.push("PDF has zero pages.");
      score -= 0.5;
    }
  } else {
    const body = bytes.toString("latin1");
    const naive = (body.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const hasObjStm = body.includes("/ObjStm");
    if (naive >= 1) {
      pages = naive;
      pagesNote = `pages≈${naive} (heuristic)`;
    } else if (hasObjStm) {
      // Compressed object streams hide page objects from the regex — the
      // field-run trap. Structure is otherwise valid; declare, don't fail.
      pagesNote = "pages unverifiable offline (object streams; install qpdf or poppler for exact count)";
    } else {
      pagesNote = "no page objects found";
      fix_list.push("No page objects found and no object streams present — the PDF body looks empty.");
      score -= 0.5;
    }
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.65;
  return {
    name: "pdf-valid",
    passed,
    score,
    reasoning: passed
      ? `Structural PDF check passed (${(bytes.length / 1024).toFixed(0)} KB, ${pagesNote}).`
      : `Structural PDF check failed (${pagesNote}).`,
    fix_list,
  };
}
