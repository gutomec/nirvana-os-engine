// windows-user-path.test.ts — the pure PATH logic behind issue #87, on every
// platform.
//
// The Windows regression test (harness/tests/windows-path-persist.test.ts)
// proves the registry does not move; it runs only where the registry exists.
// The decisions it depends on — and the detection `nrv doctor` runs and the
// removal `nrv install --repair-path` performs — are string logic with Windows
// PATH semantics: case-insensitive, `;` between entries, either separator.
// Those are asserted here with explicit roots, so a macOS or Linux run covers
// them too.
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import {
  expandEnv, findTempNrvEntries, isTempNrvEntry, isUnderRoot, isUnderTempRoot, joinPath,
  removeEntriesUnderRoot, removeTempNrvEntries, skipPathPersist, tempRoots,
} from "../lib/windows-user-path.ts";

const TEMP = "C:\\Users\\andre\\AppData\\Local\\Temp";
const ROOTS = [TEMP, "C:\\Windows\\Temp"];
const ENV = { LOCALAPPDATA: "C:\\Users\\andre\\AppData\\Local", USERPROFILE: "C:\\Users\\andre" };

describe("isUnderRoot — the guard the installer applies before persisting", () => {
  test("a fake HOME's .local\\bin under %TEMP% is under it", () => {
    expect(isUnderRoot(`${TEMP}\\nrv-buyer-abc123\\home\\.local\\bin`, TEMP)).toBe(true);
  });

  test("the root itself counts", () => {
    expect(isUnderRoot(TEMP, TEMP)).toBe(true);
    expect(isUnderRoot(`${TEMP}\\`, TEMP)).toBe(true);
  });

  test("a sibling that merely shares the prefix does not", () => {
    expect(isUnderRoot(`${TEMP}2\\nrv-x\\home\\.local\\bin`, TEMP)).toBe(false);
    expect(isUnderRoot("C:\\Users\\andre\\AppData\\Local\\Templates\\bin", TEMP)).toBe(false);
  });

  test("case and separator style do not matter, as on Windows", () => {
    expect(isUnderRoot("c:/users/ANDRE/appdata/local/temp/nrv-1/home/.local/bin", TEMP)).toBe(true);
    expect(isUnderRoot(`${TEMP}\\nrv-1\\home\\.local\\bin\\`, `${TEMP}\\\\`)).toBe(true);
  });

  test("the real user's .local\\bin is not under any temp root", () => {
    expect(isUnderTempRoot("C:\\Users\\andre\\.local\\bin", ROOTS)).toBe(false);
    expect(isUnderTempRoot("C:\\Windows\\Temp\\nrv-1\\home\\.local\\bin", ROOTS)).toBe(true);
  });

  test("an empty root never matches anything", () => {
    expect(isUnderRoot("C:\\anything", "")).toBe(false);
    expect(isUnderTempRoot("C:\\anything", [])).toBe(false);
  });
});

describe("tempRoots — every place a temporary HOME may have been created", () => {
  test("collects tmpdir, TEMP, TMP and LOCALAPPDATA\\Temp without duplicates", () => {
    const roots = tempRoots({ TEMP, TMP: TEMP.toLowerCase() + "\\", LOCALAPPDATA: ENV.LOCALAPPDATA });
    expect(roots.filter((r) => isUnderRoot(r, TEMP))).toHaveLength(1);
    expect(roots).toContain(os.tmpdir());
  });

  test("an unset or empty variable contributes nothing", () => {
    expect(tempRoots({})).toContain(os.tmpdir());
    expect(tempRoots({ TEMP: "", TMP: "" })).toEqual(tempRoots({}));
  });
});

describe("skipPathPersist — the explicit flag", () => {
  test("only the exact value 1 counts", () => {
    expect(skipPathPersist({ NIRVANA_SKIP_PATH_PERSIST: "1" })).toBe(true);
    expect(skipPathPersist({ NIRVANA_SKIP_PATH_PERSIST: "true" })).toBe(false);
    expect(skipPathPersist({})).toBe(false);
  });
});

describe("expandEnv — what a REG_EXPAND_SZ entry means", () => {
  test("expands %NAME% case-insensitively and leaves unknown names alone", () => {
    expect(expandEnv("%LocalAppData%\\Temp\\nrv-1\\home\\.local\\bin", ENV)).toBe(`${TEMP}\\nrv-1\\home\\.local\\bin`);
    expect(expandEnv("%NOPE%\\bin", ENV)).toBe("%NOPE%\\bin");
    expect(expandEnv("C:\\plain", ENV)).toBe("C:\\plain");
  });
});

