// gauntlet-evaluator-selection.test.ts — which target judges a Gauntlet round: the
// NIRVANA_GAUNTLET_EVALUATOR forms honoured or refused, the installed registry searched
// for quality.specification_conformance, judge-x as the engine's default for any producer,
// the heuristic only by explicit opt-in, an empty ladder reported as unavailable, and every
// fallback named. Pure, no process, no registry outside a fixture file.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONFORMANCE_CAPABILITY, describeRanking, loadInstalledSquads, parseEvaluatorSpec, rankConformanceEvaluators, selectGauntletEvaluator,
  type InstalledSquad, type JudgeAvailability,
} from "../lib/gauntlet/evaluator-selection.ts";
import { JUDGE_X_TARGET } from "../lib/gauntlet/judge-x.ts";
import type { TargetRef } from "../lib/run-kernel/types.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const AGENT_X: TargetRef = { kind: "agent-x", slug: "agent-x" };
const BUSINESS: TargetRef = { kind: "business", slug: "acme" };
const SQUAD_PRODUCER: TargetRef = { kind: "squad", slug: "document-factory", capabilityId: "document.generate" };
const JUDGE: InstalledSquad = { slug: "spec-judge", capabilities: [CONFORMANCE_CAPABILITY, "quality.style_review"] };
const REVIEWER: InstalledSquad = { slug: "code-review", capabilities: ["software_engineering.code_review.execute"] };
const installed = [REVIEWER, JUDGE, { slug: "document-factory", capabilities: ["document.generate", CONFORMANCE_CAPABILITY] }];
const judgeReady: JudgeAvailability = { available: true };
const judgeMissing: JudgeAvailability = { available: false, reason: "no judge-x persona for runtime 'qwen-code' (judge-x.qwen-code.md)" };

describe("NIRVANA_GAUNTLET_EVALUATOR", () => {
  test.each([
    ["heuristic", { kind: "heuristic" }],
    ["agent-x", { kind: "agent-x" }],
    ["judge-x", { kind: "judge-x" }],
    ["squad:spec-judge", { kind: "squad", slug: "spec-judge" }],
    ["squad:spec-judge:quality.style_review", { kind: "squad", slug: "spec-judge", capabilityId: "quality.style_review" }],
    ["  agent-x  ", { kind: "agent-x" }],
  ])("parses %s", (value: string, expected: unknown) => {
    expect(parseEvaluatorSpec(value)).toEqual(expected as ReturnType<typeof parseEvaluatorSpec>);
  });

  test.each(["squad", "squad:", "business:acme", "gpt", "squad:a b"])("refuses %s", (value: string) => {
    expect(() => parseEvaluatorSpec(value)).toThrow(/is not squad:<slug>\[:<capabilityId>\], judge-x, agent-x or heuristic/);
  });

  test("honours an explicit squad, defaulting its capability to the conformance one when declared", () => {
    expect(selectGauntletEvaluator({ envValue: "squad:spec-judge", producer: AGENT_X, installed, judge: judgeReady })).toEqual({
      kind: "dispatch", target: { kind: "squad", slug: "spec-judge", capabilityId: CONFORMANCE_CAPABILITY }, source: "env", fallbacks: [] });
    expect(selectGauntletEvaluator({ envValue: "squad:spec-judge:quality.style_review", producer: AGENT_X, installed, judge: judgeReady })).toMatchObject({
      target: { slug: "spec-judge", capabilityId: "quality.style_review" }, source: "env" });
    expect(selectGauntletEvaluator({ envValue: "squad:code-review", producer: AGENT_X, installed, judge: judgeReady })).toMatchObject({
      target: { slug: "code-review", capabilityId: "software_engineering.code_review.execute" } });
  });

  test("honours judge-x, agent-x and heuristic explicitly, with no fallback recorded; the heuristic is the only way to judge without an LLM", () => {
    expect(selectGauntletEvaluator({ envValue: "judge-x", producer: AGENT_X, installed, judge: judgeReady })).toEqual({ kind: "dispatch", target: JUDGE_X_TARGET, source: "env", fallbacks: [] });
    expect(selectGauntletEvaluator({ envValue: "agent-x", producer: SQUAD_PRODUCER, installed, judge: judgeReady })).toEqual({ kind: "dispatch", target: AGENT_X, source: "env", fallbacks: [] });
    expect(selectGauntletEvaluator({ envValue: "heuristic", producer: AGENT_X, installed, judge: judgeMissing })).toEqual({ kind: "heuristic", source: "env", fallbacks: [] });
  });

  test("refuses a value it cannot honour instead of reinterpreting it", () => {
    expect(() => selectGauntletEvaluator({ envValue: "agent-x", producer: AGENT_X, installed, judge: judgeReady })).toThrow(/agent-x:agent-x, which cannot evaluate candidates produced by agent-x:agent-x/);
    expect(() => selectGauntletEvaluator({ envValue: "judge-x", producer: AGENT_X, installed, judge: judgeMissing })).toThrow(/names judge-x, which is not available: no judge-x persona for runtime 'qwen-code'/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:ghost", producer: AGENT_X, installed, judge: judgeReady })).toThrow(/squad 'ghost', which is not in the installed registry/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:spec-judge:quality.missing", producer: AGENT_X, installed, judge: judgeReady })).toThrow(/capability 'quality.missing', which squad 'spec-judge' does not declare/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:document-factory:document.generate", producer: SQUAD_PRODUCER, installed, judge: judgeReady }))
      .toThrow(/squad:document-factory:document.generate, which cannot evaluate candidates produced by squad:document-factory:document.generate/);
    expect(() => selectGauntletEvaluator({ envValue: "gpt", producer: AGENT_X, installed, judge: judgeReady })).toThrow(/is not squad:<slug>/);
  });
});

