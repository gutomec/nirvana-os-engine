// cloudevents-envelope.test.ts — the audit log gets a CloudEvents 1.0 envelope,
// and the ~187k events already on disk stay readable.
//
// Measured on 2026-08-28 across both roots this machine writes to
// (`~/.harness-logs`, `<project>/.nirvana/logs/harness`): 186,990 lines, 373
// distinct event names, 0 of them carrying `specversion` / `time` / `type` /
// `data` / `id`, and 713 carrying `source` — as a PAYLOAD key meaning "user",
// "work/assets", an agent file path. That last number is why the envelope
// nests the payload under `data` instead of merging its attributes into the
// flat object: a merge would have overwritten a field 713 lines already use.
//
// What these cases pin:
//   1. a reader handed one legacy line and one envelope line for the same
//      trace returns ONE run, with both events — the dual-read;
//   2. every event name round-trips through `type` and back, so cut 4 can
//      rename names without this cut having lost any;
//   3. the discriminator is `specversion` and nothing else, so a legacy line
//      with a `source` payload key is still read as legacy;
//   4. `data` is bounded, and says so when it had to cut.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

/** The isolated root the test preload created. Captured before any test
 *  mutates the env, so a teardown restores isolation instead of removing it. */
const PRELOAD_LOGS_DIR = process.env.HARNESS_LOGS_DIR!;

const ce = require("../../_shared/lib/cloudevents.js");
const audit = require("../lib/audit.js");

const TMP = makeTempRoot("nrv-cloudevents-");
const previousLogsDir = process.env.HARNESS_LOGS_DIR;

afterAll(() => {
  if (previousLogsDir === undefined) process.env.HARNESS_LOGS_DIR = PRELOAD_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = previousLogsDir;
  removeDir(TMP);
});

describe("a reader handed both forms returns one run", () => {
  const logs = path.join(TMP, "dual-read-logs");
  const TRACE = "3f1d9c22-77a1-4a2f-9a51-0c4f2a9d5e10";
  const BRIEF = "Auditar a visibilidade em busca de uma clínica veterinária";
  let run: any;

  beforeAll(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(logs, today);
    fs.mkdirSync(dir, { recursive: true });
    const at = (n: number) => `${today}T11:${String(n).padStart(2, "0")}:00.000Z`;

    // The brief arrives on a legacy line — a raw appender wrote it, and raw
    // appenders are not converted by this cut. The dispatch arrives wrapped.
    const legacy = {
      ts: at(0), event: "brief_received", trace_id: TRACE, project_id: TRACE,
      squad_name: "seo-geo-aeo", brief_excerpt: BRIEF, brief_chars: BRIEF.length,
    };
    const wrapped = ce.toEnvelope({
      ts: at(1), event: "dispatch_squad", trace_id: TRACE, project_id: TRACE,
      squad_name: "seo-geo-aeo", outputs_dir: "/tmp/out",
    });
    const delivered = ce.toEnvelope({ ts: at(2), event: "delivered", trace_id: TRACE, artifact_path: "/tmp/out/r.md" });

    fs.writeFileSync(
      path.join(dir, "audit.jsonl"),
      [legacy, wrapped, delivered].map(l => JSON.stringify(l)).join("\n") + "\n",
    );
    process.env.HARNESS_LOGS_DIR = logs;
    const { buildRuns } = await import("../lib/glance/data-loader.ts");
    run = buildRuns({ days: 7 }).runs!.find((r: any) => r.trace_id === TRACE);
  });

  test("the envelope lines land in the run the legacy line opened", () => {
    expect(run).toBeTruthy();
    expect(run.event_count).toBe(3);
  });

  test("what the envelope carries reaches the card", () => {
    expect(run.brief).toBe(BRIEF);
    expect(run.squad_name).toBe("seo-geo-aeo");
    expect(run.target).toBe("squad:seo-geo-aeo");
    expect(run.outputs_dir).toBe("/tmp/out");
  });

  test("a terminal event written as an envelope still ends the run", () => {
    expect(run.status).toBe("delivered");
  });
});

