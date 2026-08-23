import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestManifest } from "./canonicalize.ts";
import { validateSchema, createSchemaRegistry, type JsonSchema } from "./schema-validator.ts";
import { readStableInventoriedFile } from "./security.ts";
import {
  SemanticValidationError,
  validateEnvelopeSemantics,
  validateManifestSemantics,
} from "./semantic-validator.ts";
import { parseStrictJson } from "./strict-json.ts";
import type {
  Digest,
  ExtensionErrorCode,
  GlanceExtensionCatalogV1,
  GlanceExtensionDatasetEnvelopeV1,
  GlanceExtensionManifestV1,
  GlanceExtensionPublicErrorV1,
  LoadedGlanceExtension,
} from "./types.ts";

const MANIFEST_FILE = "glance-extension.json";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_EXTENSIONS = 64;
const HOST_API_VERSION = "1.0.0";

export interface ExtensionSchemas {
  manifest: JsonSchema;
  envelope: JsonSchema;
  catalog: JsonSchema;
  publicError: JsonSchema;
  message: JsonSchema;
}

export interface ExtensionContext {
  scope: "global" | "project";
  rootDigest: Digest;
  projectRootDigest?: Digest;
  extensions: ReadonlyMap<string, LoadedGlanceExtension>;
  catalog: GlanceExtensionCatalogV1;
  schemas: ExtensionSchemas;
  registry: ReadonlyMap<string, JsonSchema>;
}

interface CachedManifest {
  rawDigest: Digest;
  record: LoadedGlanceExtension;
}

export type ManifestCache = Map<string, CachedManifest>;

export interface DiscoverExtensionOptions {
  nirvanaHome: string;
  projectRoot?: string;
  scope: "global" | "project";
  schemas: ExtensionSchemas;
  cache?: ManifestCache;
  correlationId?(): string;
  hostApiVersion?: string;
  now?: Date;
}

export function createManifestCache(): ManifestCache {
  return new Map();
}

export function loadExtensionSchemas(): ExtensionSchemas {
  const read = (name: string): JsonSchema => {
    const bytes = readFileSync(join(import.meta.dir, "schemas", name));
    return parseStrictJson(bytes) as JsonSchema;
  };
  return {
    manifest: read("glance-extension-manifest.schema.json"),
    envelope: read("glance-extension-dataset-envelope.schema.json"),
    catalog: read("glance-extension-catalog.schema.json"),
    publicError: read("glance-extension-public-error.schema.json"),
    message: read("glance-extension-message.schema.json"),
  };
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function digestPath(value: string): Digest {
  return `sha256:${createHash("sha256").update(normalizePath(value), "utf8").digest("hex")}`;
}

function canonicalOrResolved(value: string): string {
  return existsSync(value) ? realpathSync.native(value) : resolve(value);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safePublicError(
  code: ExtensionErrorCode,
  correlationId: () => string,
  extensionId?: string,
  datasetId?: string,
): GlanceExtensionPublicErrorV1 {
  const messages: Record<ExtensionErrorCode, string> = {
    COLLISION: "Extension identifier collision",
    DATASET_INVALID: "Extension dataset rejected",
    EXTENSION_INCOMPATIBLE: "Extension version is incompatible",
    EXTENSION_NOT_FOUND: "Extension resource not found",
    FILE_INTEGRITY: "Extension file integrity check failed",
    MANIFEST_INVALID: "Extension manifest rejected",
    METHOD_NOT_ALLOWED: "Method not allowed",
    PATH_UNSAFE: "Extension path rejected",
    SCOPE_MISMATCH: "Extension scope mismatch",
    UI_HANDSHAKE: "Extension UI handshake failed",
    URL_REJECTED: "External URL rejected",
  };
  const error: GlanceExtensionPublicErrorV1["error"] = {
    code,
    message: messages[code],
    retryable: false,
    correlation_id: correlationId(),
  };
  if (extensionId && /^[a-z0-9][a-z0-9-]{2,62}$/.test(extensionId)) error.extension_id = extensionId;
  if (datasetId && /^[a-z0-9][a-z0-9-]{2,62}$/.test(datasetId)) error.dataset_id = datasetId;
  return { schema_version: "1.0.0", error };
}

function catalogItem(record: LoadedGlanceExtension, status: "accepted" | "incompatible" | "rejected") {
  const manifest = record.manifest;
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.display.title,
    description: manifest.display.description,
    icon: manifest.display.icon,
    order: manifest.display.order,
    status,
    trust: { level: "local_owner" as const, basis: ["filesystem_owner"] as ["filesystem_owner"] },
    manifest_digest: record.manifest_digest,
    datasets: manifest.datasets.map((dataset) => dataset.id),
  };
}

export function buildExtensionContext(
  records: readonly LoadedGlanceExtension[],
  scope: "global" | "project",
  rootDigest: Digest,
  schemas: ExtensionSchemas,
  projectRootDigest?: Digest,
): ExtensionContext {
  if (scope === "project" && !projectRootDigest) throw new Error("SCOPE_MISMATCH");
  const extensions = new Map(records.map((record) => [record.manifest.id, record]));
  const registry = createSchemaRegistry(Object.values(schemas));
  const catalog: GlanceExtensionCatalogV1 = {
    schema_version: "1.0.0",
    extension_api_version: "1.0.0",
    scope: { kind: scope, root_digest: rootDigest },
    extensions: records.map((record) => catalogItem(record, "accepted"))
    .sort((left, right) => left.order - right.order || compareAscii(left.id, right.id)),
    diagnostics: [],
  };
  return { scope, rootDigest, projectRootDigest, extensions, catalog, schemas, registry };
}

function listDirectDirectories(root: string): Dirent[] {
  if (!existsSync(root)) return [];
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("PATH_UNSAFE");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => compareAscii(left.name, right.name));
}