describe("selection without the variable", () => {
  test("ranks the installed squads declaring quality.specification_conformance, skipping the producer", () => {
    // A library that declares no v6 evaluator metadata ranks on the slug alone — the
    // alphabetical answer of before, now as the LAST key instead of the only one.
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed, judge: judgeReady })).toEqual({
      kind: "dispatch", target: { kind: "squad", slug: "document-factory", capabilityId: CONFORMANCE_CAPABILITY }, source: "registry",
      fallbacks: [{ from: "env", reason: "unset" }],
      ranking: { slug: "document-factory", capabilityId: CONFORMANCE_CAPABILITY, fidelity: "experimental", maxCostUsd: null, considered: 2, retired: 0 } });
    const shuffled = [...installed].reverse();
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed: shuffled, judge: judgeReady })).toMatchObject({ target: { slug: "document-factory" } });
    const documentFactoryProducer: TargetRef = { kind: "squad", slug: "document-factory", capabilityId: CONFORMANCE_CAPABILITY };
    expect(selectGauntletEvaluator({ producer: documentFactoryProducer, installed: shuffled, judge: judgeReady })).toMatchObject({ target: { slug: "spec-judge" }, source: "registry" });
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed, envValue: "   ", judge: judgeReady })).toMatchObject({ source: "registry" });
    // The registry squad wins over judge-x even when the judge is available: a user's own judge is preferred.
    expect(selectGauntletEvaluator({ producer: BUSINESS, installed: [JUDGE], judge: judgeReady })).toMatchObject({ target: { slug: "spec-judge" }, source: "registry" });
  });

  test("falls to judge-x for any producer when no installed squad qualifies: agent-x, squad and business alike", () => {
    for (const producer of [AGENT_X, BUSINESS, SQUAD_PRODUCER]) {
      expect(selectGauntletEvaluator({ producer, installed: [REVIEWER], judge: judgeReady })).toEqual({
        kind: "dispatch", target: JUDGE_X_TARGET, source: "default",
        fallbacks: [{ from: "env", reason: "unset" }, { from: "registry", reason: "registry_no_match" }] });
    }
  });

  test("never falls to the heuristic: without a judge the selection is unavailable, naming every rung it skipped", () => {
    for (const producer of [AGENT_X, BUSINESS, SQUAD_PRODUCER]) {
      expect(selectGauntletEvaluator({ producer, installed: [], judge: judgeMissing })).toEqual({
        kind: "unavailable", reason: judgeMissing.reason,
        fallbacks: [{ from: "env", reason: "unset" }, { from: "registry", reason: "registry_no_match" }, { from: "judge-x", reason: "judge_unavailable", detail: judgeMissing.reason }] });
    }
  });
});

