// End-to-end test of capability-doctor.ts catalog compliance against
// synthetic squad/business fixtures (SQUADS_DIR/BUSINESSES_DIR env overrides).
// Verifies: the three declared catalog checks, the collision table, the
// score_boost report, and the exit-code contract (0 default, 1 with --strict).

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const DOCTOR = path.resolve(import.meta.dir, "..", "scripts", "capability-doctor.ts");

function writeFixtures(): { squadsDir: string; businessesDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-"));
  const squadsDir = path.join(root, "squads");
  const businessesDir = path.join(root, "businesses");

  const squad = (slug: string, yaml: string) => {
    fs.mkdirSync(path.join(squadsDir, slug), { recursive: true });
    fs.writeFileSync(path.join(squadsDir, slug, "squad.yaml"), yaml);
  };

  squad("alpha-squad", [
    "name: alpha-squad",
    'protocol: "5.0"',
    "capabilities:",
    "  - id: media.video.compose",
    "    domains: [media]",
    "    score_boost: 1.5",
    "  - id: wizardry.spells.cast",
    "    domains: [vibes]",
    "  - id: _internal.cache.invalidate",
    "    domains: [media]",
  ].join("\n"));

  squad("beta-squad", [
    "name: beta-squad",
    'protocol: "5.0"',
    "capabilities:",
    "  - id: media.video.compose",
    "    domains: [media]",
    "    score_boost: 1.2",
  ].join("\n"));

  squad("gamma-experimental", [
    "name: gamma-experimental",
    'protocol: "5.0"',
    "experimental_domains: true",
    "capabilities:",
    "  - id: mystery.thing.execute",
    "    domains: [vibes]",
  ].join("\n"));

  fs.mkdirSync(path.join(businessesDir, "test-biz"), { recursive: true });
  fs.writeFileSync(path.join(businessesDir, "test-biz", "business.yaml"), [
    "name: test-biz",
    "domains: [marketing, nonexistent_domain_x]",
    "capabilities:",
    "  - wizardry.spells.cast",
  ].join("\n"));

  return { squadsDir, businessesDir };
}

function runDoctor(args: string[], dirs: { squadsDir: string; businessesDir: string }) {
  return spawnSync(process.execPath, [DOCTOR, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SQUADS_DIR: dirs.squadsDir,
      BUSINESSES_DIR: dirs.businessesDir,
    },
  });
}

test("capability-doctor --json reports the three catalog checks + collisions + score_boost", () => {
  const dirs = writeFixtures();
  const r = runDoctor(["--json"], dirs);
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  const cr = out.catalog_report;

  // reserved_prefix_check: violation for _internal.cache.invalidate.
  expect(cr.summary.reserved_violations).toBe(1);
  expect(cr.reserved_prefix_violations[0]).toMatchObject({
    id: "_internal.cache.invalidate",
    prefix: "_internal",
    provider: "alpha-squad",
  });

  // unknown_namespace_check: wizardry from squad + business ref; mystery
  // suppressed by experimental_domains: true.
  const nsIds = cr.unknown_namespaces.map((f: any) => f.id).sort();
  expect(nsIds).toEqual(["wizardry.spells.cast", "wizardry.spells.cast"]);
  const nsKinds = cr.unknown_namespaces.map((f: any) => f.provider_kind).sort();
  expect(nsKinds).toEqual(["business", "squad"]);
  expect(nsIds.includes("mystery.thing.execute")).toBe(false);

  // unknown_domain_check: vibes (squad cap) + nonexistent_domain_x (business);
  // gamma's vibes suppressed by the experimental escape hatch.
  const domains = cr.unknown_domains.map((f: any) => f.domain).sort();
  expect(domains).toEqual(["nonexistent_domain_x", "vibes"]);

  // Collision table: media.video.compose provided by both squads; the
  // business reference to wizardry.spells.cast is not a provider.
  expect(cr.collisions.length).toBe(1);
  expect(cr.collisions[0]).toMatchObject({
    id: "media.video.compose",
    providers: ["alpha-squad", "beta-squad"],
  });

  // score_boost: 1.5 out of effective range, 1.2 in range.
  expect(cr.score_boost_out_of_range.length).toBe(1);
  expect(cr.score_boost_out_of_range[0]).toMatchObject({
    id: "media.video.compose",
    provider: "alpha-squad",
    declared: 1.5,
    clamped: 1.3,
    note: "declared 1.5, runtime clamps to 1.3",
  });

  // 1 violation + 2 unknown-ns + 2 unknown-domain + 1 score_boost = 6.
  expect(cr.summary.strict_findings).toBe(6);
}, spawnBudgetMs(2));

test("exit-code contract: 0 by default, 1 with --strict when findings exist", () => {
  const dirs = writeFixtures();
  expect(runDoctor([], dirs).status).toBe(0);
  expect(runDoctor(["--quiet"], dirs).status).toBe(0);
  expect(runDoctor(["--strict", "--quiet"], dirs).status).toBe(1);
});

test("--strict passes on a clean tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-clean-"));
  const squadsDir = path.join(root, "squads");
  const businessesDir = path.join(root, "businesses");
  fs.mkdirSync(path.join(squadsDir, "clean-squad"), { recursive: true });
  fs.writeFileSync(path.join(squadsDir, "clean-squad", "squad.yaml"), [
    "name: clean-squad",
    'protocol: "5.0"',
    "capabilities:",
    "  - id: media.video.compose",
    "    domains: [media]",
    "    score_boost: 1.2",
  ].join("\n"));
  fs.mkdirSync(businessesDir, { recursive: true });
  const r = runDoctor(["--strict", "--quiet"], { squadsDir, businessesDir });
  expect(r.status).toBe(0);
}, spawnBudgetMs(2));
