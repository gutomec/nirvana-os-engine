// cards-router.test.ts — the `cards` routing mode (lib/routing-cards.ts +
// lib/cards-router.ts).
//
// Zero-token: the runtime call is either injected (runHeadlessImpl) or a fake
// `claude` on PATH, so the no-tools argv and the empty working directory are
// read off a real process. Covers the card lines, the builder writing the
// cards beside the digest, the prompt, the parser (prefixed ids, fenced JSON,
// gemini's envelope), the one retry on a target that is not installed, the
// drop-and-report of voices and squads, and the mapping onto the decision
// contract the dispatch consumes.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { businessCard, clip, renderRoutingCards, squadCard } from "../lib/routing-cards.ts";
import {
  buildCardsPrompt, cardsRoute, cloneCandidateLine, ensureFreshCards, parseCardsAnswer,
  resolveCardsTarget, toCardsDecision, withDoneWhen, type CardsRouterPaths,
} from "../lib/cards-router.ts";
import type { RegistrySlugs } from "../lib/agentic-router.ts";
import type { RunHeadlessOpts, RunHeadlessResult } from "../lib/host-agent-driver.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const BUILDER = path.resolve(import.meta.dir, "..", "scripts", "build-routing-digest.ts");

const SLUGS: RegistrySlugs = {
  businesses: new Set(["acme-web", "both-ways"]),
  squads: new Set(["squad-a", "squad-b", "squad-c", "brandcraft", "both-ways"]),
  mindClones: new Set(["jane-doe", "john-roe", "alex-pro"]),
};

// ── cards ──────────────────────────────────────────────────────────────

describe("routing cards", () => {
  test("a business card states what it produces before what it is, format suffixes stripped", () => {
    const card = businessCard("acme-web", {
      description: "Builds landing pages | and sites.\nEnd to end.",
      produces: ["landing-page-html", "copy.md", "landing-page", "a", "b", "c", "d", "e"],
      not_for: ["logo design", "print", "video"],
    });
    expect(card).toBe("business:acme-web | produces: landing-page, copy, a, b, c, d | Builds landing pages / and sites. End to end. | not: logo design; print");
  });

  test("a squad card takes its not_for from its own capabilities only", () => {
    const caps = {
      "web.build": [{ squad: "squad-a", not_for: ["native apps"] }, { squad: "squad-b", not_for: ["someone else's boundary"] }],
      "web.audit": [{ squad: "squad-a", not_for: ["native apps", "pentests"] }],
    };
    const card = squadCard("squad-a", { description: "Web squad.", produces: ["site-zip"], capabilities: ["web.build", "web.audit"] }, caps);
    expect(card).toBe("squad:squad-a | produces: site | Web squad. | not: native apps; pentests");
  });

  test("descriptions are clipped at a sentence end, else at a word", () => {
    const sentences = "First sentence is here and it is fairly long. Second sentence goes on and on past the limit of the card for sure.";
    expect(clip(sentences, 60)).toBe("First sentence is here and it is fairly long.");
    const words = "one two three four five six seven eight nine ten eleven twelve";
    expect(clip(words, 20)).toBe("one two three four…");
    expect(clip("short", 20)).toBe("short");
  });

  test("the file lists businesses and squads, never mind-clones", () => {
    const text = renderRoutingCards({
      businesses: { "acme-web": { description: "Web business.", produces: ["site"] } },
      squads: { "squad-a": { description: "Squad.", capabilities: [] } },
      capabilities: {},
    }, "2026-09-30T00:00:00.000Z");
    expect(text).toContain("## Businesses\nbusiness:acme-web | produces: site | Web business.");
    expect(text).toContain("## Squads\nsquad:squad-a | Squad.");
    expect(text).not.toContain("clone:");
  });
});

// ── prompt + parse + target + mapping (pure) ───────────────────────────