describe("evaluator ranking (Squad Protocol v6 §30)", () => {
  const contract = (slug: string, fidelity: string, maxCostUsd: number | null): InstalledSquad => ({
    slug, capabilities: [CONFORMANCE_CAPABILITY],
    evaluators: [{ capabilityId: CONFORMANCE_CAPABILITY, fidelity: fidelity as never, maxCostUsd }],
  });

  test("fidelity first, then the declared cost ceiling, then the slug", () => {
    const installed = [
      contract("z-cheap-drifted", "drifted", 0.5),
      contract("a-expensive-validated", "validated", 9),
      contract("b-cheap-validated", "validated", 1),
      contract("m-experimental", "experimental", 0.1),
    ];
    expect(rankConformanceEvaluators(installed, AGENT_X).ranked.map(entry => entry.slug))
      .toEqual(["b-cheap-validated", "a-expensive-validated", "m-experimental", "z-cheap-drifted"]);
  });

  test("a capability without an evaluator block sorts behind every one that declares a ceiling, inside its fidelity tier", () => {
    const installed = [
      { slug: "a-no-contract", capabilities: [CONFORMANCE_CAPABILITY] },
      contract("z-declares-cost", "experimental", 3),
      contract("y-validated-no-cost", "validated", null),
    ];
    expect(rankConformanceEvaluators(installed, AGENT_X).ranked.map(entry => entry.slug))
      .toEqual(["y-validated-no-cost", "z-declares-cost", "a-no-contract"]);
  });

  test("a retired contract is not a candidate, and its exclusion is counted", () => {
    const installed = [contract("retired-judge", "retired", 0.1), contract("live-judge", "drifted", 8)];
    const ranked = rankConformanceEvaluators(installed, AGENT_X);
    expect(ranked.ranked.map(entry => entry.slug)).toEqual(["live-judge"]);
    expect(ranked.retired).toBe(1);
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed: [contract("retired-judge", "retired", 0.1)], judge: judgeReady }))
      .toMatchObject({ target: JUDGE_X_TARGET, source: "default" });
  });

  test("the selection carries the reason, which is what nrv doctor prints", () => {
    const selection = selectGauntletEvaluator({ producer: AGENT_X, judge: judgeReady,
      installed: [contract("chosen", "validated", 2), contract("other", "experimental", 1), contract("gone", "retired", 0)] });
    expect(selection).toMatchObject({ target: { slug: "chosen" }, ranking: { fidelity: "validated", maxCostUsd: 2, considered: 2, retired: 1 } });
    expect(describeRanking((selection as { ranking: NonNullable<ReturnType<typeof rankConformanceEvaluators>["ranked"][number]> }).ranking))
      .toBe("fidelity validated, max_cost_usd USD 2, ahead of 1 other candidate(s); 1 retired excluded");
  });

  test("reads the evaluator contract out of the registry's capability records", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-evaluator-contract-")); roots.push(root);
    const file = path.join(root, ".squads-registry.json");
    fs.writeFileSync(file, JSON.stringify({
      squads: { "judge-a": { capabilities: [CONFORMANCE_CAPABILITY] }, "judge-b": { capabilities: [CONFORMANCE_CAPABILITY] } },
      capabilities: { [CONFORMANCE_CAPABILITY]: [
        { squad: "judge-a", fidelity: { status: "drifted" }, evaluator: { scorecard: "s", rubric: "r", max_cost_usd: 0.2 } },
        { squad: "judge-b", fidelity_status: "validated" },
      ] },
    }), "utf8");
    const installed = loadInstalledSquads(file);
    expect(installed.find(entry => entry.slug === "judge-a")?.evaluators)
      .toEqual([{ capabilityId: CONFORMANCE_CAPABILITY, fidelity: "drifted", maxCostUsd: 0.2 }]);
    expect(rankConformanceEvaluators(installed, AGENT_X).ranked.map(entry => entry.slug)).toEqual(["judge-b", "judge-a"]);
  });
});

describe("installed registry", () => {
  test("reads slugs and capability ids from the registry nrv index writes, sorted by slug; a missing registry is an empty library", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-evaluator-registry-")); roots.push(root);
    const file = path.join(root, ".squads-registry.json");
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, squads: {
      "zeta-squad": { capabilities: ["quality.specification_conformance"], domains: ["qa"] },
      "alpha-squad": { capabilities: ["general.write.execute", 7], domains: ["general"] },
      "bare-squad": {},
    } }), "utf8");
    expect(loadInstalledSquads(file)).toEqual([
      { slug: "alpha-squad", capabilities: ["general.write.execute"] },
      { slug: "bare-squad", capabilities: [] },
      { slug: "zeta-squad", capabilities: ["quality.specification_conformance"] },
    ]);
    expect(loadInstalledSquads(path.join(root, "missing.json"))).toEqual([]);
    fs.writeFileSync(file, "{ broken", "utf8");
    expect(loadInstalledSquads(file)).toEqual([]);
  });
});
