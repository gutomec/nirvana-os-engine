import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const JSON_MIME = "application/json; charset=utf-8" as const;
export const HTML_MIME = "text/html; charset=utf-8" as const;

export interface InventoriedFixtureFile {
  path: string;
  mime: typeof JSON_MIME | typeof HTML_MIME;
  bytes: number;
  sha256: string;
}

export interface FilesystemFixture {
  sandbox: string;
  root: string;
  external: string;
  content: Uint8Array;
  expected: InventoriedFixtureFile;
  cleanup(): void;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function createFilesystemFixture(): FilesystemFixture {
  const sandbox = mkdtempSync(join(tmpdir(), "glance-extension-fs-"));
  const root = join(sandbox, "ExtensionRoot");
  const external = join(sandbox, "external");
  const content = new TextEncoder().encode('{"safe":true}\n');
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(join(root, "nested", "data.json"), content);
  writeFileSync(join(external, "data.json"), new TextEncoder().encode('{"evil":true}\n'));
  return {
    sandbox,
    root,
    external,
    content,
    expected: {
      path: "nested/data.json",
      mime: JSON_MIME,
      bytes: content.byteLength,
      sha256: digest(content),
    },
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

interface AccessDenial {
  denied: boolean;
  reason?: string;
  restore(): void;
}

export function denyReadAccess(target: string, directory = false): AccessDenial {
  if (process.platform === "win32") {
    const result = Bun.spawnSync(["icacls", target, "/inheritance:r", "/deny", "*S-1-1-0:(RX)"]);
    if (result.exitCode !== 0) {
      return { denied: false, reason: `icacls exit ${result.exitCode}`, restore() {} };
    }
    const restore = () => {
      const reset = Bun.spawnSync(["icacls", target, "/reset", "/T"]);
      if (reset.exitCode !== 0) throw new Error(`ACL_RESET_FAILED:${reset.exitCode}`);
    };
    try {
      if (directory) readdirSync(target);
      else readFileSync(target);
      restore();
      return { denied: false, reason: "Windows filesystem did not enforce the deny ACE", restore() {} };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") {
        restore();
        return { denied: false, reason: `unexpected denial result: ${code ?? "unknown"}`, restore() {} };
      }
      return { denied: true, restore };
    }
  }

  const mode = directory ? 0o700 : 0o600;
  chmodSync(target, 0o000);
  const restore = () => chmodSync(target, mode);
  try {
    if (directory) readdirSync(target);
    else readFileSync(target);
    restore();
    return { denied: false, reason: "current user can bypass mode 000", restore() {} };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      restore();
      return { denied: false, reason: `unexpected denial result: ${code ?? "unknown"}`, restore() {} };
    }
    return { denied: true, restore };
  }
}

function probeLink(type: "file" | "dir" | "junction"): { available: boolean; reason?: string } {
  const sandbox = mkdtempSync(join(tmpdir(), `glance-extension-${type}-probe-`));
  const target = join(sandbox, "target");
  const link = join(sandbox, "link");
  try {
    if (type === "file") writeFileSync(target, "probe");
    else mkdirSync(target);
    symlinkSync(target, link, type);
    return { available: existsSync(link) };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    return { available: false, reason: `${typed.code ?? "unknown"}: ${typed.message}` };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function probeAds(): { available: boolean; reason?: string } {
  if (process.platform !== "win32") return { available: true };
  const sandbox = mkdtempSync(join(tmpdir(), "glance-extension-ads-probe-"));
  const target = join(sandbox, "target.txt");
  try {
    writeFileSync(target, "base");
    writeFileSync(`${target}:probe`, "stream");
    return { available: readFileSync(`${target}:probe`, "utf8") === "stream" };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    return { available: false, reason: `${typed.code ?? "unknown"}: ${typed.message}` };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function probeDeniedRead(directory: boolean): { available: boolean; reason?: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "glance-extension-permission-probe-"));
  const target = directory ? join(sandbox, "blocked") : join(sandbox, "blocked.txt");
  try {
    if (directory) {
      mkdirSync(target);
      writeFileSync(join(target, "child.txt"), "probe");
    } else {
      writeFileSync(target, "probe");
    }
    const denial = denyReadAccess(target, directory);
    try {
      return { available: denial.denied, reason: denial.reason };
    } finally {
      denial.restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export const FILESYSTEM_CAPABILITIES = {
  fileSymlink: probeLink("file"),
  directorySymlink: probeLink("dir"),
  junction: process.platform === "win32"
    ? probeLink("junction")
    : { available: false, reason: "junctions are Windows-only" },
  ads: probeAds(),
  deniedFileRead: probeDeniedRead(false),
  deniedDirectoryRead: probeDeniedRead(true),
} as const;