describe("isTempNrvEntry — exactly what the installer wrote from a temporary HOME", () => {
  test("the entries from the issue match", () => {
    expect(isTempNrvEntry(`${TEMP}\\nrv-buyer-Ab12Cd\\home\\.local\\bin`, ROOTS, ENV)).toBe(true);
    expect(isTempNrvEntry(`${TEMP}\\nrv-update-safety-x9\\home\\.local\\bin`, ROOTS, ENV)).toBe(true);
    expect(isTempNrvEntry("%LOCALAPPDATA%\\Temp\\nrv-runtime-links-q1\\home\\.local\\bin", ROOTS, ENV)).toBe(true);
  });

  test("a temp entry without an nrv- segment is someone else's", () => {
    expect(isTempNrvEntry(`${TEMP}\\some-tool\\bin`, ROOTS, ENV)).toBe(false);
    expect(isTempNrvEntry(`${TEMP}\\install-order-abc\\bin`, ROOTS, ENV)).toBe(false);
  });

  test("an nrv- path outside every temp root is never a candidate", () => {
    expect(isTempNrvEntry("C:\\Users\\andre\\nrv-projects\\bin", ROOTS, ENV)).toBe(false);
    expect(isTempNrvEntry("C:\\Users\\andre\\.local\\bin", ROOTS, ENV)).toBe(false);
  });

  test("the temp root itself, or an nrv- segment in the root, does not count", () => {
    expect(isTempNrvEntry(TEMP, ROOTS, ENV)).toBe(false);
    expect(isTempNrvEntry("D:\\nrv-temp\\bin", ["D:\\nrv-temp"], ENV)).toBe(false);
  });
});

describe("removeTempNrvEntries — the repair, on a PATH string", () => {
  const stale1 = `${TEMP}\\nrv-buyer-A1\\home\\.local\\bin`;
  const stale2 = "%LOCALAPPDATA%\\Temp\\nrv-buyer-B2\\home\\.local\\bin";
  const value = [
    "C:\\Users\\andre\\.local\\bin", stale1, "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps",
    stale2, "", "C:\\Program Files\\Git\\cmd", `${TEMP}\\other-tool`, "",
  ].join(";");

  test("finds both spellings, in PATH order", () => {
    expect(findTempNrvEntries(value, ROOTS, ENV)).toEqual([stale1, stale2]);
  });

  test("removes exactly those and keeps everything else verbatim, order and empties included", () => {
    const { before, after, removed } = removeTempNrvEntries(value, ROOTS, ENV);
    expect(before).toHaveLength(8);
    expect(removed).toEqual([stale1, stale2]);
    expect(joinPath(after)).toBe(
      "C:\\Users\\andre\\.local\\bin;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;;C:\\Program Files\\Git\\cmd;" + `${TEMP}\\other-tool;`,
    );
  });

  test("a clean PATH comes back byte-identical", () => {
    const clean = "C:\\Users\\andre\\.local\\bin;C:\\Program Files\\Git\\cmd;";
    const { after, removed } = removeTempNrvEntries(clean, ROOTS, ENV);
    expect(removed).toEqual([]);
    expect(joinPath(after)).toBe(clean);
  });

  test("twenty-two of them go in one pass", () => {
    const many = Array.from({ length: 22 }, (_, i) => `${TEMP}\\nrv-buyer-${i}\\home\\.local\\bin`);
    const { after, removed } = removeTempNrvEntries(["C:\\keep", ...many, "C:\\also-keep"].join(";"), ROOTS, ENV);
    expect(removed).toHaveLength(22);
    expect(after).toEqual(["C:\\keep", "C:\\also-keep"]);
  });
});

describe("removeEntriesUnderRoot — the uninstall side of wireLocalBinOnPath's persist step", () => {
  const localBin = "C:\\Users\\andre\\.local\\bin";

  test("removes the already-expanded entry the installer wrote", () => {
    const value = ["C:\\Windows\\system32", localBin, "C:\\Program Files\\Git\\cmd"].join(";");
    const { after, removed } = removeEntriesUnderRoot(value, localBin, ENV);
    expect(removed).toEqual([localBin]);
    expect(joinPath(after)).toBe("C:\\Windows\\system32;C:\\Program Files\\Git\\cmd");
  });

  test("also matches a %USERPROFILE%-style entry that expands to the same root", () => {
    const value = ["C:\\Windows\\system32", "%USERPROFILE%\\.local\\bin"].join(";");
    const { after, removed } = removeEntriesUnderRoot(value, localBin, ENV);
    expect(removed).toEqual(["%USERPROFILE%\\.local\\bin"]);
    expect(after).toEqual(["C:\\Windows\\system32"]);
  });

  test("a PATH without our entry comes back byte-identical", () => {
    const clean = "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;";
    const { after, removed } = removeEntriesUnderRoot(clean, localBin, ENV);
    expect(removed).toEqual([]);
    expect(joinPath(after)).toBe(clean);
  });

  test("a sibling that merely shares the prefix is kept", () => {
    const value = [localBin + "2", "C:\\keep"].join(";");
    const { after, removed } = removeEntriesUnderRoot(value, localBin, ENV);
    expect(removed).toEqual([]);
    expect(after).toEqual([localBin + "2", "C:\\keep"]);
  });
});
