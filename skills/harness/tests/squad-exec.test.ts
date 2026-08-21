// squad-exec.test.ts — the extracted squad headless runner (Phase 4.1).
//
// team-orchestrator.ts now delegates its mandatory-squad execution here; the
// squad-only dispatch route uses the same code path. Pins: prompt content
// (team-mandatory framing byte-compatible with the pre-extraction
// team-orchestrator prompt), audit chain, session reuse with the one-cold-
// retry fallback, and the missing-squad failure. Zero-token via the
// runWithCascade seam.
// Runs with: bun test skills/harness/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSquadHeadless, buildSquadPrompt } from "../lib/squad-exec.ts";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";
import { sessionKey, putSession } from "../lib/session-store.ts";

let tmp: string;
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squadexec-"));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function scaffoldSquad(root: string, slug: string): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}\nMANIFEST-MARKER: yes\n`);
  fs.writeFileSync(path.join(dir, "agents", "lead.md"), "# Lead agent AGENT-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "do-it.md"), "# Do it TASK-MARKER");
  return dir;
}

function okCascadeResult(opts: any, sessionId: string | null = "sess-sq-1") {
  return {
    ok: true, runtime: opts.runtime, sessionId, result: "",
    costUsd: 0.02, exitCode: 0, stderr: "", durationMs: 7,
    handoffs: [], finalRuntime: opts.runtime,
  };
}

function readAudit(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, "logs", day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("buildSquadPrompt — framing per mode", () => {
  test("team-mandatory framing is byte-compatible with the pre-extraction prompt", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief",
      outDir: "/out/dir", mode: "team-mandatory",
      cloneInjection: { block: "", decision: "PADRÃO — nenhum clone útil" },
    });
    // The exact header + footer sentences the team orchestrator always sent.
    expect(p).toContain('Você É o squad "brandcraft" executando uma sub-tarefa de um business maior. Sua saída é input do synthesizer do business.');
    expect(p).toContain("Termine quando o trabalho estiver pronto para o synthesizer integrar.");
    expect(p).toContain("MANIFEST-MARKER");
    expect(p).toContain("AGENT-MARKER");
    expect(p).toContain("TASK-MARKER");
    expect(p).toContain("/out/dir");
  });

  test("squad-only framing addresses the end user, not a synthesizer", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief",
      outDir: "/out/dir", mode: "squad-only",
      cloneInjection: { block: "", decision: "PADRÃO" },
    });
    expect(p).toContain("de ponta a ponta");
    expect(p).toContain("ENTREGÁVEL FINAL");
    expect(p).not.toContain("synthesizer do business");
  });
});

describe("runSquadHeadless", () => {
  test("a single-target producer receives the final-render visual invariants", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a visual",
      projectId: "proj-visual-contract", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "visual-out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: AUTONOMOUS_DIRECTIVE,
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].appendSystemPrompt).toContain("final composited result");
    expect(seen[0].appendSystemPrompt).toContain("fully inside its rendered container");
  });

  test("dispatches through the cascade seam and emits dispatch_squad + agent_executed", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a brand",
      projectId: "proj-sq-1", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "DIRECTIVE-MARKER ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("sess-sq-1");
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain("MANIFEST-MARKER");
    expect(seen[0].appendSystemPrompt).toContain("DIRECTIVE-MARKER");
    const events = readAudit();
    const ds = events.find(e => e.event === "dispatch_squad");
    expect(ds).toBeTruthy();
    expect(ds.squad_slug).toBe("brandcraft");
    expect(ds.mode).toBe("squad-only");
    const ax = events.find(e => e.event === "agent_executed");
    expect(ax).toBeTruthy();
    expect(ax.mode).toBe("squad-only");
    expect(ax.employee).toBe("squad:brandcraft");
  });

  test("team-mandatory mode keeps the team audit contract (business_slug + squad-mandatory)", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-sq-2", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out2"), runtime: "claude-code",
      businessSlug: "parent-biz", mode: "team-mandatory",
      autonomousDirective: "D",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => okCascadeResult(opts)) as any,
    });
    const events = readAudit();
    const ds = events.find(e => e.event === "dispatch_squad");
    expect(ds.business_slug).toBe("parent-biz");
    expect(ds.mode).toBe("team-mandatory");
    const ax = events.find(e => e.event === "agent_executed");
    expect(ax.mode).toBe("squad-mandatory"); // pre-extraction field value, unchanged
    expect(ax.business_slug).toBe("parent-biz");
  });

  test("missing squad dir → ok:false + squad_run_failed, cascade never invoked", () => {
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "no-such-squad", brief: "b",
      projectId: "proj-sq-3", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out3"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "D",
      squadsRoot: path.join(tmp, "squads-empty"),
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("squad dir not found");
    expect(seen).toHaveLength(0);
    expect(readAudit().some(e => e.event === "squad_run_failed")).toBe(true);
  });

  test("session reuse: prior session is resumed; a failed resume retries ONCE cold", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const key = sessionKey("claude-code", "squad", "brandcraft");
    putSession(tmp, key, "claude-code", "stale-session-id");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-sq-4", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out4"), runtime: "claude-code",
      businessSlug: null, mode: "squad-only",
      autonomousDirective: "D",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => {
        seen.push(opts);
        if (opts.sessionId === "stale-session-id") {
          return { ...okCascadeResult(opts, null), ok: false, exitCode: 1, error: "resume failed" };
        }
        return okCascadeResult(opts, "fresh-session");
      }) as any,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].sessionId).toBe("stale-session-id");
    expect(seen[1].sessionId).toBeUndefined(); // cold retry
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fresh-session");
    expect(readAudit().some(e => e.event === "session_resume_failed")).toBe(true);
  });
});
