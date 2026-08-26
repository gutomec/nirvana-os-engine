// windows-user-path.test.ts — the pure PATH logic behind issue #87, on every
// platform.
//
// The Windows regression test (harness/tests/windows-path-persist.test.ts)
// proves the registry does not move; it runs only where the registry exists.
// The decisions it depends on are string logic with Windows PATH semantics —
// case-insensitive, `;` between entries, either separator — and those are
// asserted here with explicit roots, so a macOS or Linux run covers them too.
import { describe, expect, test } from "bun:test";
import { isUnderRoot, isUnderTempRoot, skipPathPersist, tempRoots } from "../lib/windows-user-path.ts";

const TEMP = "C:\\Users\\andre\\AppData\\Local\\Temp";

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
    expect(isUnderTempRoot("C:\\Users\\andre\\.local\\bin", [TEMP, "C:\\Windows\\Temp"])).toBe(false);
    expect(isUnderTempRoot("C:\\Windows\\Temp\\nrv-1\\home\\.local\\bin", [TEMP, "C:\\Windows\\Temp"])).toBe(true);
  });

  test("an empty root never matches anything", () => {
    expect(isUnderRoot("C:\\anything", "")).toBe(false);
    expect(isUnderTempRoot("C:\\anything", [])).toBe(false);
  });
});

describe("tempRoots — every place a temporary HOME may have been created", () => {
  test("collects tmpdir, TEMP, TMP and LOCALAPPDATA\\Temp without duplicates", () => {
    const roots = tempRoots({ TEMP, TMP: TEMP.toLowerCase() + "\\", LOCALAPPDATA: "C:\\Users\\andre\\AppData\\Local" });
    expect(roots.filter((r) => isUnderRoot(r, TEMP))).toHaveLength(1);
    expect(roots.some((r) => isUnderRoot(r, "C:\\Users\\andre\\AppData\\Local\\Temp"))).toBe(true);
    expect(roots.length).toBeGreaterThanOrEqual(2); // the process tmpdir plus the Windows ones
  });

  test("an unset variable contributes nothing", () => {
    expect(tempRoots({})).toHaveLength(1);
  });
});

describe("skipPathPersist — the explicit flag", () => {
  test("only the exact value 1 counts", () => {
    expect(skipPathPersist({ NIRVANA_SKIP_PATH_PERSIST: "1" })).toBe(true);
    expect(skipPathPersist({ NIRVANA_SKIP_PATH_PERSIST: "true" })).toBe(false);
    expect(skipPathPersist({})).toBe(false);
  });
});
