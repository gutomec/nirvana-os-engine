import type { ExtensionContext } from "./loader.ts";
import { validateSchema, type JsonSchema } from "./schema-validator.ts";
import type { ExtensionErrorCode } from "./types.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const UI_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

const ERROR_MESSAGES: Record<ExtensionErrorCode, string> = {
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

export interface ExtensionRouteContext {
  extension: ExtensionContext;
  publicErrorSchema: JsonSchema;
  registry: ReadonlyMap<string, JsonSchema>;
  correlationId(): string;
  readDataset(extensionId: string, datasetId: string): unknown;
  readUi(extensionId: string): Uint8Array;
}

export function createRouteContext(
  extension: ExtensionContext,
  correlationId: () => string,
  readDataset: ExtensionRouteContext["readDataset"],
  readUi: ExtensionRouteContext["readUi"],
): ExtensionRouteContext {
  return {
    extension,
    publicErrorSchema: extension.schemas.publicError,
    registry: extension.registry,
    correlationId,
    readDataset,
    readUi,
  };
}

function json(value: unknown, status = 200, head = false): Response {
  return new Response(head ? null : JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function failure(
  context: ExtensionRouteContext,
  code: ExtensionErrorCode,
  status: number,
  head: boolean,
  extensionId?: string,
  datasetId?: string,
): Response {
  const error: Record<string, unknown> = {
    code,
    message: ERROR_MESSAGES[code],
    retryable: false,
    correlation_id: context.correlationId(),
  };
  if (extensionId && /^[a-z0-9][a-z0-9-]{2,62}$/.test(extensionId)) error.extension_id = extensionId;
  if (datasetId && /^[a-z0-9][a-z0-9-]{2,62}$/.test(datasetId)) error.dataset_id = datasetId;
  const value = { schema_version: "1.0.0", error };
  validateSchema(context.publicErrorSchema, value, context.registry);
  return json(value, status, head);
}

function decodeId(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new Error("PATH_UNSAFE");
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(value) || value.includes("%")) throw new Error("PATH_UNSAFE");
  return value;
}

function readFailureCode(error: unknown, ui: boolean): ExtensionErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "PATH_UNSAFE") return "PATH_UNSAFE";
  if (message === "FILE_INTEGRITY" || message === "FILE_CHANGED") return "FILE_INTEGRITY";
  if (message === "SCOPE_MISMATCH" || message.includes("SCOPE")) return "SCOPE_MISMATCH";
  return ui ? "FILE_INTEGRITY" : "DATASET_INVALID";
}

export async function handleExtensionRoute(
  request: Request,
  context: ExtensionRouteContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const api = url.pathname === "/api/extensions" || url.pathname.startsWith("/api/extensions/");
  const ui = url.pathname === "/extensions" || url.pathname.startsWith("/extensions/");
  if (!api && !ui) return undefined;
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return failure(context, "METHOD_NOT_ALLOWED", 405, false);

  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (api && parts.length === 2) return json(context.extension.catalog, 200, head);
    if (ui && parts.length === 1) return failure(context, "EXTENSION_NOT_FOUND", 404, head);

    const rawId = (api ? parts[2] : parts[1]) ?? "";
    const extensionId = decodeId(rawId);
    const record = context.extension.extensions.get(extensionId);
    if (!record) return failure(context, "EXTENSION_NOT_FOUND", 404, head, extensionId);

    if (api && parts.length === 3) {
      const metadata = context.extension.catalog.extensions.find((item) => item.id === extensionId && item.status === "accepted");
      return metadata
        ? json({ ...metadata, external_navigation: record.manifest.external_navigation }, 200, head)
        : failure(context, "EXTENSION_NOT_FOUND", 404, head, extensionId);
    }

    if (api && parts.length === 5 && parts[3] === "datasets") {
      const datasetId = decodeId(parts[4] ?? "");
      if (!record.manifest.datasets.some((item) => item.id === datasetId)) {
        return failure(context, "EXTENSION_NOT_FOUND", 404, head, extensionId, datasetId);
      }
      try {
        return json(context.readDataset(extensionId, datasetId), 200, head);
      } catch (error) {
        return failure(context, readFailureCode(error, false), 400, head, extensionId, datasetId);
      }
    }

    if (ui && parts.length === 4 && parts[2] === "ui" && parts[3] === "index.html") {
      try {
        const bytes = context.readUi(extensionId);
        return new Response(head ? null : bytes, { status: 200, headers: UI_HEADERS });
      } catch (error) {
        return failure(context, readFailureCode(error, true), 400, head, extensionId);
      }
    }

    return failure(context, "EXTENSION_NOT_FOUND", 404, head, extensionId);
  } catch {
    return failure(context, "PATH_UNSAFE", 400, head);
  }
}
