// license-refresh.test.ts — an update may repair the license, never downgrade it.
//
// The cross-edition case is REAL (2026-09-17): a buyer holding the Genesis
// Circle bundle ran `nrv update commerce-backoffice`. The content updated fine,
// and the license store — a SINGLE file — was replaced by the license of the
// pack that had just been downloaded, which was commerce-backoffice. From then
// on every other pack answered `pack_mismatch` to `nrv update`, and the packs
// the buyer had paid for stopped being updatable. `nrv license status` showed
// the new edition and `issued_at` matched the update to the second.
//
// Nothing in the old code could see this: it copied the file unconditionally.
// The decision is pure, so the tests below are the proof.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareVersions, decideLicenseRefresh } from "../lib/license-refresh.ts";

function withLicense(content: string | null, fn: (licPath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-lic-"));
  const licPath = path.join(dir, "PROVENANCE.json");
  if (content !== null) fs.writeFileSync(licPath, content, "utf8");
  try { fn(licPath); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const bundle = JSON.stringify({ edition: "genesis-circle", version: "0.1.85", license_key: "NRV-AAAA-AAAA-AAAA" });
const vertical = JSON.stringify({ edition: "commerce-backoffice", version: "0.1.34", license_key: "NRV-BBBB-BBBB-BBBB" });

describe("decideLicenseRefresh", () => {
  test("no license on the machine is the repair this exists for", () => {
    withLicense(null, (licPath) => {
      const d = decideLicenseRefresh(licPath, JSON.parse(vertical));
      expect(d.refresh).toBe(true);
    });
  });

  test("a bundle license survives an update of a single vertical — the 2026-09-17 case", () => {
    withLicense(bundle, (licPath) => {
      const d = decideLicenseRefresh(licPath, JSON.parse(vertical));
      expect(d.refresh).toBe(false);
      expect(d.reason).toContain("genesis-circle");
      expect(d.reason).toContain("commerce-backoffice");
      // the file is left exactly as it was
      expect(fs.readFileSync(licPath, "utf8")).toBe(bundle);
    });
  });

  test("switching editions upward is still deliberate, never automatic", () => {
    withLicense(vertical, (licPath) => {
      const d = decideLicenseRefresh(licPath, JSON.parse(bundle));
      expect(d.refresh).toBe(false);
      expect(d.reason).toContain("nrv license install");
    });
  });

  test("the same edition at a newer version is repaired", () => {
    withLicense(JSON.stringify({ edition: "web-design", version: "0.1.32", license_key: "K" }), (licPath) => {
      const d = decideLicenseRefresh(licPath, { edition: "web-design", version: "0.1.35", license_key: "K" });
      expect(d.refresh).toBe(true);
      expect(d.reason).toContain("0.1.32 → 0.1.35");
    });
  });

  test("the same edition and version has nothing to repair", () => {
    withLicense(JSON.stringify({ edition: "web-design", version: "0.1.35", license_key: "K" }), (licPath) => {
      const d = decideLicenseRefresh(licPath, { edition: "web-design", version: "0.1.35", license_key: "K" });
      expect(d.refresh).toBe(false);
      expect(d.reason).toContain("already current");
    });
  });

  test("an older artifact never rolls the license back", () => {
    withLicense(JSON.stringify({ edition: "web-design", version: "0.1.35", license_key: "K" }), (licPath) => {
      const d = decideLicenseRefresh(licPath, { edition: "web-design", version: "0.1.32", license_key: "K" });
      expect(d.refresh).toBe(false);
      expect(d.reason).toContain("already newer");
    });
  });

  test("an unreadable license is replaced rather than trusted", () => {
    withLicense("{ not json", (licPath) => {
      expect(decideLicenseRefresh(licPath, JSON.parse(vertical)).refresh).toBe(true);
    });
  });

  test("a provenance with no license_key does not count as a license", () => {
    withLicense(JSON.stringify({ edition: "genesis-circle", version: "0.1.85" }), (licPath) => {
      expect(decideLicenseRefresh(licPath, JSON.parse(vertical)).refresh).toBe(true);
    });
  });
});

describe("compareVersions", () => {
  test("dotted numbers compare numerically, not as strings", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
  });
  test("an unparsable version still yields a stable answer", () => {
    expect(compareVersions("2.0.0-rc1", "2.0.0")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0-rc1")).toBe(-1);
  });
});
