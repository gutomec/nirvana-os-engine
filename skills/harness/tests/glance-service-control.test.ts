import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizeJcs } from "../lib/glance/service/canonicalize.ts";
import { StopRequestError, consumeStopRequest, resolveControlSecret, stopMacInput, type StopControlIo } from "../lib/glance/service/control.ts";
import { ServicePathError } from "../lib/glance/service/paths.ts";
import { publishNoReplace } from "../lib/glance/service/no-replace.ts";
import { createNativeNoReplace } from "../lib/glance/service/no-replace-native.ts";
import { validateStopRequest } from "../lib/glance/service/schema-validator.ts";

const INSTANCE_A = "123e4567-e89b-12d3-a456-426614174000";
const INSTANCE_B = "123e4567-e89b-12d3-a456-426614174001";
const REQUEST_A = "0f0a1b2c-3d4e-5f6a-9b8c-7d6e5f4a3b2c";
const REQUEST_B = "0f0a1b2c-3d4e-5f6a-8b8c-7d6e5f4a3b2c";
const CREATED = "2026-08-23T12:00:00.000Z";
const EXPIRES = "2026-08-23T12:00:01.000Z";
const NOW = Date.parse("2026-08-23T12:00:00.500Z");
const SECRET = new TextEncoder().encode("glance-control-secret");
const NONCE = new Uint8Array([1, 2, 3, 4]);
const CONFIG_DIGEST = `sha256:${"a".repeat(64)}`;
const PROCESS_DIGEST = `sha256:${"b".repeat(64)}`;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const nonceRef = (requestId: string) => `control/nonces/${requestId}.nonce`;
const unsigned = (over: Record<string, unknown> = {}) => ({
  schema_version: "1.0.0",
  request_id: REQUEST_A,
  instance_id: INSTANCE_A,
  action: "stop",
  created_at: CREATED,
  expires_at: EXPIRES,
  nonce_ref: nonceRef(REQUEST_A),
  nonce_digest: `sha256:${sha256Hex(NONCE)}`,
  auth_algorithm: "hmac-sha256",
  ...over,
});
const signed = (over: Record<string, unknown> = {}) => {
  const base = unsigned(over);
  return { ...base, auth_tag: createHmac("sha256", SECRET).update(stopMacInput(base)).digest("hex") };
};
const instance = {
  schema_version: "1.0.0",
  instance_id: INSTANCE_A,
  pid: 4242,
  state: "running",
  started_at: CREATED,
  config_digest: CONFIG_DIGEST,
  process_digest: PROCESS_DIGEST,
  control_secret_ref: `secrets/${INSTANCE_A}.control`,
  control_secret_digest: `sha256:${"c".repeat(64)}`,
  log_ref: "logs/service.log",
};

interface ControlFixture {
  root: string;
  pendingPath: string;
  processingPath: string;
  noncePath: string;
  io: StopControlIo & { claims: [string, string][]; removed: string[] };
  writePending(value: unknown): void;
}

