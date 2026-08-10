// Unit tests for the catalog-compliance checks (catalog-checks.ts):
// reserved_prefix_check, unknown_namespace_check, unknown_domain_check,
// capability-id collision detection and score_boost effective-range report.
// All fixtures are synthetic — no real squad content is copied.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadCatalog,
  checkUnknownNamespaces,
  checkUnknownDomains,
  checkReservedPrefixes,
  findCollisions,
  checkScoreBoost,
  namespaceOf,
  SCORE_BOOST_EFFECTIVE_RANGE,
  type CatalogData,
  type CapabilityRecord,
  type DomainRow,
} from "../lib/catalog-checks.ts";

const CATALOG: CatalogData = {
  version: "9.9.9",
  namespaces: new Set(["media", "marketing"]),
  domains: new Set(["media", "marketing", "video"]),
  reserved_prefixes: new Set(["_internal", "core"]),
};

function cap(over: Partial<CapabilityRecord>): CapabilityRecord {
  return {
    id: "media.video.compose",
    provider: "alpha-squad",
    provider_kind: "squad",
    domains: [],
    experimental: false,
    ...over,
  };
}

// ── loadCatalog ──

test("loadCatalog parses namespaces, domains and reserved prefixes from YAML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-catalog-"));
  const file = path.join(dir, "catalog.yaml");
  fs.writeFileSync(file, [
    'version: "9.9.9"',
    "domains:",
    "  - id: media",
    "  - id: video",
    "namespaces:",
    "  - prefix: media",
    "    parent_domain: media",
    "reserved_prefixes: [_internal, core]",
  ].join("\n"));
  const c = loadCatalog(file);
  expect(c.version).toBe("9.9.9");
  expect([...c.namespaces]).toEqual(["media"]);
  expect(c.domains.has("video")).toBe(true);
  expect(c.reserved_prefixes.has("core")).toBe(true);
});

test("namespaceOf returns the first id segment", () => {
  expect(namespaceOf("media.video.compose")).toBe("media");
  expect(namespaceOf("general.thing.execute")).toBe("general");
});

// ── unknown_namespace_check ──

test("unknown namespace is warned; catalog namespace is not", () => {
  const findings = checkUnknownNamespaces([
    cap({ id: "media.video.compose" }),
    cap({ id: "wizardry.spells.cast" }),
  ], CATALOG);
  expect(findings.length).toBe(1);
  expect(findings[0].prefix).toBe("wizardry");
  expect(findings[0].id).toBe("wizardry.spells.cast");
});

test("experimental_domains: true suppresses the unknown-namespace warning", () => {
  const findings = checkUnknownNamespaces([
    cap({ id: "wizardry.spells.cast", experimental: true }),
  ], CATALOG);
  expect(findings.length).toBe(0);
});

test("reserved prefixes are excluded from the unknown-namespace warning (reported as violations)", () => {
  const findings = checkUnknownNamespaces([
    cap({ id: "_internal.cache.invalidate" }),
  ], CATALOG);
  expect(findings.length).toBe(0);
});

// ── reserved_prefix_check ──

test("reserved prefix is a violation, even with experimental_domains: true", () => {
  const findings = checkReservedPrefixes([
    cap({ id: "_internal.cache.invalidate" }),
    cap({ id: "core.protocol.mutate", experimental: true }),
    cap({ id: "media.video.compose" }),
  ], CATALOG);
  expect(findings.map((f) => f.prefix).sort()).toEqual(["_internal", "core"]);
});

// ── unknown_domain_check ──

function domainRow(over: Partial<DomainRow>): DomainRow {
  return { provider: "alpha-squad", provider_kind: "squad", domain: "media", experimental: false, ...over };
}

test("unknown domain is warned; catalog domain is not", () => {
  const findings = checkUnknownDomains([
    domainRow({ domain: "media" }),
    domainRow({ domain: "vibes", capability_id: "wizardry.spells.cast" }),
    domainRow({ domain: "quantum_feelings", provider: "some-biz", provider_kind: "business" }),
  ], CATALOG);
  expect(findings.length).toBe(2);
  expect(findings[0].domain).toBe("vibes");
  expect(findings[0].capability_id).toBe("wizardry.spells.cast");
  expect(findings[1].provider_kind).toBe("business");
});

test("experimental_domains: true suppresses the unknown-domain warning", () => {
  const findings = checkUnknownDomains([
    domainRow({ domain: "vibes", experimental: true }),
  ], CATALOG);
  expect(findings.length).toBe(0);
});

// ── collision detection ──

test("2+ distinct squad providers on the same id is a collision", () => {
  const findings = findCollisions([
    cap({ id: "media.video.compose", provider: "alpha-squad" }),
    cap({ id: "media.video.compose", provider: "beta-squad" }),
    cap({ id: "marketing.campaign.launch", provider: "alpha-squad" }),
  ]);
  expect(findings.length).toBe(1);
  expect(findings[0].id).toBe("media.video.compose");
  expect(findings[0].providers).toEqual(["alpha-squad", "beta-squad"]);
});

test("business references never count as providers; duplicate records from one squad do not collide", () => {
  const findings = findCollisions([
    cap({ id: "media.video.compose", provider: "alpha-squad" }),
    cap({ id: "media.video.compose", provider: "some-biz", provider_kind: "business" }),
    cap({ id: "marketing.campaign.launch", provider: "alpha-squad" }),
    cap({ id: "marketing.campaign.launch", provider: "alpha-squad" }),
  ]);
  expect(findings.length).toBe(0);
});

test("collisions sort by provider count descending", () => {
  const findings = findCollisions([
    cap({ id: "media.video.compose", provider: "a" }),
    cap({ id: "media.video.compose", provider: "b" }),
    cap({ id: "media.video.compose", provider: "c" }),
    cap({ id: "marketing.campaign.launch", provider: "a" }),
    cap({ id: "marketing.campaign.launch", provider: "b" }),
  ]);
  expect(findings.map((f) => f.id)).toEqual(["media.video.compose", "marketing.campaign.launch"]);
  expect(findings[0].providers.length).toBe(3);
});

// ── score_boost effective range ──

test("score_boost outside [1.0, 1.3] is reported with the runtime-clamped value", () => {
  const findings = checkScoreBoost([
    cap({ id: "media.a.run", score_boost: 1.5 }),
    cap({ id: "media.b.run", score_boost: 0.9 }),
    cap({ id: "media.c.run", score_boost: 2 }),
  ]);
  expect(findings.length).toBe(3);
  expect(findings[0]).toMatchObject({ declared: 1.5, clamped: 1.3 });
  expect(findings[1]).toMatchObject({ declared: 0.9, clamped: 1.0 });
  expect(findings[2]).toMatchObject({ declared: 2, clamped: 1.3 });
});

test("score_boost inside the range or absent is not reported", () => {
  const findings = checkScoreBoost([
    cap({ id: "media.a.run", score_boost: 1.0 }),
    cap({ id: "media.b.run", score_boost: 1.3 }),
    cap({ id: "media.c.run", score_boost: 1.15 }),
    cap({ id: "media.d.run" }),
  ]);
  expect(findings.length).toBe(0);
});

test("effective range matches the runtime clamp window", () => {
  expect(SCORE_BOOST_EFFECTIVE_RANGE.min).toBe(1.0);
  expect(SCORE_BOOST_EFFECTIVE_RANGE.max).toBe(1.3);
});
