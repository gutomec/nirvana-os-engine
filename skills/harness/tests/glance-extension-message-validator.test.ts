import { expect, test } from "bun:test";
import { createMessageValidator } from "../lib/glance/views/extension-message-validator.js";
import { createBrowserSchemaRegistry } from "../lib/glance/views/extension-message-schema-registry.js";
import { validEnvelope } from "./helpers/glance-extension-fixtures.ts";

const SESSION = "a".repeat(64);
const DIGEST = `sha256:${"0".repeat(64)}`;
const TOKENS = {
  "surface-0": "#fff", "surface-1": "#f8f8f8", "surface-2": "#eee",
  "text-primary": "#111", "text-secondary": "#555", "border-default": "#ccc",
  "border-focus": "#06f", accent: "#06f", "success-fg": "#070",
  "warn-fg": "#850", "danger-fg": "#b00", "space-2": "8px",
};
const ERROR = {
  schema_version: "1.0.0",
  error: { code: "URL_REJECTED", message: "External URL rejected", retryable: false, correlation_id: "11111111-1111-4111-8111-111111111111" },
};

const packet = (type: string, payload: unknown, sequence = 0) => ({
  schema_version: "1.0.0",
  protocol: "glance.extension.messages",
  session_id: SESSION,
  sequence,
  type,
  payload,
});

const CASES = [
  { type: "extension.ready", direction: "extension-to-host", payload: { ui_version: "1.0.0", accepted_envelope_versions: ["1.0.0"] }, missing: "ui_version", invalid: (p: any) => { p.accepted_envelope_versions = []; } },
  { type: "host.init", direction: "host-to-extension", payload: { extension_id: "fixture-ext", api_version: "1.0.0", locale: "pt-BR", theme: "apple", tokens: TOKENS }, missing: "theme", invalid: (p: any) => { p.locale = "pt_br"; } },
  { type: "host.dataset", direction: "host-to-extension", payload: { dataset_id: "snapshot", envelope: validEnvelope() }, missing: "dataset_id", invalid: (p: any) => { p.envelope.scope = {}; } },
  { type: "host.refreshing", direction: "host-to-extension", payload: { dataset_id: "snapshot" }, missing: "dataset_id", invalid: (p: any) => { p.dataset_id = "X"; } },
  { type: "host.error", direction: "host-to-extension", payload: ERROR, missing: "error", invalid: (p: any) => { p.error.retryable = "no"; } },
  { type: "extension.rendered", direction: "extension-to-host", payload: { snapshot_id: DIGEST }, missing: "snapshot_id", invalid: (p: any) => { p.snapshot_id = "bad"; } },
  { type: "extension.error", direction: "extension-to-host", payload: { code: "RENDER_FAILED", message: "Could not render" }, missing: "code", invalid: (p: any) => { p.message = ""; } },
  { type: "extension.open_external_url", direction: "extension-to-host", payload: { request_id: "11111111-1111-4111-8111-111111111111", url: "https://github.com/gutomec/nirvana-os-engine", display_label: "GitHub" }, missing: "display_label", invalid: (p: any) => { p.request_id = "bad"; } },
] as const;

test("EXT-MESSAGE-EIGHT-DISCRIMINATORS validate complete payloads through one registry", () => {
  const validate = createMessageValidator(createBrowserSchemaRegistry());
  for (const entry of CASES) {
    expect(validate(packet(entry.type, structuredClone(entry.payload)), SESSION, entry.direction, 0), entry.type).toBe(true);
  }
});

