// audit-emit.test.ts — the audit event contract (lib/audit.js).
// The AGENTS.md §8 rule: a run without a receipt is a bug. These guard the
// event schema the whole learning loop and `nrv doctor` depend on.
// Runs with: bun test skills/harness/tests
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const audit = require("../lib/audit.js");

let tmp: string;
// Restore, never delete: HARNESS_LOGS_DIR may belong to another test file that
// is mid-flight. Deleting it drops that file back to the REAL ~/.harness-logs,
// where its events are not, which fails it intermittently and only in a full
// run — the flake this replaced.
let savedLogsDir: string | undefined;
beforeEach(() => {
  savedLogsDir = process.env.HARNESS_LOGS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-audit-"));
  process.env.HARNESS_LOGS_DIR = tmp;
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function todayLines(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("audit.emit — event contract", () => {
  test("rejects an event type outside ALLOWED_EVENTS (strict mode)", () => {
    // Phase 0.2 opened the namespace: unknown events now emit as x_<name> by
    // default. NIRVANA_AUDIT_STRICT=1 restores the throw, preserving this
    // test's original schema-discipline intent.
    process.env.NIRVANA_AUDIT_STRICT = "1";
    try {
      expect(() => audit.emit("not_a_real_event", {})).toThrow(/unknown event type/);
    } finally {
      delete process.env.NIRVANA_AUDIT_STRICT;
    }
  });

  test("accepts the canonical dispatch events with normalized entity fields", () => {
    audit.emit("dispatch_squad", { squad_name: "omnidoc-vision-nirvana", trace_id: "t1" });
    audit.emit("dispatch_business", { business_slug: "strategic-council", trace_id: "t1" });
    const lines = todayLines();
    const bySquad = lines.find((l) => l.event === "dispatch_squad");
    const byBiz = lines.find((l) => l.event === "dispatch_business");
    expect(bySquad?.squad_name).toBe("omnidoc-vision-nirvana");
    expect(byBiz?.business_slug).toBe("strategic-council");
  });

  test("every written line has ts + event (the fields readers rely on)", () => {
    audit.emit("gate_passed", { squad_name: "x", trace_id: "t2", score: 0.9 });
    const [line] = todayLines();
    expect(typeof line.ts).toBe("string");
    expect(line.event).toBe("gate_passed");
    expect(line.trace_id).toBe("t2");
  });

  test("dispatch_squad and brief_received are in the allowed set (brief-squad emits them)", () => {
    expect(audit.ALLOWED_EVENTS.has("dispatch_squad")).toBe(true);
    expect(audit.ALLOWED_EVENTS.has("brief_received")).toBe(true);
    expect(audit.ALLOWED_EVENTS.has("gate_passed")).toBe(true);
    expect(audit.ALLOWED_EVENTS.has("gate_failed")).toBe(true);
  });

  test("writes action execution lifecycle events without extension remapping", () => {
    process.env.NIRVANA_AUDIT_STRICT = "1";
    try {
      audit.emit("execution_selected", {
        mode: "action",
        action_id: "accounting.close-month",
        action_version: "1.0.0",
      });
      audit.emit("execution_fallback", {
        mode: "auto",
        fallback: "workflow",
        reason: "action_unavailable",
      });
    } finally {
      delete process.env.NIRVANA_AUDIT_STRICT;
    }

    expect(todayLines().map(({ event, mode }) => ({ event, mode }))).toEqual([
      { event: "execution_selected", mode: "action" },
      { event: "execution_fallback", mode: "auto" },
    ]);
  });
});
