// agentic-router.test.ts — the agentic router rewrite (Phase 3.1).
//
// Zero-token: the headless LLM call is injected (runHeadlessImpl) with canned
// stdout, and parse+validate is exercised as a pure function. Covers the
// structured contract (kind decision/ambiguous/no_match), fenced-JSON
// extraction, unknown-slug filtering, the strict ok-vs-kind separation, and
// the digest staleness guard (fixture registries + the real builder script).
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  agenticRoute, parseAndValidate, extractJsonBlock, digestIsStale, ensureFreshDigest,
  type RegistrySlugs, type RouterPaths,
} from "../lib/agentic-router.ts";
import type { RunHeadlessOpts, RunHeadlessResult } from "../lib/host-agent-driver.ts";

const SLUGS: RegistrySlugs = {
  businesses: new Set(["acme-web", "acme-books"]),
  squads: new Set(["squad-a", "squad-b", "brandcraft"]),
  mindClones: new Set(["jane-doe", "john-roe", "alex-pro", "extra-clone"]),
};

// ── extractJsonBlock ───────────────────────────────────────────────────

describe("extractJsonBlock", () => {
  test("bare JSON", () => {
    expect(extractJsonBlock('{"kind":"no_match"}')).toBe('{"kind":"no_match"}');
  });

  test("fenced JSON with surrounding prose", () => {
    const raw = 'Here is my decision:\n```json\n{"kind":"decision","primary_business":"acme-web"}\n```\nDone.';
    expect(JSON.parse(extractJsonBlock(raw)!)).toEqual({ kind: "decision", primary_business: "acme-web" });
  });

  test("braces inside string values do not break the matcher", () => {
    const raw = '{"rationale":"uses {curly} braces and a \\" quote","kind":"no_match"}';
    expect(JSON.parse(extractJsonBlock(raw)!).kind).toBe("no_match");
  });

  test("no JSON at all → null", () => {
    expect(extractJsonBlock("I could not decide, sorry.")).toBeNull();
  });
});

// ── parseAndValidate ───────────────────────────────────────────────────

describe("parseAndValidate — structured contract", () => {
  test("decision parses with all fields", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "decision",
      primary_business: "acme-web",
      mandatory_squads: ["squad-a"],
      optional_squads: ["squad-b"],
      suggested_mind_clones: ["jane-doe"],
      rationale: "OBJECT=landing page, THEME=health.",
    }), SLUGS);
    expect(r.ok).toBe(true);
    const d = r.decision!;
    expect(d.kind).toBe("decision");
    expect(d.primary_business).toBe("acme-web");
    expect(d.mandatory_squads).toEqual(["squad-a"]);
    expect(d.optional_squads).toEqual(["squad-b"]);
    expect(d.suggested_mind_clones).toEqual(["jane-doe"]);
    expect(d.candidates).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  test("ambiguous carries validated candidates", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "ambiguous",
      candidates: [
        { target: "acme-web", type: "business", reason: "web object" },
        { target: "brandcraft", type: "squad", reason: "brand object" },
        { target: "ghost-squad", type: "squad", reason: "hallucinated" },
      ],
      rationale: "OBJECT unclear.",
    }), SLUGS);
    expect(r.ok).toBe(true);
    const d = r.decision!;
    expect(d.kind).toBe("ambiguous");
    expect(d.candidates.map((c) => c.target)).toEqual(["acme-web", "brandcraft"]);
    expect(d.warnings.some((w) => w.includes("ghost-squad"))).toBe(true);
  });

  test("no_match is ok:true — semantics, not an error", () => {
    const r = parseAndValidate('{"kind":"no_match","rationale":"OBJECT=hologram, nothing fits."}', SLUGS);
    expect(r.ok).toBe(true);
    expect(r.decision!.kind).toBe("no_match");
    expect(r.decision!.primary_business).toBeNull();
    expect(r.decision!.mandatory_squads).toEqual([]);
  });

  test("garbage output is ok:false (transport failure, not no_match semantics)", () => {
    const r = parseAndValidate("model rambled with no JSON", SLUGS);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not return JSON");
  });

  test("invalid JSON is ok:false", () => {
    const r = parseAndValidate('{"kind": "decision", trailing garbage', SLUGS);
    expect(r.ok).toBe(false);
  });

  test("unknown slugs are filtered with warnings", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "decision",
      primary_business: "ghost-business",
      mandatory_squads: ["squad-a", "ghost-squad"],
      optional_squads: ["squad-b"],
      suggested_mind_clones: ["jane-doe", "ghost-clone"],
      rationale: "x",
    }), SLUGS);
    expect(r.ok).toBe(true);
    const d = r.decision!;
    expect(d.primary_business).toBeNull();
    expect(d.mandatory_squads).toEqual(["squad-a"]);
    expect(d.suggested_mind_clones).toEqual(["jane-doe"]);
    expect(d.warnings.filter((w) => w.startsWith("unknown")).length).toBe(3);
    expect(d.kind).toBe("decision"); // squad-a keeps the decision actionable
  });

  test("a decision whose every slug was hallucinated downgrades to no_match", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "decision", primary_business: "ghost", mandatory_squads: ["ghost-2"], rationale: "x",
    }), SLUGS);
    expect(r.ok).toBe(true);
    expect(r.decision!.kind).toBe("no_match");
    expect(r.decision!.warnings.some((w) => w.includes("downgraded"))).toBe(true);
  });

  test("legacy-shaped output (no kind) infers decision / no_match", () => {
    const dec = parseAndValidate('{"primary_business":"acme-web","mandatory_squads":[],"optional_squads":[],"rationale":"x"}', SLUGS);
    expect(dec.decision!.kind).toBe("decision");
    const none = parseAndValidate('{"primary_business":null,"mandatory_squads":[],"optional_squads":[],"rationale":"x"}', SLUGS);
    expect(none.decision!.kind).toBe("no_match");
  });

  test("suggested_mind_clones is capped at 3", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "decision", primary_business: "acme-web",
      suggested_mind_clones: ["jane-doe", "john-roe", "alex-pro", "extra-clone"],
      rationale: "x",
    }), SLUGS);
    expect(r.decision!.suggested_mind_clones.length).toBe(3);
  });

  test("runtime: canonical exec values pass, others are ignored with a warning", () => {
    const okRt = parseAndValidate('{"kind":"decision","primary_business":"acme-web","runtime":"codex","rationale":"x"}', SLUGS);
    expect(okRt.decision!.runtime).toBe("codex");
    const badRt = parseAndValidate('{"kind":"decision","primary_business":"acme-web","runtime":"hermes","rationale":"x"}', SLUGS);
    expect(badRt.decision!.runtime).toBeNull();
    expect(badRt.decision!.warnings.some((w) => w.includes("hermes"))).toBe(true);
  });

  test("mandatory squads never repeat inside optional", () => {
    const r = parseAndValidate(JSON.stringify({
      kind: "decision", primary_business: null,
      mandatory_squads: ["squad-a"], optional_squads: ["squad-a", "squad-b"], rationale: "x",
    }), SLUGS);
    expect(r.decision!.optional_squads).toEqual(["squad-b"]);
  });
});

