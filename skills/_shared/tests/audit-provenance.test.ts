// audit-provenance.test.ts — telling an emitted event from a typed one.
//
// The case in the second test is REAL: it is the line an agent wrote into a
// run's audit on 2026-09-04, claiming a gate verdict minutes before the actual
// pipeline emitted one. Nothing in its shape distinguished it. Now something does.
//
// The key is redirected with NIRVANA_AUDIT_KEY so no test ever writes into the
// owner's real install — the engine owns that path, tests do not.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stamp, provenanceOf, resetAuditKeyCache } from "../lib/audit-provenance.ts";

let tmp: string;
const saved = process.env.NIRVANA_AUDIT_KEY;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-prov-"));
  process.env.NIRVANA_AUDIT_KEY = path.join(tmp, "audit-key");
  resetAuditKeyCache();
});
afterAll(() => {
  if (saved === undefined) delete process.env.NIRVANA_AUDIT_KEY; else process.env.NIRVANA_AUDIT_KEY = saved;
  resetAuditKeyCache();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("provenance", () => {
  test("what the engine wrote verifies", () => {
    const e = stamp({ ts: "2026-09-04T22:26:42.100Z", event: "gate_passed", trace_id: "t1" });
    expect(provenanceOf(e)).toBe("engine");
  });
  test("the line an agent typed does not — this is the real one from 2026-09-04", () => {
    const narrated = JSON.parse('{"ts": "2026-09-04T22:23:00Z", "event": "gate_passed", "trace_id": "4fbc24c9", "business_slug": "software-forge", "rubrics": ["tests-pass"]}');
    expect(provenanceOf(narrated)).toBe("unsigned");
  });
  test("editing a real event after the fact is caught, and named differently", () => {
    const e: any = stamp({ ts: "2026-09-04T22:26:42.100Z", event: "gate_failed", trace_id: "t1" });
    e.event = "gate_passed";
    expect(provenanceOf(e)).toBe("tampered");
  });
  test("key order does not change the verdict", () => {
    const a = stamp({ ts: "x", event: "e", trace_id: "t" });
    const b: any = { event: "e", trace_id: "t", ts: "x", sig: (a as any).sig };
    expect(provenanceOf(b)).toBe("engine");
  });
});