test("EXT-MESSAGE-DEEP-MATRIX rejects extra, missing, invalid and wrong-direction packets before acceptance", () => {
  const validate = createMessageValidator(createBrowserSchemaRegistry());
  for (const entry of CASES) {
    const extra: any = structuredClone(entry.payload); extra.unexpected = true;
    expect(validate(packet(entry.type, extra), SESSION, entry.direction, 0), `${entry.type}:extra`).toBe(false);
    const missing: any = structuredClone(entry.payload); delete missing[entry.missing];
    expect(validate(packet(entry.type, missing), SESSION, entry.direction, 0), `${entry.type}:missing`).toBe(false);
    const invalid: any = structuredClone(entry.payload); entry.invalid(invalid);
    expect(validate(packet(entry.type, invalid), SESSION, entry.direction, 0), `${entry.type}:nested`).toBe(false);
    const wrong = entry.direction === "host-to-extension" ? "extension-to-host" : "host-to-extension";
    expect(validate(packet(entry.type, structuredClone(entry.payload)), SESSION, wrong, 0), `${entry.type}:direction`).toBe(false);
  }
  expect(validate(packet("host.dataset", { dataset_id: "snapshot", envelope: {} }), SESSION, "host-to-extension", 0)).toBe(false);
  expect(validate(packet("host.error", { schema_version: "1.0.0", error: {} }), SESSION, "host-to-extension", 0)).toBe(false);
});

test("EXT-MESSAGE-DATASET-DEEP mutates every closed envelope child", () => {
  const validate = createMessageValidator(createBrowserSchemaRegistry());
  const mutations = [
    { child: "scope", apply: (envelope: any) => { envelope.scope.extra = true; } },
    { child: "subject", apply: (envelope: any) => { envelope.subject.extra = true; } },
    { child: "source.artifacts", apply: (envelope: any) => { envelope.source.artifacts[0].extra = true; } },
    { child: "freshness", apply: (envelope: any) => { envelope.freshness.extra = true; } },
    { child: "payload_schema", apply: (envelope: any) => { envelope.payload_schema.extra = true; } },
    { child: "evidence_refs", apply: (envelope: any) => { envelope.evidence_refs[0].extra = true; } },
    { child: "integrity", apply: (envelope: any) => { envelope.integrity.extra = true; } },
  ];
  for (const mutation of mutations) {
    const envelope: any = validEnvelope();
    mutation.apply(envelope);
    expect(validate(packet("host.dataset", { dataset_id: "snapshot", envelope }), SESSION, "host-to-extension", 0), mutation.child).toBe(false);
  }
});

test("EXT-MESSAGE-HOST-ERROR-DEEP mutates every required public-error child", () => {
  const validate = createMessageValidator(createBrowserSchemaRegistry());
  const mutations = [
    { child: "schema_version", apply: (value: any) => { value.schema_version = "2.0.0"; } },
    { child: "error.code", apply: (value: any) => { value.error.code = "PRIVATE_CODE"; } },
    { child: "error.message", apply: (value: any) => { value.error.message = ""; } },
    { child: "error.retryable", apply: (value: any) => { value.error.retryable = "false"; } },
    { child: "error.correlation_id", apply: (value: any) => { value.error.correlation_id = "not-a-uuid"; } },
  ];
  for (const mutation of mutations) {
    const value: any = structuredClone(ERROR);
    mutation.apply(value);
    expect(validate(packet("host.error", value), SESSION, "host-to-extension", 0), mutation.child).toBe(false);
  }
});

test("EXT-HOST-TOKENS rejects empty and over-bound values for all twelve tokens", () => {
  const validate = createMessageValidator(createBrowserSchemaRegistry());
  for (const [name, max] of Object.entries({ ...Object.fromEntries(Object.keys(TOKENS).map((name) => [name, 64])), "space-2": 32 })) {
    const empty = structuredClone(TOKENS) as Record<string, string>; empty[name] = "";
    expect(validate(packet("host.init", { extension_id: "fixture-ext", api_version: "1.0.0", locale: "pt-BR", theme: "apple", tokens: empty }), SESSION, "host-to-extension", 0), `${name}:empty`).toBe(false);
    const long = structuredClone(TOKENS) as Record<string, string>; long[name] = "x".repeat(Number(max) + 1);
    expect(validate(packet("host.init", { extension_id: "fixture-ext", api_version: "1.0.0", locale: "pt-BR", theme: "apple", tokens: long }), SESSION, "host-to-extension", 0), `${name}:long`).toBe(false);
  }
});

test("EXT-MESSAGE-UNKNOWN-DIRECTION fails before invoking the schema registry", () => {
  let calls = 0;
  const validate = createMessageValidator({ validate() { calls++; return true; } });
  expect(validate(packet("extension.ready", CASES[0].payload), SESSION, "sideways", 0)).toBe(false);
  expect(calls).toBe(0);
});