function createFixture(options: { now?: number; substituteOnReread?: boolean } = {}): ControlFixture {
  const root = mkdtempSync(join(tmpdir(), "glance-control-"));
  mkdirSync(join(root, "control", "pending"), { recursive: true });
  mkdirSync(join(root, "control", "nonces"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  const native = createNativeNoReplace();
  const pendingPath = join(root, "control", "pending", `${REQUEST_A}.json`);
  const processingPath = join(root, "control", "processing", `${REQUEST_A}.json`);
  const noncePath = join(root, "control", "nonces", `${REQUEST_A}.nonce`);
  const claims: [string, string][] = [];
  const removed: string[] = [];
  const reads = new Map<string, number>();
  const readBytes = (path: string): Uint8Array => {
    const count = (reads.get(path) ?? 0) + 1;
    reads.set(path, count);
    if (count === 2 && options.substituteOnReread) writeFileSync(path, '{"schema_version":"9.9.9"}\n');
    return readFileSync(path);
  };
  const io = {
    readBytes,
    now: () => options.now ?? NOW,
    claim(candidate: string, destination: string): boolean {
      try { mkdirSync(dirname(destination), { recursive: true }); publishNoReplace(native, candidate, destination); } catch { return false; }
      claims.push([candidate, destination]);
      return true;
    },
    remove(path: string) { rmSync(path, { force: true }); removed.push(path); },
    claims,
    removed,
  };
  return {
    root,
    pendingPath,
    processingPath,
    noncePath,
    io,
    writePending(value: unknown) { writeFileSync(pendingPath, new TextEncoder().encode(`${JSON.stringify(value)}\n`)); },
  };
}

function populateValid(fixture: ControlFixture): void {
  fixture.writePending(signed());
  mkdirSync(dirname(fixture.noncePath), { recursive: true });
  writeFileSync(fixture.noncePath, NONCE);
}

function consume(fixture: ControlFixture, over: { instance?: typeof instance; secret?: Uint8Array } = {}): void {
  consumeStopRequest({
    serviceRoot: fixture.root,
    pendingRef: `control/pending/${REQUEST_A}.json`,
    processingRef: `control/processing/${REQUEST_A}.json`,
    instance: over.instance ?? instance,
    secret: over.secret ?? SECRET,
    io: fixture.io,
  });
}

test.each([
  ["SVC-STOP-ACTION", { action: "restart" }],
  ["SVC-STOP-ALGORITHM", { auth_algorithm: "hmac-sha512" }],
  ["SVC-STOP-CREATED-AT", { created_at: "not-a-timestamp" }],
  ["SVC-STOP-HMAC", { auth_tag: "zz" }],
  ["SVC-STOP-INSTANCE-UUID", { instance_id: "nope" }],
  ["SVC-STOP-NONCE-DIGEST", { nonce_digest: "sha256:XYZ" }],
  ["SVC-STOP-NONCE-REF", { nonce_ref: "nonces/other.nonce" }],
  ["SVC-STOP-REQUEST-UUID", { request_id: "nope" }],
  ["SVC-STOP-WINDOW", { expires_at: "2026-08-23T12:00:31.000Z" }],
])("%s rejects malformed stop requests", (_id, over) => expect(() => validateStopRequest(unsigned(over))).toThrow());

test("SVC-CONTROL-CANONICAL-STABLE", () => {
  const value = signed();
  expect(canonicalizeJcs(value)).toBe(canonicalizeJcs(JSON.parse(JSON.stringify(value))));
  expect(canonicalizeJcs({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
});

test("SVC-CONTROL-VALID", () => {
  const fixture = createFixture();
  try {
    populateValid(fixture);
    expect(() => consume(fixture)).not.toThrow();
    expect(fixture.io.removed).toEqual([fixture.noncePath, fixture.processingPath]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-WRONG-HMAC", () => {
  const fixture = createFixture();
  try {
    fixture.writePending({ ...signed(), auth_tag: "f".repeat(64) });
    writeFileSync(fixture.noncePath, NONCE);
    expect(() => consume(fixture)).toThrow(new StopRequestError("AUTH_TAG").message);
    expect(fixture.io.removed).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-DIGEST", () => {
  const fixture = createFixture();
  try {
    const foreign = new Uint8Array([9, 9, 9]);
    fixture.writePending(signed({ nonce_digest: `sha256:${sha256Hex(foreign)}` }));
    writeFileSync(fixture.noncePath, NONCE);
    expect(() => consume(fixture)).toThrow(new StopRequestError("NONCE_DIGEST").message);
    expect(fixture.io.removed).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-EXPIRED", () => {
  const fixture = createFixture({ now: Date.parse(EXPIRES) + 1_000 });
  try {
    populateValid(fixture);
    expect(() => consume(fixture)).toThrow(new StopRequestError("WINDOW_EXPIRED").message);
    expect(fixture.io.removed).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-FUTURE", () => {
  const fixture = createFixture({ now: Date.parse(CREATED) - 1 });
  try {
    populateValid(fixture);
    expect(() => consume(fixture)).toThrow(new StopRequestError("WINDOW_FUTURE").message);
    expect(fixture.io.removed).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-INSTANCE", () => {
  const fixture = createFixture();
  try {
    populateValid(fixture);
    expect(() => consume(fixture, { instance: { ...instance, instance_id: INSTANCE_B } })).toThrow(new StopRequestError("INSTANCE_MISMATCH").message);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-MISSING-NONCE", () => {
  const fixture = createFixture();
  try {
    fixture.writePending(signed());
    expect(() => consume(fixture)).toThrow(/MISSING_SERVICE_REF|NONCE_MISSING/);
    expect(fixture.io.removed).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-REPLAY", () => {
  const fixture = createFixture();
  try {
    populateValid(fixture);
    expect(() => consume(fixture)).not.toThrow();
    fixture.writePending(signed({ request_id: REQUEST_B }));
    expect(() => consume(fixture, {})).toThrow(/MISSING_SERVICE_REF|NONCE_MISSING|REPLAY/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-UNKNOWN", () => {
  const fixture = createFixture();
  try {
    fixture.writePending({ ...signed(), surprise: true });
    writeFileSync(fixture.noncePath, NONCE);
    expect(() => consume(fixture)).toThrow(new StopRequestError("INVALID_REQUEST").message);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-ESCAPE-REF", () => {
  const fixture = createFixture();
  try {
    populateValid(fixture);
    expect(() => consumeStopRequest({
      serviceRoot: fixture.root,
      pendingRef: "../../escape/pending.json",
      processingRef: "control/processing/x.json",
      instance,
      secret: SECRET,
      io: fixture.io,
    })).toThrow(ServicePathError);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-SYMLINK-NONCE", () => {
  const fixture = createFixture();
  try {
    fixture.writePending(signed({ nonce_ref: `control/nonces/${REQUEST_A}.nonce` }));
    symlinkSync(tmpdir(), join(fixture.root, "control", "nonces", `${REQUEST_A}.nonce`), "junction");
    expect(() => consume(fixture)).toThrow(/LINKED_SERVICE_REF/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-SYMLINK-SECRET", () => {
  const fixture = createFixture();
  try {
    symlinkSync(tmpdir(), join(fixture.root, "secrets", "link.control"), "junction");
    const linked = { ...instance, control_secret_ref: "secrets/link.control" };
    expect(() => resolveControlSecret(fixture.root, linked)).toThrow(/LINKED_SERVICE_REF/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-PROCESSING-SUBSTITUTION", () => {
  const fixture = createFixture({ substituteOnReread: true });
  try {
    populateValid(fixture);
    expect(() => consume(fixture)).toThrow(new StopRequestError("PROCESSING_SUBSTITUTED").message);
    expect(fixture.io.removed).toEqual([]);
    expect(readFileSync(fixture.noncePath)).toEqual(Buffer.from(NONCE));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-CLAIM-LOST", () => {
  const fixture = createFixture();
  try {
    populateValid(fixture);
    mkdirSync(dirname(fixture.processingPath), { recursive: true });
    writeFileSync(fixture.processingPath, "foreign");
    expect(() => consume(fixture)).toThrow(new StopRequestError("CLAIM_LOST").message);
    expect(fixture.io.removed).toEqual([]);
    expect(readFileSync(fixture.processingPath, "utf8")).toBe("foreign");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-NO-SECRET-MATERIAL-IN-ERRORS", () => {
  const fixture = createFixture();
  try {
    fixture.writePending({ ...signed(), auth_tag: "f".repeat(64) });
    writeFileSync(fixture.noncePath, NONCE);
    let failure: unknown;
    try { consume(fixture); } catch (error) { failure = error; }
    const text = String((failure as Error).message) + JSON.stringify(Object.getOwnPropertyNames(failure ?? {}));
    expect(text).not.toContain("f".repeat(64));
    expect(text).not.toContain("glance-control-secret");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("SVC-CONTROL-RESOLVE-SECRET-READS-BYTES", () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.root, "secrets", `${INSTANCE_A}.control`), SECRET);
    expect(resolveControlSecret(fixture.root, instance)).toEqual(SECRET);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

export const CONTROL_CASES = ["SVC-CONTROL-DIGEST", "SVC-CONTROL-ESCAPE-REF", "SVC-CONTROL-EXPIRED", "SVC-CONTROL-FUTURE", "SVC-CONTROL-INSTANCE", "SVC-CONTROL-MISSING-NONCE", "SVC-CONTROL-PROCESSING-SUBSTITUTION", "SVC-CONTROL-REPLAY", "SVC-CONTROL-SYMLINK-NONCE", "SVC-CONTROL-SYMLINK-SECRET", "SVC-CONTROL-UNKNOWN", "SVC-CONTROL-VALID", "SVC-CONTROL-WRONG-HMAC", "SVC-STOP-ACTION", "SVC-STOP-ALGORITHM", "SVC-STOP-CREATED-AT", "SVC-STOP-HMAC", "SVC-STOP-INSTANCE-UUID", "SVC-STOP-NONCE-DIGEST", "SVC-STOP-NONCE-REF", "SVC-STOP-REQUEST-UUID", "SVC-STOP-WINDOW"] as const;