function readBoundedCurrentFile(root: string, relativePath: string, maximumBytes: number, mime: "application/json; charset=utf-8" | "text/html; charset=utf-8"): Uint8Array {
  let descriptor: number | undefined;
  try {
    const rootCanonical = realpathSync.native(root);
    const target = resolve(rootCanonical, ...relativePath.split("/"));
    if (!inside(rootCanonical, target)) throw new Error("PATH_UNSAFE");
    const named = lstatSync(target);
    if (named.isSymbolicLink() || !named.isFile()) throw new Error("PATH_UNSAFE");
    if (named.size > maximumBytes) throw new Error("FILE_INTEGRITY");
    const canonicalTarget = realpathSync.native(target);
    if (!inside(rootCanonical, canonicalTarget)) throw new Error("PATH_UNSAFE");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== named.size || opened.size > maximumBytes) throw new Error("FILE_CHANGED");
    const initial = readFileSync(descriptor);
    const expected = { path: relativePath, mime, bytes: initial.byteLength, sha256: digestBytes(initial) };
    return readStableInventoriedFile(rootCanonical, relativePath, expected);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadManifest(
  extensionRoot: string,
  schemas: ExtensionSchemas,
  registry: ReadonlyMap<string, JsonSchema>,
  cache: ManifestCache,
): LoadedGlanceExtension {
  const stats = lstatSync(extensionRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("PATH_UNSAFE");
  const bytes = readBoundedCurrentFile(extensionRoot, MANIFEST_FILE, MAX_MANIFEST_BYTES, "application/json; charset=utf-8");
  const cacheKey = normalizePath(realpathSync.native(extensionRoot));
  const rawDigest = `sha256:${digestBytes(bytes)}` as Digest;
  const cached = cache.get(cacheKey);
  if (cached?.rawDigest === rawDigest) return cached.record;
  const parsed = parseStrictJson(bytes);
  validateSchema(schemas.manifest, parsed, registry);
  const manifest = parsed as GlanceExtensionManifestV1;
  const manifestDigest = digestManifest(manifest as unknown as Record<string, unknown>);
  const record: LoadedGlanceExtension = { manifest, manifest_digest: manifestDigest, absoluteRoot: extensionRoot };
  cache.set(cacheKey, { rawDigest, record });
  return record;
}

export function discoverExtensionContext(options: DiscoverExtensionOptions): ExtensionContext {
  if (options.scope === "project" && !options.projectRoot) throw new Error("SCOPE_MISMATCH");
  const selectedRoot = options.scope === "global"
    ? join(options.nirvanaHome, ".nirvana", "glance", "extensions")
    : join(options.projectRoot!, ".nirvana", "glance", "extensions");
  const canonicalRoot = canonicalOrResolved(selectedRoot);
  const rootDigest = digestPath(canonicalRoot);
  const projectRootDigest = options.scope === "project" ? digestPath(canonicalOrResolved(options.projectRoot!)) : undefined;
  const base = buildExtensionContext([], options.scope, rootDigest, options.schemas, projectRootDigest);
  const cache = options.cache ?? createManifestCache();
  const correlation = options.correlationId ?? (() => crypto.randomUUID());
  const accepted: LoadedGlanceExtension[] = [];
  const incompatible: LoadedGlanceExtension[] = [];
  const rejected: LoadedGlanceExtension[] = [];
  const diagnostics: GlanceExtensionPublicErrorV1[] = [];
  const candidates: LoadedGlanceExtension[] = [];

  let entries: Dirent[] = [];
  try {
    entries = listDirectDirectories(selectedRoot);
  } catch {
    diagnostics.push(safePublicError("PATH_UNSAFE", correlation));
  }

  for (const [index, entry] of entries.entries()) {
    if (index >= MAX_EXTENSIONS) {
      diagnostics.push(safePublicError("MANIFEST_INVALID", correlation));
      continue;
    }
    const extensionRoot = join(selectedRoot, entry.name);
    try {
      const record = loadManifest(extensionRoot, options.schemas, base.registry, cache);
      try {
        validateManifestSemantics(record.manifest, options.hostApiVersion ?? HOST_API_VERSION);
        candidates.push(record);
      } catch (error) {
        if (error instanceof SemanticValidationError && error.code === "EXT-COMPAT-RANGE") {
          incompatible.push(record);
          diagnostics.push(safePublicError("EXTENSION_INCOMPATIBLE", correlation, record.manifest.id));
        } else {
          rejected.push(record);
          diagnostics.push(safePublicError("MANIFEST_INVALID", correlation, record.manifest.id));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = message === "PATH_UNSAFE"
        ? "PATH_UNSAFE"
        : message === "FILE_INTEGRITY" || message === "FILE_CHANGED"
        ? "FILE_INTEGRITY"
        : "MANIFEST_INVALID";
      diagnostics.push(safePublicError(code, correlation));
    }
  }

  const byId = new Map<string, LoadedGlanceExtension[]>();
  for (const candidate of candidates) {
    const key = candidate.manifest.id.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const group = byId.get(key) ?? [];
    group.push(candidate);
    byId.set(key, group);
  }
  for (const group of byId.values()) {
    if (group.length === 1) accepted.push(group[0]!);
    else for (const record of group) diagnostics.push(safePublicError("COLLISION", correlation, record.manifest.id));
  }

  const context = buildExtensionContext(accepted, options.scope, rootDigest, options.schemas, projectRootDigest);
  context.catalog.extensions.push(
    ...incompatible.map((record) => catalogItem(record, "incompatible")),
    ...rejected.map((record) => catalogItem(record, "rejected")),
  );
  context.catalog.extensions.sort((left, right) => left.order - right.order || compareAscii(left.id, right.id));
  context.catalog.diagnostics = diagnostics;
  validateSchema(options.schemas.catalog, context.catalog, context.registry);
  return context;
}

function getRecord(context: ExtensionContext, extensionId: string): LoadedGlanceExtension {
  const record = context.extensions.get(extensionId);
  if (!record) throw new Error("EXTENSION_NOT_FOUND");
  return record;
}

export function readExtensionUi(context: ExtensionContext, extensionId: string): Uint8Array {
  const record = getRecord(context, extensionId);
  const expected = record.manifest.files.find((file) => file.path === record.manifest.ui.entrypoint);
  if (!expected) throw new Error("FILE_INTEGRITY");
  return readStableInventoriedFile(record.absoluteRoot, record.manifest.ui.entrypoint, expected);
}

export function readExtensionDataset(
  context: ExtensionContext,
  extensionId: string,
  datasetId: string,
  now = new Date(),
): GlanceExtensionDatasetEnvelopeV1 {
  const record = getRecord(context, extensionId);
  const dataset = record.manifest.datasets.find((candidate) => candidate.id === datasetId);
  if (!dataset) throw new Error("EXTENSION_NOT_FOUND");
  const bytes = readBoundedCurrentFile(record.absoluteRoot, dataset.path, dataset.max_bytes, "application/json; charset=utf-8");
  const parsed = parseStrictJson(bytes);
  validateSchema(context.schemas.envelope, parsed, context.registry);
  const envelope = parsed as GlanceExtensionDatasetEnvelopeV1;
  validateEnvelopeSemantics(envelope, {
    manifest: record.manifest,
    scope: context.scope,
    projectRootDigest: context.projectRootDigest,
    now,
  });
  return envelope;
}