describe("cards prompt", () => {
  test("carries the brief, the cards, the clone candidates and the answer shape; no correction on the first ask", () => {
    const clones = [cloneCandidateLine({ slug: "jane-doe", display_name: "Jane Doe", one_liner: "Typography | director." })];
    expect(clones[0]).toBe("clone:jane-doe | Jane Doe | Typography / director.");
    const prompt = buildCardsPrompt("Build a landing page", "## Businesses\nbusiness:acme-web | produces: site", clones);
    expect(prompt).toContain("do not use tools");
    expect(prompt).toContain("# Request\n\nBuild a landing page");
    expect(prompt).toContain("business:acme-web | produces: site");
    expect(prompt).toContain("clone:jane-doe | Jane Doe");
    expect(prompt).toContain('"target": "business:<slug> | squad:<slug> | solo"');
    expect(prompt).toContain("States, not steps.");
    expect(prompt).not.toContain("# Correction");
    expect(buildCardsPrompt("x", "cards", [], "The previous answer chose \"ghost\".")).toContain("# Correction\n\nThe previous answer chose \"ghost\".");
    expect(buildCardsPrompt("x", "cards", [])).toContain("(none)");
  });
});

describe("parseCardsAnswer", () => {
  test("fenced JSON with prose around it; clone: and squad: prefixes are stripped", () => {
    const r = parseCardsAnswer('Here:\n```json\n{"target":"business:acme-web","voices":["clone:jane-doe","jane-doe"],"squads":["squad:squad-a"],"done":["a","b","c","d","e","f"],"reason":"Web object."}\n```');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toEqual({ target: "business:acme-web", voices: ["jane-doe"], squads: ["squad-a"], done: ["a", "b", "c", "d", "e"], reason: "Web object." });
  });

  test("gemini's envelope is unwrapped to the model's text", () => {
    const envelope = JSON.stringify({ session_id: "s", response: '{"target":"solo","done":["x"],"reason":"r"}', stats: {} });
    const r = parseCardsAnswer(envelope);
    expect(r.ok && r.answer.target).toBe("solo");
  });

  test("no JSON is an error, not a decision", () => {
    const r = parseCardsAnswer("I would route this to the web business.");
    expect(r.ok).toBe(false);
  });
});

describe("resolveCardsTarget", () => {
  test("prefixed ids, solo and an unambiguous bare slug resolve; the rest name their error", () => {
    expect(resolveCardsTarget("business:acme-web", SLUGS)).toEqual({ kind: "business", slug: "acme-web" });
    expect(resolveCardsTarget("squad:brandcraft", SLUGS)).toEqual({ kind: "squad", slug: "brandcraft" });
    expect(resolveCardsTarget("SOLO", SLUGS)).toEqual({ kind: "solo" });
    expect(resolveCardsTarget("brandcraft", SLUGS)).toEqual({ kind: "squad", slug: "brandcraft" });
    expect("error" in resolveCardsTarget("both-ways", SLUGS)).toBe(true);
    expect(resolveCardsTarget("business:ghost", SLUGS)).toEqual({ error: '"business:ghost" is not installed' });
    expect(resolveCardsTarget("squad:acme-web", SLUGS)).toEqual({ error: '"squad:acme-web" is not installed' });
    expect(resolveCardsTarget("", SLUGS)).toEqual({ error: "the answer named no target" });
  });
});

describe("toCardsDecision — the dispatch's decision contract", () => {
  const answer = (over: Partial<Parameters<typeof toCardsDecision>[0]> = {}) => ({
    target: "", voices: [], squads: [], done: ["page is live"], reason: "because", ...over,
  });

  test("business: primary_business, support squads as mandatory, voices as suggested clones", () => {
    const d = toCardsDecision(answer({ voices: ["jane-doe"], squads: ["squad-a"] }), { kind: "business", slug: "acme-web" }, SLUGS);
    expect(d).toMatchObject({
      kind: "decision", primary_business: "acme-web", mandatory_squads: ["squad-a"], optional_squads: [],
      suggested_mind_clones: ["jane-doe"], candidates: [], rationale: "because", runtime: null,
      done: ["page is live"], dropped: [],
    });
  });

  test("squad: the squad alone, and a support squad is dropped and reported", () => {
    const d = toCardsDecision(answer({ squads: ["squad-b"] }), { kind: "squad", slug: "brandcraft" }, SLUGS);
    expect(d.kind).toBe("decision");
    expect(d.primary_business).toBeNull();
    expect(d.mandatory_squads).toEqual(["brandcraft"]);
    expect(d.dropped).toEqual(["squad:squad-b"]);
    expect(d.warnings[0]).toContain("only with a business target");
  });

  test("solo is no_match, which the cascade sends to agent-x", () => {
    const d = toCardsDecision(answer(), { kind: "solo" }, SLUGS);
    expect(d.kind).toBe("no_match");
    expect(d.primary_business).toBeNull();
    expect(d.mandatory_squads).toEqual([]);
    expect(d.done).toEqual(["page is live"]);
  });

  test("unknown voices and squads, and any past the limit of two, are dropped and reported", () => {
    const d = toCardsDecision(
      answer({ voices: ["ghost-clone", "jane-doe", "john-roe", "alex-pro"], squads: ["ghost-squad", "squad-a", "squad-b", "squad-c"] }),
      { kind: "business", slug: "acme-web" }, SLUGS,
    );
    expect(d.suggested_mind_clones).toEqual(["jane-doe", "john-roe"]);
    expect(d.mandatory_squads).toEqual(["squad-a", "squad-b"]);
    expect(d.dropped).toEqual(["clone:ghost-clone", "clone:alex-pro", "squad:ghost-squad", "squad:squad-c"]);
    expect(d.warnings).toHaveLength(4);
  });
});

