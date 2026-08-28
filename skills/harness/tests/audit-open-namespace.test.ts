// audit-open-namespace.test.ts — the open x_ namespace for audit events.
//
// SKILL.md prescribes events (e.g. `research_completed`, `briefing_completed`)
// that are absent from lib/audit.js ALLOWED_EVENTS; the old throw made every
// such emit crash the caller, so prescribed events were silently never
// recorded. Phase 0.2: unknown names emit as `x_<name>` with one rate-limited
// stderr warning per process per name; names already starting with `x_` pass
// through; NIRVANA_AUDIT_STRICT=1 restores the throw.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const audit = require("../lib/audit.js");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-audit-ns-"));
  process.env.HARNESS_LOGS_DIR = tmp;
});
afterEach(() => {
  delete process.env.HARNESS_LOGS_DIR;
  delete process.env.NIRVANA_AUDIT_STRICT;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function todayLines(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => parseAuditLine(l));
}

describe("audit.emit — open x_ namespace", () => {
  test("research_completed (SKILL.md-prescribed, absent from the enum) emits as x_research_completed", () => {
    expect(audit.ALLOWED_EVENTS.has("research_completed")).toBe(false); // precondition
    const r = audit.emit("research_completed", { trace_id: "t-ns-1", choices: [] });
    expect(r.event.event).toBe("x_research_completed");
    const line = todayLines().find((l) => l.trace_id === "t-ns-1");
    expect(line?.event).toBe("x_research_completed");
  });

  test("names already starting with x_ are accepted as-is", () => {
    const r = audit.emit("x_gate_skipped_no_files", { trace_id: "t-ns-2", files: 0 });
    expect(r.event.event).toBe("x_gate_skipped_no_files");
  });

  test("warning is rate-limited to once per process per name", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...args: any[]) => { seen.push(args.join(" ")); };
    try {
      audit.emit("some_novel_event", {});
      audit.emit("some_novel_event", {});
    } finally {
      console.error = orig;
    }
    const warnings = seen.filter((s) => s.includes("some_novel_event"));
    expect(warnings.length).toBe(1);
  });

  test("NIRVANA_AUDIT_STRICT=1 still throws on unknown events", () => {
    process.env.NIRVANA_AUDIT_STRICT = "1";
    expect(() => audit.emit("research_completed", {})).toThrow(/unknown event type/);
  });
});
