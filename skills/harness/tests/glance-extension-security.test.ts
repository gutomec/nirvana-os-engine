import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readStableInventoriedFile } from "../lib/glance/extensions/security.ts";
import {
  createFilesystemFixture,
  denyReadAccess,
  FILESYSTEM_CAPABILITIES,
  HTML_MIME,
  JSON_MIME,
  type FilesystemFixture,
  type InventoriedFixtureFile,
} from "./helpers/glance-extension-fixtures.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function useFixture(run: (fixture: FilesystemFixture) => void): void {
  const fixture = createFilesystemFixture();
  try {
    run(fixture);
  } finally {
    fixture.cleanup();
  }
}

function inventory(path: string, bytes: Uint8Array, mime: typeof JSON_MIME | typeof HTML_MIME = JSON_MIME): InventoriedFixtureFile {
  return { path, mime, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function rejected(run: () => unknown, errors: readonly string[]): void {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(Error);
  expect(errors).toContain((observed as Error).message);
}

test("EXT-FS-VALID-INVENTORIED-FILE", () => useFixture((fixture) => {
  expect(readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected)).toEqual(fixture.content);
}));

test("EXT-FS-TRAVERSAL", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, "../external/data.json", fixture.expected)).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-WINDOWS-ABS", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, "C:\\temp\\data.json", fixture.expected)).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-POSIX-ABS", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, "/tmp/data.json", fixture.expected)).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-NUL", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, "nested/data.json\0ignored", fixture.expected)).toThrow("PATH_UNSAFE");
}));

const adsTest = FILESYSTEM_CAPABILITIES.ads.available ? test : test.skip;
adsTest("EXT-FS-ADS", () => useFixture((fixture) => {
  const adsPath = join(fixture.root, "nested", "data.json") + ":secret";
  writeFileSync(adsPath, "stream");
  expect(readFileSync(adsPath, "utf8")).toBe("stream");
  expect(() => readStableInventoriedFile(fixture.root, "nested/data.json:secret", fixture.expected)).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-UNDECLARED", () => useFixture((fixture) => {
  writeFileSync(join(fixture.root, "nested", "undeclared.json"), fixture.content);
  expect(() => readStableInventoriedFile(fixture.root, "nested/undeclared.json", fixture.expected)).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-DIRECTORY", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, "nested", { ...fixture.expected, path: "nested" })).toThrow("PATH_UNSAFE");
}));

const fileSymlinkTest = FILESYSTEM_CAPABILITIES.fileSymlink.available ? test : test.skip;
fileSymlinkTest("EXT-FS-SYMLINK", () => useFixture((fixture) => {
  const path = join(fixture.root, "nested", "link.json");
  symlinkSync(join(fixture.root, "nested", "data.json"), path, "file");
  expect(() => readStableInventoriedFile(fixture.root, "nested/link.json", { ...fixture.expected, path: "nested/link.json" })).toThrow("PATH_UNSAFE");
}));

fileSymlinkTest("EXT-FS-LINK-SEGMENT-FILE", () => useFixture((fixture) => {
  symlinkSync(join(fixture.root, "nested", "data.json"), join(fixture.root, "file-link"), "file");
  expect(() => readStableInventoriedFile(fixture.root, "file-link/child.json", { ...fixture.expected, path: "file-link/child.json" })).toThrow("PATH_UNSAFE");
}));

const directorySymlinkTest = FILESYSTEM_CAPABILITIES.directorySymlink.available ? test : test.skip;
directorySymlinkTest("EXT-FS-LINK-SEGMENT-DIRECTORY", () => useFixture((fixture) => {
  symlinkSync(join(fixture.root, "nested"), join(fixture.root, "dir-link"), "dir");
  expect(() => readStableInventoriedFile(fixture.root, "dir-link/data.json", { ...fixture.expected, path: "dir-link/data.json" })).toThrow("PATH_UNSAFE");
}));

const junctionTest = FILESYSTEM_CAPABILITIES.junction.available ? test : test.skip;
junctionTest("EXT-FS-JUNCTION", () => useFixture((fixture) => {
  symlinkSync(fixture.external, join(fixture.root, "junction"), "junction");
  const externalBytes = readFileSync(join(fixture.external, "data.json"));
  expect(() => readStableInventoriedFile(
    fixture.root,
    "junction/data.json",
    inventory("junction/data.json", externalBytes),
  )).toThrow("PATH_UNSAFE");
}));

test("EXT-FS-CASE-SIBLING", () => useFixture((fixture) => {
  const alternate = "NESTED/DATA.JSON";
  if (process.platform !== "win32") {
    mkdirSync(join(fixture.root, "NESTED"));
    writeFileSync(join(fixture.root, "NESTED", "DATA.JSON"), fixture.content);
  } else {
    expect(readFileSync(join(fixture.root, "NESTED", "DATA.JSON"))).toEqual(fixture.content);
  }
  expect(() => readStableInventoriedFile(fixture.root, alternate, fixture.expected)).toThrow("PATH_UNSAFE");
}));