describe("withDoneWhen", () => {
  test("appends the states as a section the executor checks itself against", () => {
    const out = withDoneWhen("Build the page.\n\n", ["The page is live", "  Copy  reviewed "]);
    expect(out).toBe("Build the page.\n\n## Done when\n\nCheck each of these yourself before you finish:\n- The page is live\n- Copy reviewed\n");
    expect(withDoneWhen("Build the page.", [])).toBe("Build the page.");
  });
});

// ── fixture registries ─────────────────────────────────────────────────

function writeFixture(dir: string): CardsRouterPaths {
  const p: CardsRouterPaths = {
    businessesRegistry: path.join(dir, ".businesses-registry.json"),
    squadsRegistry: path.join(dir, ".squads-registry.json"),
    mindClonesRegistry: path.join(dir, ".mind-clones-registry.json"),
    digest: path.join(dir, ".routing-digest.md"),
    cards: path.join(dir, ".routing-cards.md"),
  };
  fs.writeFileSync(p.businessesRegistry, JSON.stringify({
    businesses: { "acme-web": { description: "Builds landing pages.", produces: ["landing-page-html"], not_for: ["logo design"] } },
  }));
  fs.writeFileSync(p.squadsRegistry, JSON.stringify({
    squads: {
      "squad-a": { description: "Landing squad.", produces: ["landing-page"], capabilities: ["web.landing.build"] },
      brandcraft: { description: "Brand squad.", produces: ["brand-book-pdf"], capabilities: [] },
    },
    capabilities: { "web.landing.build": [{ squad: "squad-a", not_for: ["native apps"] }] },
  }));
  fs.writeFileSync(p.mindClonesRegistry, JSON.stringify({
    mind_clones: { "jane-doe": { match: { one_liner: "Jane Doe, typography director." } } },
  }));
  return p;
}

describe("the builder writes the cards beside the digest", () => {
  test("`build-routing-digest.ts --out` puts .routing-cards.md in the same directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cards-builder-"));
    try {
      const p = writeFixture(dir);
      const r = spawnSync(process.execPath, [BUILDER, "--businesses", p.businessesRegistry, "--squads", p.squadsRegistry, "--clones", p.mindClonesRegistry, "--out", p.digest, "--quiet"], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const cards = fs.readFileSync(p.cards, "utf8");
      expect(cards).toContain("business:acme-web | produces: landing-page | Builds landing pages. | not: logo design");
      expect(cards).toContain("squad:squad-a | produces: landing-page | Landing squad. | not: native apps");
      expect(cards).toContain("squad:brandcraft | produces: brand-book | Brand squad.");
      expect(cards).not.toContain("jane-doe");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, spawnBudgetMs(1));
});

// ── cardsRoute (injected runner) ───────────────────────────────────────

