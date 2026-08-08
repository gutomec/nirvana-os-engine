/**
 * Tests for port-routing-metadata.ts (routing-360 Wave P) — all fixtures are
 * synthetic temp dirs (fake packs repo + fake live library). No live library,
 * no packs repo, no LLM.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { topLevelBlockSpan } from "../scripts/enrich-routing-metadata.ts";
import {
  emitRoutingBlock,
  isRicher,
  mergeRoutingValues,
  planBusinessPort,
  planClonePort,
  planSquadPort,
  runPort,
  scanWatermarkMarkers,
  shouldPort,
  upsertCapabilityField,
  type PortReport,
} from "../scripts/port-routing-metadata.ts";

const YAML = require("yaml");

// ── fixture builder ─────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const LIVE_CLONE_MANIFEST = `manifest:
  name: acme-clone
  display_name: "Acme Clone"
  version: 2.0.0

routing:
  one_liner: "Especialista em oferta — engenharia de valor com método próprio"
  domains:
    - offer design
    - desenho de oferta
    - precificação premium
  serves: >-
    Escolha este clone quando a oferta precisa de método: value equation, garantia com
    consequência e bônus contra objeção.
  not_for: >-
    Não faz design visual nem mídia paga.
  delegates_to: []
  refuses:
    - visual design
    - mídia paga
`;

const PACK_CLONE_MANIFEST = `manifest:
  name: acme-clone
  display_name: "Acme Clone"
  version: 2.0.0

artifacts:
  - path: agent/AGENT.md
    status: present

routing:
  one_liner: "Old pack one-liner"
  domains:
    - offer design
  when_to_use: >-
    Legacy pack guidance kept verbatim.
`;

const LIVE_BUSINESS_YAML = `name: acme-biz
author: "Owner <o@x>"
version: 1.0.0
description: Live description enriched with concrete facts a router can match.
produces:
- campaign-structure
- audit-report
example_briefs:
- Monta uma campanha de meta ads para minha loja de suplementos
- Build a complete Google Ads audit for my e-commerce store
- Preciso de um relatório mensal de ROAS por canal
keywords:
- meta ads
- google ads
- roas
capabilities:
- ads.meta.campaign_build
- ads.google.audit
- ads.analytics.roas_report
`;

const LIVE_BUSINESS_ROUTING = `brief_intake:
  default_employee: ads-ceo
auto_routes:
- pattern: meta ads
  route_to: ads-meta-lead
  confidence_threshold: 0.95
- pattern: google ads
  route_to: ads-google-lead
  confidence_threshold: 0.9
`;

const PACK_BUSINESS_YAML = `name: acme-biz
author: "Owner <o@x>"
version: 1.0.0
description: Old short pack description.
produces:
- campaign-structure
example_briefs: []
keywords:
- meta ads
custom_field: keep-me
`;

const PACK_BUSINESS_ROUTING = `brief_intake:
  default_employee: ads-ceo
auto_routes:
- pattern: meta ads
  route_to: ads-meta-lead
  confidence_threshold: 0.95
`;

const LIVE_SQUAD_YAML = `name: acme-squad
version: 2.0.0
description: "Live squad description that is definitely richer and longer than the pack copy's short one, with concrete deliverables listed."
keywords:
- explainer video
- vídeo explicativo
- motion design
capabilities:
  - id: video.explainer.create
    description: "Creates explainer videos."
    invoke:
      type: workflow
      ref: workflows/explainer.yaml
    keywords:
      - explainer video
      - vídeo explicativo
      - motion graphics
    example_briefs:
      - Faz um vídeo explicativo de 60 segundos do meu app
      - Create a 45s explainer for our onboarding flow
    not_for:
      - live-action filming (use video.liveaction.shoot)
  - id: video.caption.add
    description: "Adds captions."
    invoke:
      type: task
      ref: tasks/captions.md
    keywords:
      - captions
      - legendas
`;

const PACK_SQUAD_YAML = `name: acme-squad
version: 2.0.0
description: "Short pack description."
tags:
  - v5
capabilities:
  - id: video.explainer.create
    description: "Creates explainer videos."
    invoke:
      type: workflow
      ref: workflows/explainer.yaml
    keywords:
      - explainer video
    fidelity:
      status: stable
  - id: video.caption.add
    description: "Adds captions."
    invoke:
      type: task
      ref: tasks/captions.md
    keywords:
      - captions
      - legendas
      - subtitles
`;

const ORPHAN_CLONE_MANIFEST = `manifest:
  name: orphan-clone
  display_name: "Orphan"
  version: 1.0.0
`;

interface Fixture {
  repo: string;
  live: { businesses: string; squads: string; dna: string };
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "port-routing-"));
  tmpDirs.push(root);
  const repo = path.join(root, "packs");
  const live = {
    businesses: path.join(root, "live", "businesses"),
    squads: path.join(root, "live", "squads"),
    dna: path.join(root, "live", "dna"),
  };
  // live library
  write(live.dna, "acme-clone/MANIFEST.yaml", LIVE_CLONE_MANIFEST);
  write(live.businesses, "acme-biz/business.yaml", LIVE_BUSINESS_YAML);
  write(live.businesses, "acme-biz/routing.yaml", LIVE_BUSINESS_ROUTING);
  write(live.squads, "acme-squad/squad.yaml", LIVE_SQUAD_YAML);
  // packs repo
  write(repo, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml", PACK_CLONE_MANIFEST);
  write(repo, "starter-pack/businesses/acme-biz/business.yaml", PACK_BUSINESS_YAML);
  write(repo, "starter-pack/businesses/acme-biz/routing.yaml", PACK_BUSINESS_ROUTING);
  write(repo, "starter-pack/squads/acme-squad/squad.yaml", PACK_SQUAD_YAML);
  write(repo, "packs-content/testpack/mind-clones/orphan-clone/MANIFEST.yaml", ORPHAN_CLONE_MANIFEST);
  return { repo, live };
}

function run(fx: Fixture, opts: { dry?: boolean; preferPack?: boolean } = {}): PortReport {
  return runPort({
    repo: fx.repo,
    liveBusinesses: fx.live.businesses,
    liveSquads: fx.live.squads,
    liveDna: fx.live.dna,
    dry: opts.dry ?? false,
    preferPack: opts.preferPack ?? false,
  });
}

const read = (fx: Fixture, rel: string) => fs.readFileSync(path.join(fx.repo, rel), "utf8");

/** Byte-identical span of an untouched top-level key, before vs after. */
function expectBlockUnchanged(oldText: string, newText: string, key: string) {
  const before = topLevelBlockSpan(oldText, key);
  const after = topLevelBlockSpan(newText, key);
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(newText.slice(after!.start, after!.end)).toBe(oldText.slice(before!.start, before!.end));
}

