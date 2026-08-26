// gauntlet-evaluator-selection.test.ts — which target judges a Gauntlet round: the
// NIRVANA_GAUNTLET_EVALUATOR forms honoured or refused, the installed registry searched
// for quality.specification_conformance, the agent-x default, the heuristic as the last
// rung, and every fallback named. Pure, no process, no registry outside a fixture file.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONFORMANCE_CAPABILITY, loadInstalledSquads, parseEvaluatorSpec, selectGauntletEvaluator, type InstalledSquad,
} from "../lib/gauntlet/evaluator-selection.ts";
import type { TargetRef } from "../lib/run-kernel/types.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const AGENT_X: TargetRef = { kind: "agent-x", slug: "agent-x" };
const BUSINESS: TargetRef = { kind: "business", slug: "acme" };
const SQUAD_PRODUCER: TargetRef = { kind: "squad", slug: "document-factory", capabilityId: "document.generate" };
const JUDGE: InstalledSquad = { slug: "spec-judge", capabilities: [CONFORMANCE_CAPABILITY, "quality.style_review"] };
const REVIEWER: InstalledSquad = { slug: "code-review", capabilities: ["software_engineering.code_review.execute"] };
const installed = [REVIEWER, JUDGE, { slug: "document-factory", capabilities: ["document.generate", CONFORMANCE_CAPABILITY] }];

describe("NIRVANA_GAUNTLET_EVALUATOR", () => {
  test.each([
    ["heuristic", { kind: "heuristic" }],
    ["agent-x", { kind: "agent-x" }],
    ["squad:spec-judge", { kind: "squad", slug: "spec-judge" }],
    ["squad:spec-judge:quality.style_review", { kind: "squad", slug: "spec-judge", capabilityId: "quality.style_review" }],
    ["  agent-x  ", { kind: "agent-x" }],
  ])("parses %s", (value: string, expected: unknown) => {
    expect(parseEvaluatorSpec(value)).toEqual(expected as ReturnType<typeof parseEvaluatorSpec>);
  });

  test.each(["squad", "squad:", "business:acme", "gpt", "squad:a b"])("refuses %s", (value: string) => {
    expect(() => parseEvaluatorSpec(value)).toThrow(/is not squad:<slug>\[:<capabilityId>\], agent-x or heuristic/);
  });

  test("honours an explicit squad, defaulting its capability to the conformance one when declared", () => {
    expect(selectGauntletEvaluator({ envValue: "squad:spec-judge", producer: AGENT_X, installed })).toEqual({
      kind: "dispatch", target: { kind: "squad", slug: "spec-judge", capabilityId: CONFORMANCE_CAPABILITY }, source: "env", fallbacks: [] });
    expect(selectGauntletEvaluator({ envValue: "squad:spec-judge:quality.style_review", producer: AGENT_X, installed })).toMatchObject({
      target: { slug: "spec-judge", capabilityId: "quality.style_review" }, source: "env" });
    expect(selectGauntletEvaluator({ envValue: "squad:code-review", producer: AGENT_X, installed })).toMatchObject({
      target: { slug: "code-review", capabilityId: "software_engineering.code_review.execute" } });
  });

  test("honours agent-x and heuristic explicitly, with no fallback recorded", () => {
    expect(selectGauntletEvaluator({ envValue: "agent-x", producer: SQUAD_PRODUCER, installed })).toEqual({ kind: "dispatch", target: AGENT_X, source: "env", fallbacks: [] });
    expect(selectGauntletEvaluator({ envValue: "heuristic", producer: AGENT_X, installed })).toEqual({ kind: "heuristic", source: "env", fallbacks: [] });
  });

  test("refuses a value it cannot honour instead of reinterpreting it", () => {
    expect(() => selectGauntletEvaluator({ envValue: "agent-x", producer: AGENT_X, installed })).toThrow(/agent-x:agent-x, which cannot evaluate candidates produced by agent-x:agent-x/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:ghost", producer: AGENT_X, installed })).toThrow(/squad 'ghost', which is not in the installed registry/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:spec-judge:quality.missing", producer: AGENT_X, installed })).toThrow(/capability 'quality.missing', which squad 'spec-judge' does not declare/);
    expect(() => selectGauntletEvaluator({ envValue: "squad:document-factory:document.generate", producer: SQUAD_PRODUCER, installed }))
      .toThrow(/squad:document-factory:document.generate, which cannot evaluate candidates produced by squad:document-factory:document.generate/);
    expect(() => selectGauntletEvaluator({ envValue: "gpt", producer: AGENT_X, installed })).toThrow(/is not squad:<slug>/);
  });
});

describe("selection without the variable", () => {
  test("picks the first installed squad declaring quality.specification_conformance, skipping the producer", () => {
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed })).toEqual({
      kind: "dispatch", target: { kind: "squad", slug: "spec-judge", capabilityId: CONFORMANCE_CAPABILITY }, source: "registry",
      fallbacks: [{ from: "env", reason: "unset" }] });
    const alphabetical = [...installed].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed: alphabetical })).toMatchObject({ target: { slug: "document-factory" } });
    const documentFactoryProducer: TargetRef = { kind: "squad", slug: "document-factory", capabilityId: CONFORMANCE_CAPABILITY };
    expect(selectGauntletEvaluator({ producer: documentFactoryProducer, installed: alphabetical })).toMatchObject({ target: { slug: "spec-judge" }, source: "registry" });
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed, envValue: "   " })).toMatchObject({ source: "registry" });
  });

  test("falls back to agent-x when no installed squad qualifies and the producer is not agent-x", () => {
    for (const producer of [BUSINESS, SQUAD_PRODUCER]) {
      expect(selectGauntletEvaluator({ producer, installed: [REVIEWER] })).toEqual({
        kind: "dispatch", target: AGENT_X, source: "default",
        fallbacks: [{ from: "env", reason: "unset" }, { from: "registry", reason: "registry_no_match" }] });
    }
  });

  test("falls back to the heuristic for an agent-x producer, naming every rung it skipped", () => {
    expect(selectGauntletEvaluator({ producer: AGENT_X, installed: [] })).toEqual({
      kind: "heuristic", source: "default",
      fallbacks: [{ from: "env", reason: "unset" }, { from: "registry", reason: "registry_no_match" }, { from: "agent-x", reason: "producer_is_agent_x" }] });
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
