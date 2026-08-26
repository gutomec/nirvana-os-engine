import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExtensionContext,
  createManifestCache,
  discoverExtensionContext,
  readExtensionDataset,
  readExtensionUi,
  type ExtensionContext,
} from "../lib/glance/extensions/loader.ts";
import {
  createRouteContext,
  handleExtensionRoute,
} from "../lib/glance/extensions/routes.ts";
import { digestCanonicalJson, digestManifest } from "../lib/glance/extensions/canonicalize.ts";
import { validateSchema } from "../lib/glance/extensions/schema-validator.ts";
import type {
  GlanceExtensionDatasetEnvelopeV1,
  GlanceExtensionManifestV1,
  LoadedGlanceExtension,
} from "../lib/glance/extensions/types.ts";
import {
  SCHEMAS,
  UI_BYTES,
  validEnvelope,
  validManifest,
  validRecord,
  ZERO_DIGEST,
} from "./helpers/glance-extension-fixtures.ts";
import { startGlanceProcess } from "./helpers/glance-extension-host-harness.ts";

const sandbox = mkdtempSync(join(tmpdir(), "glance-extension-loader-routes-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const correlationId = () => "11111111-1111-4111-8111-111111111111";

interface Roots {
  home: string;
  project: string;
  global: string;
  local: string;
}

function roots(label: string): Roots {
  const base = join(sandbox, label);
  const home = join(base, "home");
  const project = join(base, "project");
  return {
    home,
    project,
    global: join(home, ".nirvana", "glance", "extensions"),
    local: join(project, ".nirvana", "glance", "extensions"),
  };
}

function writeJson(path: string, value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

function writeExtension(
  root: string,
  manifest: GlanceExtensionManifestV1 = validManifest(),
  envelope: GlanceExtensionDatasetEnvelopeV1 = validEnvelope(manifest.id),
  ui = UI_BYTES,
): string {
  const extensionRoot = join(root, `${manifest.id}-${crypto.randomUUID()}`);
  mkdirSync(join(extensionRoot, "ui"), { recursive: true });
  mkdirSync(join(extensionRoot, "data"), { recursive: true });
  writeJson(join(extensionRoot, "glance-extension.json"), manifest);
  writeFileSync(join(extensionRoot, "ui", "index.html"), ui);
  writeJson(join(extensionRoot, "data", "snapshot.snapshot.json"), envelope);
  return extensionRoot;
}

function discover(
  value: Roots,
  scope: "global" | "project",
  cache = createManifestCache(),
): ExtensionContext {
  return discoverExtensionContext({
    nirvanaHome: value.home,
    projectRoot: value.project,
    scope,
    schemas: SCHEMAS,
    cache,
    correlationId,
    now: new Date("2026-08-22T12:30:00Z"),
  });
}

function candidate(): LoadedGlanceExtension {
  const manifest = validManifest();
  return {
    ...validRecord,
    manifest,
    manifest_digest: digestManifest(manifest as unknown as Record<string, unknown>),
  };
}

function directContext(record = candidate()): ExtensionContext {
  return buildExtensionContext([record], "global", ZERO_DIGEST, SCHEMAS, undefined);
}

function directRoutes(record = candidate()) {
  const extension = directContext(record);
  return createRouteContext(
    extension,
    correlationId,
    (extensionId, datasetId) => readExtensionDataset(extension, extensionId, datasetId, new Date("2026-08-22T12:30:00Z")),
    (extensionId) => readExtensionUi(extension, extensionId),
  );
}

async function body(response: Response | undefined): Promise<any> {
  expect(response).toBeInstanceOf(Response);
  return await response!.json();
}

test("EXT-LOADER-ABSENT-ROOT returns a schema-valid empty catalog", () => {
  const context = discover(roots("absent"), "global");
  expect(context.catalog.extensions).toEqual([]);
  expect(context.catalog.diagnostics).toEqual([]);
  expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
});

test("EXT-LOADER-GLOBAL-ONLY never merges the project root", () => {
  const value = roots("global-only");
  writeExtension(value.global, validManifest("global-ext"), validEnvelope("global-ext"));
  writeExtension(value.local, validManifest("project-ext"), validEnvelope("project-ext", "project", digestCanonicalJson(value.project)));
  const context = discover(value, "global");
  expect([...context.extensions.keys()]).toEqual(["global-ext"]);
  expect(context.scope).toBe("global");
});

test("EXT-LOADER-PROJECT-ONLY never falls back to the global root", () => {
  const value = roots("project-only");
  writeExtension(value.global, validManifest("global-ext"), validEnvelope("global-ext"));
  const projectDigest = digestCanonicalJson(value.project);
  writeExtension(value.local, validManifest("project-ext"), validEnvelope("project-ext", "project", projectDigest));
  const context = discover(value, "project");
  expect([...context.extensions.keys()]).toEqual(["project-ext"]);
  expect(context.projectRootDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(context.scope).toBe("project");
});

test("EXT-LOADER-COLLISION-BOTH rejects every active-root participant", () => {
  const value = roots("collision");
  writeExtension(value.global, validManifest("same-ext"), validEnvelope("same-ext"));
  writeExtension(value.global, validManifest("same-ext"), validEnvelope("same-ext"));
  writeExtension(value.local, validManifest("same-ext"), validEnvelope("same-ext", "project", digestCanonicalJson(value.project)));
  const context = discover(value, "global");
  expect(context.extensions.size).toBe(0);
  expect(context.catalog.diagnostics.map((item) => item.error.code)).toEqual(["COLLISION", "COLLISION"]);
  expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
});

test("EXT-LOADER-LIMIT-65 isolates the deterministic excess extension", () => {
  const value = roots("limit-65");
  for (let index = 0; index < 65; index++) {
    const id = `ext-${String(index).padStart(3, "0")}`;
    writeExtension(value.global, validManifest(id, 200), validEnvelope(id));
  }
  const context = discover(value, "global");
  expect(context.extensions.size).toBe(64);
  expect(context.catalog.diagnostics).toHaveLength(1);
  expect(context.catalog.diagnostics[0]?.error.code).toBe("MANIFEST_INVALID");
  expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
});

for (const count of [64, 65, 257] as const) {
  test(`EXT-LOADER-DIAGNOSTIC-LIMIT-${count} returns a deterministic schema-valid catalog`, () => {
    const value = roots(`diagnostic-limit-${count}`);
    for (let index = 0; index < count; index++) {
      mkdirSync(join(value.global, `invalid-${String(index).padStart(3, "0")}`), { recursive: true });
    }
    let correlationCalls = 0;
    const context = discoverExtensionContext({
      nirvanaHome: value.home,
      projectRoot: value.project,
      scope: "global",
      schemas: SCHEMAS,
      correlationId: () => {
        correlationCalls += 1;
        return `00000000-0000-4000-8000-${String(correlationCalls).padStart(12, "0")}`;
      },
      now: new Date("2026-08-22T12:30:00Z"),
    });

    expect(context.extensions.size).toBe(0);
    expect(context.catalog.extensions).toEqual([]);
    expect(context.catalog.diagnostics).toHaveLength(64);
    expect(context.catalog.diagnostics.every((item) => item.error.code === "MANIFEST_INVALID")).toBe(true);
    expect(correlationCalls).toBe(count === 64 ? 64 : 65);
    expect(context.catalog.diagnostics.map((item) => item.error.correlation_id)).toEqual(
      count === 64
        ? Array.from({ length: 64 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
        : [
            ...Array.from({ length: 63 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
            "00000000-0000-4000-8000-000000000065",
          ],
    );
    expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
  });
}

test("EXT-LOADER-INCOMPATIBLE remains diagnostic and does not load", () => {
  const value = roots("incompatible");
  const manifest = validManifest("future-ext");
  manifest.compatibility = { minimum: "2.0.0", maximum_tested: "2.0.0" };
  writeExtension(value.global, manifest, validEnvelope("future-ext"));
  const context = discover(value, "global");
  expect(context.extensions.size).toBe(0);
  expect(context.catalog.extensions).toMatchObject([{ id: "future-ext", status: "incompatible" }]);
  expect(context.catalog.diagnostics[0]?.error.code).toBe("EXTENSION_INCOMPATIBLE");
});

test("EXT-LOADER-INVALID-ISOLATION keeps a valid sibling available", () => {
  const value = roots("invalid-isolation");
  writeExtension(value.global, validManifest("valid-ext"), validEnvelope("valid-ext"));
  const invalidRoot = join(value.global, "invalid-ext");
  mkdirSync(invalidRoot, { recursive: true });
  writeFileSync(join(invalidRoot, "glance-extension.json"), "{ invalid\n");
  const context = discover(value, "global");
  expect([...context.extensions.keys()]).toEqual(["valid-ext"]);
  expect(context.catalog.diagnostics[0]?.error.code).toBe("MANIFEST_INVALID");
});

test("EXT-LOADER-MANIFEST-SCHEMA rejects closed-schema drift", () => {
  const value = roots("manifest-schema");
  const manifest = { ...validManifest("closed-ext"), unknown: true } as unknown as GlanceExtensionManifestV1;
  writeExtension(value.global, manifest, validEnvelope("closed-ext"));
  const context = discover(value, "global");
  expect(context.extensions.size).toBe(0);
  expect(context.catalog.diagnostics[0]?.error.code).toBe("MANIFEST_INVALID");
});

test("EXT-LOADER-MANIFEST-SEMANTICS distinguishes rejection from compatibility", () => {
  const value = roots("manifest-semantics");
  writeExtension(value.global, validManifest("agents"), validEnvelope("agents"));
  const context = discover(value, "global");
  expect(context.extensions.size).toBe(0);
  expect(context.catalog.extensions).toMatchObject([{ id: "agents", status: "rejected" }]);
  expect(context.catalog.diagnostics[0]?.error.code).toBe("MANIFEST_INVALID");
  expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
});

test("EXT-LOADER-CATALOG-ORDER is deterministic by order then ASCII id", () => {
  const value = roots("catalog-order");
  writeExtension(value.global, validManifest("a-ext", 100), validEnvelope("a-ext"));
  writeExtension(value.global, validManifest("a0-ext", 100), validEnvelope("a0-ext"));
  writeExtension(value.global, validManifest("alpha-ext", 100), validEnvelope("alpha-ext"));
  writeExtension(value.global, validManifest("middle-ext", 300), validEnvelope("middle-ext"));
  const context = discover(value, "global");
  expect(context.catalog.extensions.map((item) => item.id)).toEqual(["a-ext", "a0-ext", "alpha-ext", "middle-ext"]);
  expect(validateSchema(SCHEMAS.catalog, context.catalog, context.registry)).toBe(true);
});

test("EXT-LOADER-CACHE-DIGEST invalidates a manifest only when its digest changes", () => {
  const value = roots("cache-digest");
  const cache = createManifestCache();
  const extensionRoot = writeExtension(value.global, validManifest("cached-ext"), validEnvelope("cached-ext"));
  const first = discover(value, "global", cache);
  const firstDigest = first.catalog.extensions[0]?.manifest_digest;
  expect(cache.size).toBe(1);
  const changed = validManifest("cached-ext");
  changed.display.title = "Changed title";
  writeJson(join(extensionRoot, "glance-extension.json"), changed);
  const second = discover(value, "global", cache);
  expect(second.catalog.extensions[0]?.title).toBe("Changed title");
  expect(second.catalog.extensions[0]?.manifest_digest).not.toBe(firstDigest);
  expect(cache.size).toBe(1);
});

function discoveredRouteFixture(label: string): { context: ExtensionContext; routes: ReturnType<typeof createRouteContext>; root: string } {
  const value = roots(label);
  const root = writeExtension(value.global);
  const context = discover(value, "global");
  const routes = createRouteContext(
    context,
    correlationId,
    (extensionId, datasetId) => readExtensionDataset(context, extensionId, datasetId, new Date("2026-08-22T12:30:00Z")),
    (extensionId) => readExtensionUi(context, extensionId),
  );
  return { context, routes, root };
}

test("EXT-HTTP-CATALOG serves the deterministic public catalog", async () => {
  const { routes } = discoveredRouteFixture("http-catalog");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions"), routes);
  expect(response?.status).toBe(200);
  expect((await body(response)).extensions[0].id).toBe("fixture-ext");
});

test("EXT-HTTP-CATALOG-SCHEMA validates through the route registry", async () => {
  const { routes } = discoveredRouteFixture("http-catalog-schema");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions"), routes);
  expect(validateSchema(SCHEMAS.catalog, await body(response), routes.registry)).toBe(true);
});

test("EXT-HTTP-METADATA percent-decodes an id exactly once", async () => {
  const { routes } = discoveredRouteFixture("http-metadata");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture%2dext"), routes);
  expect(response?.status).toBe(200);
  expect(await body(response)).toMatchObject({
    id: "fixture-ext",
    status: "accepted",
    external_navigation: { mode: "host-mediated", allowed_hosts: ["github.com"] },
  });
});

test("EXT-HTTP-UI serves only the inventoried document", async () => {
  const { routes } = discoveredRouteFixture("http-ui");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/extensions/fixture-ext/ui/index.html"), routes);
  expect(response?.status).toBe(200);
  expect(new Uint8Array(await response!.arrayBuffer())).toEqual(UI_BYTES);
});

test("EXT-HTTP-DATASET serves the validated snapshot envelope", async () => {
  const { routes } = discoveredRouteFixture("http-dataset");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture-ext/datasets/snapshot"), routes);
  expect(response?.status).toBe(200);
  expect(await body(response)).toMatchObject({ extension_id: "fixture-ext", dataset_id: "snapshot" });
});

test("EXT-HTTP-DATASET-SCHEMA validates the complete returned envelope", async () => {
  const { routes } = discoveredRouteFixture("http-dataset-schema");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture-ext/datasets/snapshot"), routes);
  expect(validateSchema(SCHEMAS.envelope, await body(response), routes.registry)).toBe(true);
});

test("EXT-HTTP-DATASET-INVALID fails closed on integrity drift", async () => {
  const { routes, root } = discoveredRouteFixture("http-dataset-invalid");
  const envelope = validEnvelope();
  envelope.payload = { records: [{ secret: true }] };
  writeJson(join(root, "data", "snapshot.snapshot.json"), envelope);
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture-ext/datasets/snapshot"), routes);
  expect(response?.status).toBe(400);
  expect((await body(response)).error.code).toBe("DATASET_INVALID");
});

test("EXT-HTTP-HEADERS and HEAD preserve status and headers without bodies", async () => {
  const { routes } = discoveredRouteFixture("http-headers");
  const cases = [
    ["/api/extensions", "application/json; charset=utf-8"],
    ["/api/extensions/fixture-ext", "application/json; charset=utf-8"],
    ["/api/extensions/fixture-ext/datasets/snapshot", "application/json; charset=utf-8"],
    ["/extensions/fixture-ext/ui/index.html", "text/html; charset=utf-8"],
  ] as const;
  for (const [path, contentType] of cases) {
    const get = await handleExtensionRoute(new Request(`http://127.0.0.1${path}`), routes);
    const head = await handleExtensionRoute(new Request(`http://127.0.0.1${path}`, { method: "HEAD" }), routes);
    expect(head?.status).toBe(get?.status);
    expect(head?.headers.get("content-type")).toBe(contentType);
    expect(head?.headers.get("cache-control")).toBe("no-store");
    expect(head?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await head!.text()).toBe("");
  }
  const ui = await handleExtensionRoute(new Request("http://127.0.0.1/extensions/fixture-ext/ui/index.html"), routes);
  expect(ui?.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(ui?.headers.get("referrer-policy")).toBe("no-referrer");
});

test("EXT-HTTP-METHOD-POST returns one schema-valid 405 error", async () => {
  const routes = directRoutes();
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions", { method: "POST" }), routes);
  expect(response?.status).toBe(405);
  const diagnostic = await body(response);
  expect(diagnostic.error.code).toBe("METHOD_NOT_ALLOWED");
  expect(validateSchema(SCHEMAS.publicError, diagnostic, routes.registry)).toBe(true);
});

test("EXT-HTTP-UNKNOWN-EXT returns a closed 404 error", async () => {
  const routes = directRoutes();
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/missing-ext"), routes);
  expect(response?.status).toBe(404);
  expect((await body(response)).error.code).toBe("EXTENSION_NOT_FOUND");
});

test("EXT-HTTP-UNKNOWN-DATASET returns 404 before filesystem access", async () => {
  const routes = directRoutes();
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture-ext/datasets/missing-set"), routes);
  expect(response?.status).toBe(404);
  expect((await body(response)).error.code).toBe("EXTENSION_NOT_FOUND");
});

test("EXT-HTTP-TRAVERSAL rejects a decoded slash and dot segment", async () => {
  const routes = directRoutes();
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/%2e%2e%2fsecret"), routes);
  expect(response?.status).toBe(400);
  expect((await body(response)).error.code).toBe("PATH_UNSAFE");
});

test("EXT-HTTP-DOUBLE-ENCODE rejects residual percent encoding", async () => {
  const routes = directRoutes();
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture%252dext"), routes);
  expect(response?.status).toBe(400);
  expect((await body(response)).error.code).toBe("PATH_UNSAFE");
});

test("EXT-HTTP-UNINVENTORIED never serves extension-adjacent files", async () => {
  const { routes, root } = discoveredRouteFixture("http-uninventoried");
  writeFileSync(join(root, "ui", "secret.txt"), "do not serve");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/extensions/fixture-ext/ui/secret.txt"), routes);
  expect(response?.status).toBe(404);
  expect((await body(response)).error.code).toBe("EXTENSION_NOT_FOUND");
});

test("EXT-HTTP-REDACTION never exposes paths, stacks, or rejected bytes", async () => {
  const { routes, root } = discoveredRouteFixture("http-redaction-secret-marker");
  writeFileSync(join(root, "data", "snapshot.snapshot.json"), "C:\\secret\\token.txt\nSTACK_MARKER\n");
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/fixture-ext/datasets/snapshot"), routes);
  expect(response?.status).toBe(400);
  const text = await response!.text();
  expect(text).not.toContain("secret-marker");
  expect(text).not.toContain("token.txt");
  expect(text).not.toContain("STACK_MARKER");
  expect(JSON.parse(text).error.code).toBe("DATASET_INVALID");
});

test("EXT-HTTP-UNRELATED falls through without changing the old router", async () => {
  const routes = directRoutes();
  expect(await handleExtensionRoute(new Request("http://127.0.0.1/api/health"), routes)).toBeUndefined();
  expect(await handleExtensionRoute(new Request("http://127.0.0.1/extensions"), routes)).not.toBeUndefined();
});

test("EXT-HTTP-ERROR-SCHEMA uses the nested diagnostic.error.code contract", async () => {
  const extension = buildExtensionContext([candidate()], "global", ZERO_DIGEST, SCHEMAS, undefined);
  const routes = createRouteContext(extension, correlationId, () => ({}), () => new Uint8Array());
  const response = await handleExtensionRoute(new Request("http://127.0.0.1/api/extensions/missing-ext"), routes);
  expect(response?.status).toBe(404);
  const diagnostic = await body(response);
  expect(diagnostic.error.code).toBe("EXTENSION_NOT_FOUND");
  expect(validateSchema(SCHEMAS.publicError, diagnostic, routes.registry)).toBe(true);
});

test("EXT-CONTRACT-LOADER-HOST-HTTP reaches the production CLI, server, and router", async () => {
  const running = await startGlanceProcess({ extension: candidate(), dataset: "valid", scope: "global" });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    const catalog = await fetch(`${base}/api/extensions`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(catalog.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await catalog.json()).extensions[0].datasets).toEqual(["snapshot"]);
    const head = await fetch(`${base}/extensions/${candidate().manifest.id}/ui/index.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-security-policy")).toContain("connect-src 'none'");
    const method = await fetch(`${base}/api/extensions`, { method: "POST" });
    expect(method.status).toBe(405);
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ allow_actions: false });
  } finally {
    await running.stop();
  }
});

test("EXT-CONTRACT-ROUTE-FAILURE-ISOLATION keeps the real server healthy", async () => {
  const running = await startGlanceProcess({ extension: candidate(), dataset: "invalid", scope: "global" });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    const failed = await fetch(`${base}/api/extensions/${candidate().manifest.id}/datasets/snapshot`);
    expect(failed.status).toBe(400);
    expect((await failed.json()).error.code).toBe("DATASET_INVALID");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  } finally {
    await running.stop();
  }
});

export const LOADER_ROUTE_CASES = [
  "EXT-LOADER-ABSENT-ROOT", "EXT-LOADER-GLOBAL-ONLY", "EXT-LOADER-PROJECT-ONLY",
  "EXT-LOADER-COLLISION-BOTH", "EXT-LOADER-LIMIT-65", "EXT-LOADER-INCOMPATIBLE",
  "EXT-LOADER-INVALID-ISOLATION", "EXT-LOADER-MANIFEST-SCHEMA", "EXT-LOADER-CATALOG-ORDER",
  "EXT-LOADER-CACHE-DIGEST", "EXT-HTTP-CATALOG", "EXT-HTTP-CATALOG-SCHEMA", "EXT-HTTP-METADATA",
  "EXT-HTTP-UI", "EXT-HTTP-DATASET", "EXT-HTTP-DATASET-SCHEMA", "EXT-HTTP-DATASET-INVALID",
  "EXT-HTTP-HEADERS", "EXT-HTTP-METHOD-POST", "EXT-HTTP-UNKNOWN-EXT", "EXT-HTTP-UNKNOWN-DATASET",
  "EXT-HTTP-TRAVERSAL", "EXT-HTTP-DOUBLE-ENCODE", "EXT-HTTP-UNINVENTORIED", "EXT-HTTP-REDACTION",
  "EXT-HTTP-UNRELATED",
] as const;