// ── policy units ────────────────────────────────────────────────────────────

describe("shouldPort / isRicher", () => {
  test("live fills empty pack fields in both modes", () => {
    expect(shouldPort("live", "", { preferPack: false })).toBe(true);
    expect(shouldPort("live", undefined, { preferPack: true })).toBe(true);
    expect(shouldPort(["a"], [], { preferPack: true })).toBe(true);
  });
  test("live-wins overwrites a differing non-empty pack value; prefer-pack keeps it", () => {
    expect(shouldPort("live", "pack", { preferPack: false })).toBe(true);
    expect(shouldPort("live", "pack", { preferPack: true })).toBe(false);
  });
  test("equal values (whitespace-normalized) never rewrite", () => {
    expect(shouldPort("a  b", "a b", { preferPack: false })).toBe(false);
    expect(shouldPort(["x", "y"], ["x", "y"], { preferPack: false })).toBe(false);
  });
  test("requireRicher only overwrites when live carries more material", () => {
    expect(shouldPort(["a", "b"], ["a"], { preferPack: false, requireRicher: true })).toBe(true);
    expect(shouldPort(["a"], ["x", "y"], { preferPack: false, requireRicher: true })).toBe(false);
    expect(isRicher("longer live text", "short")).toBe(true);
    expect(isRicher("short", "longer pack text")).toBe(false);
  });
  test("empty live never ports", () => {
    expect(shouldPort("", "pack", { preferPack: false })).toBe(false);
    expect(shouldPort([], [], { preferPack: false })).toBe(false);
  });
});