describe("every name survives the trip through `type`", () => {
  test("the domain map covers the closed enum exactly", () => {
    const missing = [...audit.ALLOWED_EVENTS].filter((e: string) => !ce.EVENT_DOMAINS[e]);
    const extra = Object.keys(ce.EVENT_DOMAINS).filter(k => !audit.ALLOWED_EVENTS.has(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test("core, extension and unknown names all round-trip", () => {
    const names = [
      ...audit.ALLOWED_EVENTS,
      // Real names from the open namespace, as they appear in the log today.
      "x_ledger_run_opened", "x_ledger_lease_renewed", "x_verify_squad", "x_capability_resolved",
      // A name nobody declared anywhere, which is how 286 of them arrived.
      "infographic_page_height_checked",
    ];
    for (const name of names) {
      expect(ce.eventNameFor(ce.typeFor(name))).toBe(name);
    }
  });

  test("a type outside our namespace is not silently renamed to nothing", () => {
    expect(ce.eventNameFor("com.example.thing.happened")).toBeNull();
    const flat = ce.toLegacyEvent({ specversion: "1.0", id: "x", source: "/other", type: "com.example.thing.happened", data: {} });
    expect(flat.event).toBe("com.example.thing.happened");
  });

  test("the payload comes back whole, key for key", () => {
    const flat = {
      ts: "2026-08-28T10:00:00.000Z", event: "gate_passed", trace_id: "t", project_id: "p",
      business_slug: "ars-libri", agent_or_employee: "editor", session_id: "s",
      rubric: "wiki-lint", score: 0.94, checks: [{ name: "dash", ok: true }],
    };
    const back = ce.toLegacyEvent(ce.toEnvelope(flat));
    delete back._ce;
    expect(back).toEqual(flat);
  });
});

describe("the discriminator is specversion, and only specversion", () => {
  test("a legacy line with a `source` payload key is read as legacy, untouched", () => {
    // 713 lines on disk look exactly like this.
    const legacy = { ts: "2026-05-20T03:00:38.446Z", event: "brief_received", source: "user", trace_id: "t" };
    expect(ce.isEnvelope(legacy)).toBe(false);
    expect(ce.toLegacyEvent(legacy)).toBe(legacy);
  });

  test("the payload's own `source` survives the wrap", () => {
    const back = ce.toLegacyEvent(ce.toEnvelope({ ts: "2026-05-20T03:00:38.446Z", event: "brief_received", source: "user" }));
    expect(back.source).toBe("user");
    expect(back._ce.source).toBe("/engine/harness");
  });

  test("attribution is derived from whichever spelling the author used", () => {
    expect(ce.toEnvelope({ event: "x_thing", squad: "instagram-visual-identity" }).source).toBe("/squad/instagram-visual-identity");
    expect(ce.toEnvelope({ event: "x_thing", squad_name: "seo-geo-aeo" }).source).toBe("/squad/seo-geo-aeo");
    expect(ce.toEnvelope({ event: "x_thing", business: "ars-libri" }).source).toBe("/business/ars-libri");
    expect(ce.toEnvelope({ event: "x_thing", business_slug: "ars-libri" }).source).toBe("/business/ars-libri");
    expect(ce.toEnvelope({ event: "tool_invoked", host: "claude-code-hook" }).source).toBe("/engine/claude-code-hook");
    expect(ce.toEnvelope({ event: "gate_passed" }).source).toBe("/engine/harness");
  });
});

describe("cut 4 — a rogue legacy name migrates to its extension identity at read time", () => {
  // `audit-miner.ts` and `observability-handler.ts` both filter on the exact
  // historical string `event === "revision"` over the raw log — measured
  // before choosing this design. Renaming `.event` itself would have made
  // both readers silently stop counting revisions on every pre-envelope line.
  test("a name nobody declared gets a canonical x_-prefixed type, without touching `.event`", () => {
    const legacy = { ts: "2026-05-29T10:00:00.000Z", event: "phase_completed", trace_id: "t", squad: "ebook-maestro-nirvana" };
    const back = ce.toLegacyEvent(legacy);
    expect(back.event).toBe("phase_completed");
    expect(back._ce.type).toBe("sh.squads.nirvana.ext.x_phase_completed");
    expect(ce.eventNameFor(back._ce.type)).toBe("x_phase_completed");
  });

  test("the migrated type matches what a compliant x_ emission of the same name produces", () => {
    expect(ce.typeFor("x_phase_completed")).toBe(ce.toLegacyEvent({ event: "phase_completed" })._ce.type);
  });

  test("a closed-enum legacy line is not decorated at all — untouched stays untouched", () => {
    const legacy = { ts: "2026-05-29T10:00:00.000Z", event: "brief_received", trace_id: "t" };
    const back = ce.toLegacyEvent(legacy);
    expect(back._ce).toBeUndefined();
    expect(back).toBe(legacy);
  });

  test("an already x_-prefixed legacy line is not re-decorated", () => {
    const legacy = { ts: "2026-05-29T10:00:00.000Z", event: "x_capability_resolved", trace_id: "t" };
    const back = ce.toLegacyEvent(legacy);
    expect(back._ce).toBeUndefined();
  });

  test("a reader keying on the literal rogue name keeps matching after migration", () => {
    const legacy = { ts: "2026-05-29T10:00:00.000Z", event: "revision", trace_id: "t" };
    const back = ce.parseAuditLine(JSON.stringify(legacy));
    expect(back.event).toBe("revision");
  });

  test("canonicalEventName: enum and x_ names pass through, a rogue name gets prefixed", () => {
    expect(ce.canonicalEventName("brief_received")).toBe("brief_received");
    expect(ce.canonicalEventName("x_capability_resolved")).toBe("x_capability_resolved");
    expect(ce.canonicalEventName("phase_completed")).toBe("x_phase_completed");
  });
});

describe("data stays bounded", () => {
  test("a payload under the ceiling is passed through untouched", () => {
    const data = { rubric: "wiki-lint", score: 0.94 };
    expect(ce.boundData(data).data).toBe(data);
  });

  test("a whole brief pasted onto an event is cut, marked, and brought under the ceiling", () => {
    const whole = "Auditar a clínica. ".repeat(1200);
    const env = ce.toEnvelope({ ts: "2026-08-28T10:00:00.000Z", event: "brief_received", trace_id: "t", brief: whole });
    expect(Buffer.byteLength(JSON.stringify(env.data), "utf8")).toBeLessThanOrEqual(ce.MAX_DATA_BYTES);
    expect(env.data.brief.endsWith("…")).toBe(true);
    expect(env.data._truncated).toEqual(["brief"]);
    expect(env.data._bytes.brief).toBe(Buffer.byteLength(whole, "utf8"));
    // The key keeps its name and its type, so a reader of `ev.brief` still reads a string.
    expect(typeof ce.toLegacyEvent(env).brief).toBe("string");
  });
});

describe("emit writes the envelope and the audit readers read it back flat", () => {
  const logs = path.join(TMP, "emit-logs");

  beforeAll(() => { process.env.HARNESS_LOGS_DIR = logs; });

  test("the line on disk is a valid CloudEvents structured-mode event", () => {
    const { path: file } = audit.emit("gate_passed", { rubric: "wiki-lint", score: 0.94 }, { trace_id: "emit-trace", project_id: "emit-project", squad_name: "seo-geo-aeo" });
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const raw = JSON.parse(lines[lines.length - 1]);
    expect(raw.specversion).toBe("1.0");
    expect(raw.type).toBe("sh.squads.nirvana.gate.gate_passed");
    expect(raw.source).toBe("/squad/seo-geo-aeo");
    expect(raw.subject).toBe("emit-trace");
    expect(raw.projectid).toBe("emit-project");
    expect(typeof raw.id).toBe("string");
    expect(raw.id.length).toBe(32);
    expect(raw.data.rubric).toBe("wiki-lint");
    // The flat keys are attributes now, not payload.
    expect(raw.data.ts).toBeUndefined();
    expect(raw.data.event).toBeUndefined();
  });

  test("readRecent hands the caller the flat shape it has always had", () => {
    audit.emit("delivered", { artifact_path: "/tmp/out/r.md" }, { trace_id: "emit-trace" });
    const recent = audit.readRecent(5, undefined, undefined);
    const delivered = recent.find((e: any) => e.event === "delivered");
    expect(delivered).toBeTruthy();
    expect(delivered.trace_id).toBe("emit-trace");
    expect(delivered.artifact_path).toBe("/tmp/out/r.md");
    expect(typeof delivered.ts).toBe("string");
  });
});
