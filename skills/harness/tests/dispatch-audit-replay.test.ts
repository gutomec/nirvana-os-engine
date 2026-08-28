// dispatch-audit-replay.test.ts — the split-root fix (Phase 4.3, dispatch side).
//
// dispatch.ts's old hand-rolled appendAudit had a split-root bug: events
// emitted before projDir was known (routing decisions, brief amplification)
// landed in the LAUNCH-CWD root, while post-scaffold events landed in the
// PROJECT root — one trace, two files, broken chain. createDispatchAudit
// buffers pre-projDir events and, once the project root is bound, REPLAYS
// them into the project root flagged `replayed_from_global: true` with the
// ORIGINAL ts, so validate-chain's ts|event dedup collapses the two copies
// into one event.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDispatchAudit } from "../scripts/dispatch.ts";

let tmpA: string;   // launch cwd (pre-projDir root)
let tmpB: string;   // project root
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
beforeEach(() => {
  // HARNESS_LOGS_DIR would force ONE root for everything and hide the very
  // bug this suite pins — unset it and use real .nirvana project markers.
  delete process.env.HARNESS_LOGS_DIR;
  tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-replay-a-"));
  tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-replay-b-"));
  fs.mkdirSync(path.join(tmpA, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(tmpB, ".nirvana"), { recursive: true });
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  for (const t of [tmpA, tmpB]) {
    try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function auditLines(root: string): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(root, ".nirvana", "logs", "harness", day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => parseAuditLine(l));
}

describe("createDispatchAudit — replay into the project root", () => {
  test("pre-projDir events land in the launch root AND are replayed (flagged, original ts) into the project root", () => {
    const audit = createDispatchAudit({ baseCwd: tmpA });
    audit.emit("auto_route_selected", { trace_id: "t-replay-1", project_id: "t-replay-1", business_slug: "biz" });
    audit.emit("brief_amplified", { trace_id: "t-replay-1", business_slug: "biz", assumptions: 2 });

    const projDir = path.join(tmpB, "outputs", "t-replay-1", "businesses", "biz");
    fs.mkdirSync(projDir, { recursive: true });
    audit.bindProjectRoot(projDir);
    audit.emit("dispatch_business", { trace_id: "t-replay-1", project_id: "t-replay-1", business_slug: "biz" });

    // Launch root: the two pre-bind events, unflagged; nothing post-bind.
    const a = auditLines(tmpA);
    expect(a.map(e => e.event)).toEqual(["auto_route_selected", "brief_amplified"]);
    expect(a.every(e => !e.replayed_from_global)).toBe(true);

    // Project root: ONE complete trace — replayed copies (flag + ORIGINAL ts)
    // followed by the post-bind event.
    const b = auditLines(tmpB);
    expect(b.map(e => e.event)).toEqual(["auto_route_selected", "brief_amplified", "dispatch_business"]);
    const replayed = b.filter(e => e.replayed_from_global === true);
    expect(replayed.map(e => e.event)).toEqual(["auto_route_selected", "brief_amplified"]);
    expect(replayed[0].ts).toBe(a[0].ts); // original ts preserved → dedup key matches
    expect(replayed[1].ts).toBe(a[1].ts);
    expect(b[2].replayed_from_global).toBeUndefined();
    expect(b.every(e => e.trace_id === "t-replay-1")).toBe(true);
  });

  test("same root on both sides → no replay, no duplicates", () => {
    const audit = createDispatchAudit({ baseCwd: tmpA });
    audit.emit("auto_route_selected", { trace_id: "t-replay-2", business_slug: "biz" });
    const projDir = path.join(tmpA, "outputs", "t-replay-2");
    fs.mkdirSync(projDir, { recursive: true });
    audit.bindProjectRoot(projDir); // resolves to the SAME project root (tmpA)
    audit.emit("dispatch_business", { trace_id: "t-replay-2", business_slug: "biz" });
    const a = auditLines(tmpA);
    expect(a.map(e => e.event)).toEqual(["auto_route_selected", "dispatch_business"]);
    expect(a.some(e => e.replayed_from_global)).toBe(false);
  });

  test("bindProjectRoot is idempotent — a second bind never re-replays", () => {
    const audit = createDispatchAudit({ baseCwd: tmpA });
    audit.emit("auto_route_selected", { trace_id: "t-replay-3", business_slug: "biz" });
    const projDir = path.join(tmpB, "p");
    fs.mkdirSync(projDir, { recursive: true });
    audit.bindProjectRoot(projDir);
    audit.bindProjectRoot(path.join(tmpA, "other"));
    const b = auditLines(tmpB).filter(e => e.replayed_from_global);
    expect(b).toHaveLength(1);
  });

  test("unknown event names still ride the open x_ namespace through the facade", () => {
    const audit = createDispatchAudit({ baseCwd: tmpA });
    audit.emit("x_delivery_withheld", { trace_id: "t-replay-4", files: 3 });
    const a = auditLines(tmpA);
    expect(a[0].event).toBe("x_delivery_withheld");
  });

  test("injected emitImpl seam receives cwd context switching from base to project", () => {
    const calls: Array<{ event: string; ctx: any; payload: any }> = [];
    const projDir = path.join(tmpB, "p");
    fs.mkdirSync(projDir, { recursive: true });
    const audit = createDispatchAudit({
      baseCwd: tmpA,
      emitImpl: (event, payload, ctx) => { calls.push({ event, ctx, payload }); return { event: { ts: "T0", event, ...payload } }; },
    });
    audit.emit("auto_route_selected", {});
    audit.bindProjectRoot(projDir);
    audit.emit("dispatch_business", {});
    expect(calls[0].ctx.cwd).toBe(tmpA);
    // replay of the buffered event (flag + captured ts), then the post-bind emit
    expect(calls[1].event).toBe("auto_route_selected");
    expect(calls[1].ctx.cwd).toBe(projDir);
    expect(calls[1].payload.replayed_from_global).toBe(true);
    expect(calls[1].payload.ts).toBe("T0");
    expect(calls[2].event).toBe("dispatch_business");
    expect(calls[2].ctx.cwd).toBe(projDir);
  });
});