describe("mergeRoutingValues + emitRoutingBlock", () => {
  test("live-wins merge keeps pack-only legacy keys and never adds empty live keys", () => {
    const pack = { one_liner: "old", domains: ["a"], when_to_use: "legacy" };
    const live = { one_liner: "new", domains: ["a", "b"], serves: "s", not_for: "n", delegates_to: [], refuses: ["r"] };
    const merged = mergeRoutingValues(pack, live, { preferPack: false });
    expect(merged.one_liner).toBe("new");
    expect(merged.domains).toEqual(["a", "b"]);
    expect(merged.when_to_use).toBe("legacy");
    expect(merged.serves).toBe("s");
    expect("delegates_to" in merged).toBe(false); // empty live, absent in pack
  });
  test("prefer-pack merge keeps non-empty pack values, still fills gaps", () => {
    const pack = { one_liner: "old", domains: ["a"] };
    const live = { one_liner: "new", domains: ["a", "b"], serves: "s" };
    const merged = mergeRoutingValues(pack, live, { preferPack: true });
    expect(merged.one_liner).toBe("old");
    expect(merged.domains).toEqual(["a"]);
    expect(merged.serves).toBe("s");
  });
  test("emitRoutingBlock is partial-tolerant and parses back to the same values", () => {
    const block = { one_liner: "x", domains: ["a", "b: c"], when_to_use: "when the offer needs method" };
    const emitted = emitRoutingBlock(block);
    const parsed = YAML.parse(emitted);
    expect(parsed.routing.one_liner).toBe("x");
    expect(parsed.routing.domains).toEqual(["a", "b: c"]);
    expect(parsed.routing.when_to_use.replace(/\s+/g, " ")).toBe("when the offer needs method");
    expect("serves" in parsed.routing).toBe(false);
    // no comment lines are ever emitted
    expect(emitted.split("\n").some((l) => l.trim().startsWith("#"))).toBe(false);
  });
});

// ── nested capability surgery ───────────────────────────────────────────────

describe("upsertCapabilityField", () => {
  test("replaces an existing field of one capability, other entries byte-identical", () => {
    const next = upsertCapabilityField(PACK_SQUAD_YAML, "video.explainer.create", "keywords", ["a", "b"]);
    expect(next).not.toBeNull();
    const doc = YAML.parse(next!);
    expect(doc.capabilities[0].keywords).toEqual(["a", "b"]);
    expect(doc.capabilities[0].fidelity).toEqual({ status: "stable" });
    // the second capability's text is byte-identical
    const secondCap = PACK_SQUAD_YAML.slice(PACK_SQUAD_YAML.indexOf("  - id: video.caption.add"));
    expect(next!.endsWith(secondCap)).toBe(true);
  });
  test("inserts a missing field at the end of the capability entry", () => {
    const next = upsertCapabilityField(PACK_SQUAD_YAML, "video.explainer.create", "not_for", ["live action"]);
    const doc = YAML.parse(next!);
    expect(doc.capabilities[0].not_for).toEqual(["live action"]);
    expect(doc.capabilities[1].not_for).toBeUndefined();
  });
  test("returns null for an unknown capability id", () => {
    expect(upsertCapabilityField(PACK_SQUAD_YAML, "no.such.cap", "keywords", ["x"])).toBeNull();
  });
});

