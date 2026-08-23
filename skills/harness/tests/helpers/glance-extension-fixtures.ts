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
import {
  digestPayload,
  digestSnapshot,
  digestSource,
} from "../../lib/glance/extensions/canonicalize.ts";
import type {
  GlanceExtensionDatasetEnvelopeV1,
  GlanceExtensionManifestV1,
  LoadedGlanceExtension,
} from "../../lib/glance/extensions/types.ts";
import type { ExtensionSchemas } from "../../lib/glance/extensions/loader.ts";

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

const SCHEMA_DIR = join(import.meta.dir, "../../lib/glance/extensions/schemas");
const readSchema = (name: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));

export const SCHEMAS: ExtensionSchemas = {
  manifest: readSchema("glance-extension-manifest.schema.json"),
  envelope: readSchema("glance-extension-dataset-envelope.schema.json"),
  catalog: readSchema("glance-extension-catalog.schema.json"),
  publicError: readSchema("glance-extension-public-error.schema.json"),
  message: readSchema("glance-extension-message.schema.json"),
};

export const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const;
export const UI_BYTES = new TextEncoder().encode(
  "<!doctype html>\n<meta charset=\"utf-8\">\n<title>Fixture extension</title>\n",
);

export function validManifest(id = "fixture-ext", order = 200): GlanceExtensionManifestV1 {
  return {
    schema_version: "1.0.0",
    id,
    version: "1.0.0",
    display: {
      title: `Fixture ${id}`,
      description: `Fixture extension ${id}`,
      icon: "activity",
      order,
    },
    compatibility: { minimum: "1.0.0", maximum_tested: "1.0.0" },
    ui: { entrypoint: "ui/index.html", sandbox: "allow-scripts", theme_contract: "glance.ui.tokens.v1" },
    datasets: [{
      id: "snapshot",
      path: "data/snapshot.snapshot.json",
      envelope_schema: "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
      payload_schema: { id: "fixture.payload", version: "1.0.0", digest: ZERO_DIGEST },
      max_bytes: 4096,
      refresh: "on-request",
    }],
    files: [{
      path: "ui/index.html",
      mime: HTML_MIME,
      bytes: UI_BYTES.byteLength,
      sha256: digest(UI_BYTES),
    }],
    capabilities: ["read_snapshot"],
    provenance: {
      publisher_id: "spec-fixture",
      build_id: "task4-fixture",
      built_at: "2026-08-22T12:00:00Z",
      source_ref: "offline-task4-fixture",
    },
    external_navigation: { mode: "host-mediated", allowed_hosts: ["github.com"] },
  } as GlanceExtensionManifestV1;
}

export function validEnvelope(
  extensionId = "fixture-ext",
  scope: "global" | "project" = "global",
  projectRootDigest?: `sha256:${string}`,
): GlanceExtensionDatasetEnvelopeV1 {
  const envelope = {
    schema_version: "1.0.0",
    extension_id: extensionId,
    dataset_id: "snapshot",
    generated_at: "2026-08-22T12:05:00Z",
    status: "pass",
    scope: scope === "project"
      ? { kind: "project", project_root_digest: projectRootDigest }
      : { kind: "global" },
    subject: { type: "repository", id: "fixture", digest: ZERO_DIGEST },
    source: {
      kind: "local_file",
      label: "offline fixture",
      digest: ZERO_DIGEST,
      artifacts: [{ id: "manifest", digest: ZERO_DIGEST }],
    },
    freshness: {
      observed_at: "2026-08-22T12:00:00Z",
      max_age_seconds: 31_536_000,
      state: "fresh",
    },
    payload_schema: { id: "fixture.payload", version: "1.0.0", digest: ZERO_DIGEST },
    evidence_refs: [{ id: "manifest", kind: "digest", ref: ZERO_DIGEST, digest: ZERO_DIGEST }],
    integrity: { algorithm: "sha256", payload_digest: ZERO_DIGEST },
    payload: { records: [] },
  } as unknown as GlanceExtensionDatasetEnvelopeV1;
  envelope.source.digest = digestSource(envelope.source);
  envelope.integrity.payload_digest = digestPayload(envelope.payload);
  envelope.snapshot_id = digestSnapshot(envelope as unknown as Record<string, unknown>);
  return envelope;
}

export const validRecord: LoadedGlanceExtension = {
  manifest: validManifest(),
  manifest_digest: `sha256:${"a".repeat(64)}`,
  absoluteRoot: "",
};

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
