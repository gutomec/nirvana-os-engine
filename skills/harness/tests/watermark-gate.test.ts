// watermark-gate.test.ts — the detection that was missing when it mattered.
//
// Every paid copy carries an HMAC tag identifying its owner, embedded as a benign
// comment alone on the last line of ~60 files. `nrv update` pulls per-buyer content
// into ~/squads and ~/businesses, which is correct for a consumer and poison for an
// author: those same directories are what packs are built from, and a marker that
// rides into a base pack makes every buyer's leak attribute to the author.
//
// It happened, and it stayed invisible for a day because nothing looked. These tests
// pin the three verdicts the doctor must now produce, including the one that matters:
// FAIL on a machine that authors packs.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DOCTOR = path.join(import.meta.dir, "..", "scripts", "doctor-system.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-watermark-gate-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** A fake content library; `marked` files get a real-shaped tag on their last line. */
function library(opts: { marked?: number; clean?: number; author: boolean }): {
  squads: string; env: Record<string, string>;
} {
  const root = path.join(TMP, `case-${n++}`);
  const squads = path.join(root, "squads");
  fs.mkdirSync(squads, { recursive: true });
  for (let i = 0; i < (opts.clean ?? 1); i++) {
    fs.mkdirSync(path.join(squads, `clean-${i}`), { recursive: true });
    fs.writeFileSync(path.join(squads, `clean-${i}`, "README.md"), "# squad\n\nnothing to see.\n");
  }
  for (let i = 0; i < (opts.marked ?? 0); i++) {
    const d = path.join(squads, `marked-${i}`);
    fs.mkdirSync(d, { recursive: true });
    // 22 base64url chars alone on the last line — the exact shape watermark.ts writes.
    fs.writeFileSync(path.join(d, "SKILL.md"), `# squad\n\nbody.\n\n[//]: # (aBcDeFgHiJkLmNoPqRsTuV)\n`);
  }
  const packs = path.join(root, "packs");
  if (opts.author) fs.mkdirSync(packs, { recursive: true });
  return {
    squads,
    env: {
      ...process.env,
      SQUADS_DIR: squads,
      BUSINESSES_DIR: path.join(root, "businesses"),
      NIRVANA_PACKS_DIR: packs,
      NIRVANA_SCOPE_QUIET: "1",
    } as Record<string, string>,
  };
}

function watermarkLine(env: Record<string, string>): string {
  const r = spawnSync(process.execPath, [DOCTOR], { encoding: "utf8", env, timeout: 120_000 });
  return (r.stdout || "").split("\n").find(l => /watermark/i.test(l)) ?? "";
}

describe("watermark gate", () => {
  test("a clean library passes and says how much it checked", () => {
    const line = watermarkLine(library({ clean: 3, author: true }).env);
    expect(line).toContain("✓");
    expect(line).toContain("clean");
  });

  test("THE INCIDENT: a marker on a pack-authoring machine FAILS", () => {
    // This is the case that shipped undetected. The author builds packs from this
    // library, so a marker here would attribute every buyer's copy to the author.
    const line = watermarkLine(library({ marked: 2, clean: 1, author: true }).env);
    expect(line).toContain("✗");
    expect(line).toContain("2 per-buyer marker");
    // The hint must NOT hand a runnable command to whoever reads this line:
    // on 2026-08-23 an agent read it in `nrv doctor` output and ran the strip
    // against the live library, erasing 59 attribution tags.
    expect(line).not.toContain("strip-base-watermarks");
    expect(line).toContain("never ~/squads");
  });

  test("the same marker on a buyer machine is a WARN, not a failure", () => {
    // A buyer's installed content is SUPPOSED to be watermarked. Failing there would
    // train people to ignore the check — which is how a real alarm gets lost.
    const line = watermarkLine(library({ marked: 2, author: false }).env);
    expect(line).toContain("⚠");
    expect(line).toContain("normal for installed paid content");
  });

  test("a 22-char string that is NOT alone on a line is not a marker", () => {
    // Prose and code mention such strings; only a line that is nothing but the tag
    // counts, which is what watermark.ts writes.
    const lib = library({ clean: 0, author: true });
    const d = path.join(lib.squads, "prosey");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "README.md"), "the id aBcDeFgHiJkLmNoPqRsTuV appears inline here.\n");
    expect(watermarkLine(lib.env)).toContain("✓");
  });

  test("no content library at all is not a failure", () => {
    const root = path.join(TMP, "empty-machine");
    fs.mkdirSync(root, { recursive: true });
    const line = watermarkLine({
      ...process.env, SQUADS_DIR: path.join(root, "nope"), BUSINESSES_DIR: path.join(root, "nada"),
      NIRVANA_PACKS_DIR: root, NIRVANA_SCOPE_QUIET: "1",
    } as Record<string, string>);
    expect(line).toContain("✓");
  });
});