// ── watermark self-check ────────────────────────────────────────────────────

describe("scanWatermarkMarkers", () => {
  test("detects all three marker shapes on a line alone", () => {
    const b64 = "Ab3".repeat(7) + "x"; // 22 chars
    expect(scanWatermarkMarkers(`ok\n//${b64}\n`)).toHaveLength(1);
    expect(scanWatermarkMarkers(`ok\n[//]: # (${b64})\n`)).toHaveLength(1);
    expect(scanWatermarkMarkers(`ok\n#${b64}\n`)).toHaveLength(1);
  });
  test("ordinary YAML never trips it", () => {
    expect(scanWatermarkMarkers(LIVE_BUSINESS_YAML)).toHaveLength(0);
    expect(scanWatermarkMarkers(PACK_SQUAD_YAML)).toHaveLength(0);
    expect(scanWatermarkMarkers("# a normal comment\nkey: value\n")).toHaveLength(0);
  });
});

// ── end-to-end on the synthetic fixture ─────────────────────────────────────

describe("runPort — field-level correctness (live-wins)", () => {
  test("clone routing block ported field-wise, untouched blocks byte-identical", () => {
    const fx = buildFixture();
    const before = read(fx, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml");
    const report = run(fx);
    const entry = report.ported.find((p) => p.slug === "acme-clone")!;
    expect(entry.kind).toBe("clone");
    expect(entry.fields).toContain("routing.one_liner");
    expect(entry.fields).toContain("routing.serves");
    const after = read(fx, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml");
    const doc = YAML.parse(after);
    expect(doc.routing.one_liner).toBe("Especialista em oferta — engenharia de valor com método próprio");
    expect(doc.routing.domains).toHaveLength(3);
    expect(doc.routing.refuses).toEqual(["visual design", "mídia paga"]);
    expect(doc.routing.when_to_use.replace(/\s+/g, " ")).toBe("Legacy pack guidance kept verbatim.");
    // surgical: manifest + artifacts blocks byte-identical
    expectBlockUnchanged(before, after, "manifest");
    expectBlockUnchanged(before, after, "artifacts");
    // PT-BR diacritics survive the port
    expect(after).toContain("precificação premium");
  });

  test("business fields ported; auto_routes appended additively; untouched keys byte-identical", () => {
    const fx = buildFixture();
    const beforeBiz = read(fx, "starter-pack/businesses/acme-biz/business.yaml");
    const beforeRouting = read(fx, "starter-pack/businesses/acme-biz/routing.yaml");
    const report = run(fx);
    const entry = report.ported.find((p) => p.slug === "acme-biz")!;
    expect(entry.fields).toEqual(
      expect.arrayContaining(["description", "produces", "example_briefs", "keywords", "capabilities", "auto_routes (+1)"]),
    );
    const afterBiz = read(fx, "starter-pack/businesses/acme-biz/business.yaml");
    const doc = YAML.parse(afterBiz);
    expect(doc.description.replace(/\s+/g, " ")).toBe("Live description enriched with concrete facts a router can match.");
    expect(doc.produces).toEqual(["campaign-structure", "audit-report"]);
    expect(doc.example_briefs).toHaveLength(3);
    expect(doc.keywords).toEqual(["meta ads", "google ads", "roas"]);
    expect(doc.capabilities).toEqual(["ads.meta.campaign_build", "ads.google.audit", "ads.analytics.roas_report"]);
    expect(doc.custom_field).toBe("keep-me");
    for (const key of ["name", "author", "version", "custom_field"]) {
      expectBlockUnchanged(beforeBiz, afterBiz, key);
    }
    const afterRouting = read(fx, "starter-pack/businesses/acme-biz/routing.yaml");
    const routes = YAML.parse(afterRouting).auto_routes;
    expect(routes).toHaveLength(2);
    expect(routes[1]).toEqual({ pattern: "google ads", route_to: "ads-google-lead", confidence_threshold: 0.9 });
    expectBlockUnchanged(beforeRouting, afterRouting, "brief_intake");
  });

  test("squad: richer-only rule at squad and capability level", () => {
    const fx = buildFixture();
    const before = read(fx, "starter-pack/squads/acme-squad/squad.yaml");
    const report = run(fx);
    const entry = report.ported.find((p) => p.slug === "acme-squad")!;
    expect(entry.fields).toEqual(
      expect.arrayContaining([
        "description",
        "keywords",
        "capabilities[video.explainer.create].keywords",
        "capabilities[video.explainer.create].example_briefs",
        "capabilities[video.explainer.create].not_for",
      ]),
    );
    const after = read(fx, "starter-pack/squads/acme-squad/squad.yaml");
    const doc = YAML.parse(after);
    expect(doc.description).toContain("definitely richer");
    expect(doc.keywords).toEqual(["explainer video", "vídeo explicativo", "motion design"]);
    expect(doc.capabilities[0].keywords).toHaveLength(3);
    expect(doc.capabilities[0].example_briefs).toHaveLength(2);
    expect(doc.capabilities[0].not_for).toEqual(["live-action filming (use video.liveaction.shoot)"]);
    expect(doc.capabilities[0].fidelity).toEqual({ status: "stable" });
    // pack cap keywords (3) richer than live (2) → untouched byte-identical.
    // (top-level keywords were appended at EOF, so this is a segment match)
    const capText = "  - id: video.caption.add";
    const segment = before.slice(before.indexOf(capText));
    const idx = after.indexOf(capText);
    expect(after.slice(idx, idx + segment.length)).toBe(segment);
    expectBlockUnchanged(before, after, "tags");
    expectBlockUnchanged(before, after, "name");
    expectBlockUnchanged(before, after, "version");
  });

  test("second run is a no-op (idempotent)", () => {
    const fx = buildFixture();
    run(fx);
    const snapshot = {
      clone: read(fx, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml"),
      biz: read(fx, "starter-pack/businesses/acme-biz/business.yaml"),
      routing: read(fx, "starter-pack/businesses/acme-biz/routing.yaml"),
      squad: read(fx, "starter-pack/squads/acme-squad/squad.yaml"),
    };
    const second = run(fx);
    expect(second.ported).toHaveLength(0);
    expect(read(fx, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml")).toBe(snapshot.clone);
    expect(read(fx, "starter-pack/businesses/acme-biz/business.yaml")).toBe(snapshot.biz);
    expect(read(fx, "starter-pack/businesses/acme-biz/routing.yaml")).toBe(snapshot.routing);
    expect(read(fx, "starter-pack/squads/acme-squad/squad.yaml")).toBe(snapshot.squad);
  });
});

describe("runPort — prefer-pack mode", () => {
  test("non-empty pack values stay; empty fields still filled", () => {
    const fx = buildFixture();
    const report = run(fx, { preferPack: true });
    const biz = YAML.parse(read(fx, "starter-pack/businesses/acme-biz/business.yaml"));
    expect(biz.description).toBe("Old short pack description.");
    expect(biz.produces).toEqual(["campaign-structure"]);
    expect(biz.keywords).toEqual(["meta ads"]);
    // empty pack fields are filled from live
    expect(biz.example_briefs).toHaveLength(3);
    expect(biz.capabilities).toHaveLength(3);
    const clone = YAML.parse(read(fx, "starter-pack/mind-clones/acme-clone/MANIFEST.yaml"));
    expect(clone.routing.one_liner).toBe("Old pack one-liner");
    expect(clone.routing.serves).toBeDefined();
    expect(report.prefer_pack).toBe(true);
  });
});

describe("runPort — dry mode", () => {
  test("reports would-port fields without touching any file", () => {
    const fx = buildFixture();
    const snapshots = new Map<string, string>();
    for (const rel of [
      "starter-pack/mind-clones/acme-clone/MANIFEST.yaml",
      "starter-pack/businesses/acme-biz/business.yaml",
      "starter-pack/businesses/acme-biz/routing.yaml",
      "starter-pack/squads/acme-squad/squad.yaml",
    ]) snapshots.set(rel, read(fx, rel));
    const report = run(fx, { dry: true });
    expect(report.mode).toBe("dry");
    expect(report.ported.map((p) => p.slug).sort()).toEqual(["acme-biz", "acme-clone", "acme-squad"]);
    for (const [rel, text] of snapshots) expect(read(fx, rel)).toBe(text);
  });
});

describe("runPort — watermark self-check", () => {
  test("a planted marker blocks the write and fails the run", () => {
    const fx = buildFixture();
    const rel = "starter-pack/mind-clones/acme-clone/MANIFEST.yaml";
    const planted = read(fx, rel) + "#" + "A".repeat(22) + "\n";
    fs.writeFileSync(path.join(fx.repo, rel), planted, "utf8");
    const report = run(fx);
    expect(report.watermark_violations.length).toBeGreaterThan(0);
    expect(report.ported.find((p) => p.slug === "acme-clone")).toBeUndefined();
    expect(report.errors.some((e) => e.slug === "acme-clone")).toBe(true);
    // file was never modified
    expect(read(fx, rel)).toBe(planted);
  });
});

describe("runPort — pack_only detection", () => {
  test("entities with no live match are listed with their missing metadata", () => {
    const fx = buildFixture();
    const report = run(fx, { dry: true });
    expect(report.pack_only).toHaveLength(1);
    const orphan = report.pack_only[0];
    expect(orphan.slug).toBe("orphan-clone");
    expect(orphan.kind).toBe("clone");
    expect(orphan.packs).toEqual(["packs-content/testpack"]);
    expect(orphan.missing).toContain("routing");
    // matched counts exclude the orphan
    expect(report.matched.total).toBe(3);
    expect(report.matched.unique_slugs).toBe(3);
  });
});

// ── planner-level guards ────────────────────────────────────────────────────

describe("planner guards", () => {
  test("live without routing block → clone plan is a no-op with a note", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "port-routing-"));
    tmpDirs.push(root);
    write(root, "pack/MANIFEST.yaml", PACK_CLONE_MANIFEST);
    write(root, "live/MANIFEST.yaml", ORPHAN_CLONE_MANIFEST);
    const plan = planClonePort(path.join(root, "pack"), path.join(root, "live"), { preferPack: false });
    expect(plan.writes).toHaveLength(0);
    expect(plan.notes.join(" ")).toContain("no routing block");
  });
  test("nested routing.auto_routes in the pack is never shadowed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "port-routing-"));
    tmpDirs.push(root);
    write(root, "pack/business.yaml", PACK_BUSINESS_YAML);
    write(root, "pack/routing.yaml", "routing:\n  auto_routes:\n  - pattern: old\n    route_to: emp-a\n");
    write(root, "live/business.yaml", PACK_BUSINESS_YAML); // same fields → only routes differ
    write(root, "live/routing.yaml", LIVE_BUSINESS_ROUTING);
    const plan = planBusinessPort(path.join(root, "pack"), path.join(root, "live"), { preferPack: false });
    expect(plan.fields.some((f) => f.startsWith("auto_routes"))).toBe(false);
    expect(plan.notes.join(" ")).toContain("nested routing.auto_routes");
  });
  test("identical live and pack squad → no-op", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "port-routing-"));
    tmpDirs.push(root);
    write(root, "pack/squad.yaml", LIVE_SQUAD_YAML);
    write(root, "live/squad.yaml", LIVE_SQUAD_YAML);
    const plan = planSquadPort(path.join(root, "pack"), path.join(root, "live"), { preferPack: false });
    expect(plan.writes).toHaveLength(0);
  });
});