const permissionTest = FILESYSTEM_CAPABILITIES.deniedFileRead.available ? test : test.skip;
permissionTest("EXT-FS-PERMISSION", () => useFixture((fixture) => {
  const target = join(fixture.root, "nested", "data.json");
  const denial = denyReadAccess(target);
  expect(denial.denied).toBe(true);
  try {
    expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected)).toThrow("PATH_UNSAFE");
  } finally {
    denial.restore();
  }
}));

test("EXT-FS-SIZE", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, {
    ...fixture.expected,
    bytes: fixture.expected.bytes + 1,
  })).toThrow("FILE_CHANGED");
}));

test("EXT-FS-MIME", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, {
    ...fixture.expected,
    mime: "text/plain; charset=utf-8" as typeof JSON_MIME,
  })).toThrow("FILE_INTEGRITY");
}));

test("EXT-FS-DIGEST", () => useFixture((fixture) => {
  expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, {
    ...fixture.expected,
    sha256: "0".repeat(64),
  })).toThrow("FILE_INTEGRITY");
}));

test("EXT-FS-WRITE-RACE", () => useFixture((fixture) => {
  const replacement = new TextEncoder().encode('{"evil":true}\n');
  rejected(() => readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected, {
    beforeRead() {
      writeFileSync(join(fixture.root, "nested", "data.json"), replacement);
    },
  }), ["FILE_CHANGED", "FILE_INTEGRITY"]);
}));

test("EXT-FS-RENAME-RACE", () => useFixture((fixture) => {
  const target = join(fixture.root, "nested", "data.json");
  const held = join(fixture.root, "nested", "held.json");
  expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected, {
    beforeRead() {
      renameSync(target, held);
      writeFileSync(target, fixture.content);
    },
  })).toThrow("FILE_CHANGED");
}));

test("EXT-FS-SWAP-BACK-RACE", () => useFixture((fixture) => {
  const target = join(fixture.root, "nested", "data.json");
  const held = join(fixture.root, "nested", "held.json");
  const hooks = {
    beforeRead() {},
    afterRead() {
      renameSync(target, held);
      writeFileSync(target, new TextEncoder().encode('{"evil":true}\n'));
      rmSync(target);
      renameSync(held, target);
    },
  };
  expect(() => readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected, hooks)).toThrow("FILE_CHANGED");
}));

const externalPermissionTest = FILESYSTEM_CAPABILITIES.deniedDirectoryRead.available ? test : test.skip;
externalPermissionTest("EXT-FS-EXTERNAL-INACCESSIBLE", () => useFixture((fixture) => {
  const denial = denyReadAccess(fixture.external, true);
  expect(denial.denied).toBe(true);
  try {
    expect(readStableInventoriedFile(fixture.root, fixture.expected.path, fixture.expected)).toEqual(fixture.content);
  } finally {
    denial.restore();
  }
}));

const fixture = createFilesystemFixture();
afterAll(() => fixture.cleanup());
test("EXT-FS-SWAP-BETWEEN-PRECHECK-AND-OPEN", () => {
  let beforeRead = false;
  expect(() => readStableInventoriedFile(fixture.root, "nested/data.json", fixture.expected, {
    beforeOpen() {
      renameSync(join(fixture.root, "nested"), join(fixture.root, "held"));
      symlinkSync(fixture.external, join(fixture.root, "nested"), process.platform === "win32" ? "junction" : "dir");
    },
    beforeRead() {
      beforeRead = true;
    },
  })).toThrow("PATH_UNSAFE");
  expect(beforeRead).toBe(false);
});

export const FILESYSTEM_CASES = [
  "EXT-FS-TRAVERSAL", "EXT-FS-WINDOWS-ABS", "EXT-FS-POSIX-ABS", "EXT-FS-NUL", "EXT-FS-ADS",
  "EXT-FS-UNDECLARED", "EXT-FS-DIRECTORY", "EXT-FS-SYMLINK", "EXT-FS-LINK-SEGMENT-FILE",
  "EXT-FS-LINK-SEGMENT-DIRECTORY", "EXT-FS-JUNCTION", "EXT-FS-CASE-SIBLING", "EXT-FS-PERMISSION",
  "EXT-FS-SIZE", "EXT-FS-MIME", "EXT-FS-DIGEST", "EXT-FS-WRITE-RACE", "EXT-FS-RENAME-RACE",
  "EXT-FS-EXTERNAL-INACCESSIBLE",
] as const;