describe("cardsRoute", () => {
  let tmp: string;
  let paths: CardsRouterPaths;
  let savedLogsDir: string | undefined;
  const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  beforeEach(() => {
    savedLogsDir = process.env.HARNESS_LOGS_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cards-router-"));
    process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
    paths = writeFixture(tmp);
    // Fresh cards, so the injected-runner tests never spawn the builder.
    fs.writeFileSync(paths.cards, "## Businesses\nbusiness:acme-web | produces: landing-page\n## Squads\nsquad:squad-a | produces: landing-page\n");
    fs.utimesSync(paths.cards, at(60), at(60));
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

  function canned(...answers: Array<string | Partial<RunHeadlessResult>>) {
    const calls: RunHeadlessOpts[] = [];
    const cwdWasEmpty: boolean[] = [];
    const impl = (opts: RunHeadlessOpts): RunHeadlessResult => {
      calls.push(opts);
      cwdWasEmpty.push(fs.existsSync(opts.cwd) && fs.readdirSync(opts.cwd).length === 0);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      const base: RunHeadlessResult = { ok: true, runtime: opts.runtime, sessionId: "s", result: "", costUsd: 0.01, exitCode: 0, stderr: "", durationMs: 5 };
      return typeof a === "string" ? { ...base, result: a } : { ...base, ...a };
    };
    return { impl, calls, cwdWasEmpty };
  }

  const clonesSeam = () => [{ slug: "jane-doe", display_name: "Jane Doe", one_liner: "Typography director." }];

  test("one call, no tools, an empty scratch directory, the planner role and routing.timeout_ms", async () => {
    const run = canned('{"target":"business:acme-web","voices":["clone:jane-doe"],"squads":["squad:squad-a"],"done":["The page is live","Copy reviewed","Forms work"],"reason":"Web object."}');
    const d = await cardsRoute({ brief: "Build a landing page", runtime: "claude-code", cwd: tmp, runHeadlessImpl: run.impl, paths, cloneSearchImpl: clonesSeam });
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0];
    expect(call.noTools).toBe(true);
    expect(call.dispatchRole).toBe("planner");
    expect(call.timeoutMs).toBe(resolveSetting("routing.timeout_ms").value);
    expect(call.cwd).not.toBe(tmp);
    expect(run.cwdWasEmpty[0]).toBe(true);
    expect(fs.existsSync(call.cwd)).toBe(false);
    expect(call.prompt).toContain("Build a landing page");
    expect(call.prompt).toContain("business:acme-web | produces: landing-page");
    expect(call.prompt).toContain("clone:jane-doe | Jane Doe | Typography director.");

    expect(d).toMatchObject({
      ok: true, kind: "decision", primary_business: "acme-web", mandatory_squads: ["squad-a"],
      suggested_mind_clones: ["jane-doe"], done: ["The page is live", "Copy reviewed", "Forms work"],
      dropped: [], attempts: 1, cost_usd: 0.01,
    });
    const ev = auditEvents().find((e) => e.event === "agentic_route_decision");
    expect(ev?.mode).toBe("cards");
    expect(ev?.done).toHaveLength(3);
  });

  test("a target that is not installed gets ONE more call that names the error", async () => {
    const run = canned(
      '{"target":"business:ghost-web","done":["x"],"reason":"r"}',
      '{"target":"squad:brandcraft","done":["Brand book delivered"],"reason":"One specialty."}',
    );
    const d = await cardsRoute({ brief: "Brand book", runtime: "claude-code", cwd: tmp, runHeadlessImpl: run.impl, paths, cloneSearchImpl: () => [] });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0].prompt).not.toContain("# Correction");
    expect(run.calls[1].prompt).toContain('# Correction\n\nThe previous answer chose "business:ghost-web": "business:ghost-web" is not installed.');
    expect(d).toMatchObject({ ok: true, kind: "decision", primary_business: null, mandatory_squads: ["brandcraft"], attempts: 2, cost_usd: 0.02 });
    expect(auditEvents().some((e) => e.event === "x_cards_route_retry")).toBe(true);
  });

  test("no installed target twice is a router failure, so routing.on_router_failure decides", async () => {
    const run = canned("I think the web business fits best.", '{"target":"business:ghost","reason":"r"}');
    const d = await cardsRoute({ brief: "x", runtime: "claude-code", cwd: tmp, runHeadlessImpl: run.impl, paths, cloneSearchImpl: () => [] });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1].prompt).toContain("could not be read");
    expect(d.ok).toBe(false);
    expect(d.error).toContain("named no installed target twice");
    expect(auditEvents().some((e) => e.event === "agentic_route_failed" && e.mode === "cards")).toBe(true);
  });

  test("dropped voices and squads are reported on the console and in the audit", async () => {
    const run = canned('{"target":"business:acme-web","voices":["ghost-clone"],"squads":["ghost-squad"],"done":["a","b","c"],"reason":"r"}');
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    let d;
    try {
      d = await cardsRoute({ brief: "x", runtime: "claude-code", cwd: tmp, runHeadlessImpl: run.impl, paths, cloneSearchImpl: () => [] });
    } finally { console.error = original; }
    expect(d!.dropped).toEqual(["clone:ghost-clone", "squad:ghost-squad"]);
    expect(errors.some((e) => e.includes("unknown mind-clone dropped: ghost-clone"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown squad dropped: ghost-squad"))).toBe(true);
    const ev = auditEvents().find((e) => e.event === "agentic_route_decision");
    expect(ev?.dropped).toEqual(["clone:ghost-clone", "squad:ghost-squad"]);
  });

  test("a timeout is marked timed_out and not asked again", async () => {
    const run = canned({ ok: false, exitCode: 124, error: "timed out", result: "" });
    const d = await cardsRoute({ brief: "x", runtime: "claude-code", cwd: tmp, runHeadlessImpl: run.impl, paths, cloneSearchImpl: () => [] });
    expect(run.calls).toHaveLength(1);
    expect(d).toMatchObject({ ok: false, timed_out: true });
  });

  test("stale cards are rebuilt from the registries before the call", async () => {
    fs.utimesSync(paths.cards, at(-120), at(-120));
    expect(ensureFreshCards(paths, { cwd: tmp })).toBe(true);
    expect(fs.readFileSync(paths.cards, "utf8")).toContain("squad:brandcraft | produces: brand-book");
    expect(ensureFreshCards(paths, { cwd: tmp })).toBe(false);
  }, spawnBudgetMs(1));
});

// ── the real runtime process: no tools, empty cwd ──────────────────────

describe("cardsRoute against a real claude process", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cards-claude-"));
  const BIN = path.join(ROOT, "bin");
  const CAPTURE = path.join(ROOT, "capture");
  let savedPath: string | undefined;
  let savedCapture: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(CAPTURE, { recursive: true });
    // Records argv and what its working directory held, then answers like
    // `claude -p --output-format json`.
    writeFakeCli(BIN, "claude", `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const prompt = await Bun.stdin.text();
      const dir = process.env.FAKE_CAPTURE_DIR!;
      fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify({ argv: Bun.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), promptChars: prompt.length }));
      const answer = { target: "solo", voices: [], squads: [], done: ["The answer file exists"], reason: "Nothing in the catalog fits." };
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), session_id: "s", total_cost_usd: 0.002 }));
    `);
    savedPath = process.env.PATH;
    savedCapture = process.env.FAKE_CAPTURE_DIR;
    process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_CAPTURE_DIR = CAPTURE;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedCapture === undefined) delete process.env.FAKE_CAPTURE_DIR;
    else process.env.FAKE_CAPTURE_DIR = savedCapture;
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  test("claude is started with --tools \"\" in an empty directory, and solo maps to no_match", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "lib-"));
    const paths = writeFixture(dir);
    fs.writeFileSync(paths.cards, "## Businesses\nbusiness:acme-web | produces: landing-page\n");
    fs.utimesSync(paths.cards, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const d = await cardsRoute({ brief: "Answer a riddle", runtime: "claude-code", cwd: dir, paths, cloneSearchImpl: () => [], timeoutMs: 20_000 });
    const call = JSON.parse(fs.readFileSync(path.join(CAPTURE, "call.json"), "utf8"));
    const i = call.argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(call.argv[i + 1]).toBe("");
    expect(call.entries).toEqual([]);
    expect(path.basename(call.cwd)).toStartWith("nrv-cards-route-");
    expect(fs.existsSync(call.cwd)).toBe(false);
    expect(call.promptChars).toBeGreaterThan(0);
    expect(d).toMatchObject({ ok: true, kind: "no_match", done: ["The answer file exists"], cost_usd: 0.002 });
  }, spawnBudgetMs(1));
});