// ── staleness guard + end-to-end with injected runner ──────────────────

describe("agentic router — digest staleness + injected runner", () => {
  let tmp: string;
  let routerPaths: RouterPaths;

  const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Restore, never delete: the var may belong to another test file mid-flight,
  // and dropping it sends that file to the REAL ~/.harness-logs.
  let savedLogsDir: string | undefined;
  beforeEach(() => {
    savedLogsDir = process.env.HARNESS_LOGS_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentic-router-"));
    process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
    routerPaths = {
      businessesRegistry: path.join(tmp, ".businesses-registry.json"),
      squadsRegistry: path.join(tmp, ".squads-registry.json"),
      mindClonesRegistry: path.join(tmp, ".mind-clones-registry.json"),
      digest: path.join(tmp, ".routing-digest.md"),
    };
    fs.writeFileSync(routerPaths.businessesRegistry, JSON.stringify({
      businesses: { "acme-web": { description: "Builds landing pages.", domains: ["design"], produces: ["landing-page"], capabilities: [], example_briefs: ["Build a landing page"], keywords: ["landing page", "página de destino"] } },
    }));
    fs.writeFileSync(routerPaths.squadsRegistry, JSON.stringify({
      squads: { "squad-a": { description: "Landing squad.", capabilities: ["web.landing.build"], example_briefs: ["Landing please"] } },
      capabilities: { "web.landing.build": [{ squad: "squad-a", description: "Builds it" }] },
    }));
    fs.writeFileSync(routerPaths.mindClonesRegistry, JSON.stringify({
      mind_clones: { "jane-doe": { match: { one_liner: "Jane Doe, typography director.", domains: ["typography"] } } },
    }));
  });

  afterEach(() => {
    if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
    else process.env.HARNESS_LOGS_DIR = savedLogsDir;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function auditEvents(): any[] {
    const day = new Date().toISOString().slice(0, 10);
    const p = path.join(tmp, "logs", day, "audit.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => parseAuditLine(l));
  }

  test("digestIsStale: missing digest is stale; fresh digest is not; a newer registry re-stales it", () => {
    expect(digestIsStale(routerPaths)).toBe(true);
    fs.writeFileSync(routerPaths.digest, "# digest\n");
    fs.utimesSync(routerPaths.digest, at(60), at(60));
    expect(digestIsStale(routerPaths)).toBe(false);
    fs.utimesSync(routerPaths.squadsRegistry, at(120), at(120));
    expect(digestIsStale(routerPaths)).toBe(true);
  });

  test("ensureFreshDigest rebuilds via the real builder and audits x_digest_regenerated", () => {
    const rebuilt = ensureFreshDigest(routerPaths, { cwd: tmp, projectId: "test-proj" });
    expect(rebuilt).toBe(true);
    expect(fs.existsSync(routerPaths.digest)).toBe(true);
    const text = fs.readFileSync(routerPaths.digest, "utf8");
    expect(text).toContain("acme-web");
    expect(text).toContain("squad-a");
    expect(text).toContain("jane-doe");
    const ev = auditEvents().find((e) => e.event === "x_digest_regenerated");
    expect(ev?.ok).toBe(true);
    // fresh now → second call is a no-op
    fs.utimesSync(routerPaths.digest, at(60), at(60));
    expect(ensureFreshDigest(routerPaths, { cwd: tmp })).toBe(false);
  }, 30_000);

  function cannedRunner(result: string, overrides: Partial<RunHeadlessResult> = {}) {
    const calls: RunHeadlessOpts[] = [];
    const impl = (opts: RunHeadlessOpts): RunHeadlessResult => {
      calls.push(opts);
      return {
        ok: true, runtime: opts.runtime, sessionId: "s-1", result,
        costUsd: 0.0123, exitCode: 0, stderr: "", durationMs: 5, ...overrides,
      };
    };
    return { impl, calls };
  }

  test("agenticRoute end-to-end: canned decision, digest-based prompt, cost telemetry, audit", async () => {
    const { impl, calls } = cannedRunner('```json\n{"kind":"decision","primary_business":"acme-web","mandatory_squads":["squad-a"],"optional_squads":[],"suggested_mind_clones":["jane-doe"],"rationale":"OBJECT=landing page, THEME=none."}\n```');
    const d = await agenticRoute({
      brief: "Build a landing page for my clinic",
      runtime: "claude-code",
      cwd: tmp,
      projectId: "test-proj",
      runHeadlessImpl: impl,
      paths: routerPaths,
    });
    expect(d.ok).toBe(true);
    expect(d.kind).toBe("decision");
    expect(d.primary_business).toBe("acme-web");
    expect(d.mandatory_squads).toEqual(["squad-a"]);
    expect(d.suggested_mind_clones).toEqual(["jane-doe"]);
    expect(d.cost_usd).toBe(0.0123);
    expect(d.duration_ms).toBeGreaterThanOrEqual(0);
    // The prompt surveys ONE file — the digest — and never the raw registries.
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toContain(`Read ${routerPaths.digest}`);
    expect(calls[0].prompt).not.toContain(`Read ${routerPaths.squadsRegistry}`);
    expect(calls[0].prompt).toContain("suggested_mind_clones");
    // The staleness guard built the digest before spawning.
    expect(fs.existsSync(routerPaths.digest)).toBe(true);
    const ev = auditEvents();
    expect(ev.some((e) => e.event === "x_digest_regenerated")).toBe(true);
    expect(ev.some((e) => e.event === "agentic_route_called")).toBe(true);
    const decision = ev.find((e) => e.event === "agentic_route_decision");
    expect(decision?.kind).toBe("decision");
    expect(decision?.cost_usd).toBe(0.0123);
    expect(typeof decision?.duration_ms).toBe("number");
  }, 30_000);

  test("agenticRoute: runner failure is ok:false with the runner's error", async () => {
    const impl = (): RunHeadlessResult => ({
      ok: false, runtime: "claude-code", sessionId: null, result: "",
      costUsd: 0.002, exitCode: 1, stderr: "boom", durationMs: 5, error: "budget exceeded",
    });
    const d = await agenticRoute({
      brief: "x", runtime: "claude-code", cwd: tmp,
      runHeadlessImpl: impl, paths: routerPaths,
    });
    expect(d.ok).toBe(false);
    expect(d.kind).toBe("no_match");
    expect(d.error).toBe("budget exceeded");
    expect(d.cost_usd).toBe(0.002);
    expect(auditEvents().some((e) => e.event === "agentic_route_failed")).toBe(true);
  }, 30_000);

  test("agenticRoute: unparsable stdout is ok:false; canned no_match is ok:true", async () => {
    const bad = await agenticRoute({
      brief: "x", runtime: "claude-code", cwd: tmp,
      runHeadlessImpl: cannedRunner("no json here").impl, paths: routerPaths,
    });
    expect(bad.ok).toBe(false);

    const none = await agenticRoute({
      brief: "x", runtime: "claude-code", cwd: tmp,
      runHeadlessImpl: cannedRunner('{"kind":"no_match","rationale":"nothing fits"}').impl, paths: routerPaths,
    });
    expect(none.ok).toBe(true);
    expect(none.kind).toBe("no_match");
    expect(none.error).toBeUndefined();
  }, 30_000);

  test("agenticRoute: unknown slugs from the LLM are filtered against the fixture registries", async () => {
    const { impl } = cannedRunner('{"kind":"decision","primary_business":"ghost-biz","mandatory_squads":["squad-a","ghost-squad"],"rationale":"x"}');
    const d = await agenticRoute({
      brief: "x", runtime: "claude-code", cwd: tmp,
      runHeadlessImpl: impl, paths: routerPaths,
    });
    expect(d.ok).toBe(true);
    expect(d.primary_business).toBeNull();
    expect(d.mandatory_squads).toEqual(["squad-a"]);
    expect(d.warnings.length).toBe(2);
  }, 30_000);
});
