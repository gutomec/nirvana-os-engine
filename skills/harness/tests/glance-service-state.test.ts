import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateMode, assertWindowsAclPrivate } from "../lib/glance/service/permissions.ts";
import { resolveServiceRef } from "../lib/glance/service/paths.ts";
import { validateInstance, validateLockOwner, validateServiceConfig, validateStopRequest } from "../lib/glance/service/schema-validator.ts";
import { parseStrictJson } from "../lib/glance/service/strict-json.ts";
import { IncompatibleStateError, ServiceIoError, readStateFileOrArchive, readStateFileStrict, writeDurableJson, writePrivateBytes } from "../lib/glance/service/state.ts";

const digest = `sha256:${"a".repeat(64)}`;
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const timestamp = "2026-08-23T12:00:00.000Z";
const globalConfig = { schema_version: "1.0.0", scope: "global", host: "127.0.0.1", port: 3737, read_only: true, lifetime: "persistent", no_open: true };
const projectConfig = { ...globalConfig, scope: "project", project_root: "C:/work", project_root_digest: digest };
const instance = { schema_version: "1.0.0", instance_id: uuid, pid: 7, state: "running", started_at: timestamp, config_digest: digest, process_digest: digest, control_secret_ref: `secrets/${uuid}.control`, control_secret_digest: digest, log_ref: "logs/service.log" };
const owner = { schema_version: "1.0.0", owner_id: uuid, manager_pid: 7, operation: "start", target: { nirvana_home_digest: digest, scope: "global", port: 3737 }, acquired_at: timestamp, expires_at: "2026-08-23T12:00:01.000Z", token_ref: `secrets/${uuid}.manager`, token_digest: digest };
const stopRequest = { schema_version: "1.0.0", request_id: uuid, instance_id: uuid, action: "stop", created_at: timestamp, expires_at: "2026-08-23T12:00:01.000Z", nonce_ref: `control/nonces/${uuid}.nonce`, nonce_digest: digest, auth_algorithm: "hmac-sha256", auth_tag: "b".repeat(64) };
const changed = <T extends object>(value: T, property: string, replacement: unknown): T => ({ ...value, [property]: replacement });

test("SVC-CONFIG-GLOBAL-PASS", () => expect(validateServiceConfig(globalConfig)).toEqual(globalConfig));
test("SVC-CONFIG-GLOBAL-PROJECT", () => expect(validateServiceConfig(projectConfig)).toEqual(projectConfig));
test.each([["SVC-CONFIG-EXTRA", { ...globalConfig, extra: true }], ["SVC-CONFIG-HOST", changed(globalConfig, "host", "0.0.0.0")], ["SVC-CONFIG-LIFETIME", changed(globalConfig, "lifetime", "idle")], ["SVC-CONFIG-NO-OPEN", changed(globalConfig, "no_open", false)], ["SVC-CONFIG-PORT", changed(globalConfig, "port", 80)], ["SVC-CONFIG-READ-ONLY", changed(globalConfig, "read_only", false)], ["SVC-CONFIG-SCHEMA-VERSION", changed(globalConfig, "schema_version", "2.0.0")], ["SVC-CONFIG-SCOPE-ENUM", changed(globalConfig, "scope", "local")], ["SVC-CONFIG-PROJECT-MISSING", { ...projectConfig, project_root_digest: undefined }], ["SVC-CONFIG-PROJECT-DIGEST", changed(projectConfig, "project_root_digest", "sha256:ABC")], ["SVC-CONFIG-PROJECT-LENGTH", changed(projectConfig, "project_root", "x".repeat(1025))]])("%s rejects invalid config", (_id, value) => expect(() => validateServiceConfig(value)).toThrow());

test.each([["SVC-INSTANCE-CLOSED", { ...instance, unknown: true }], ["SVC-INSTANCE-CONFIG-DIGEST", changed(instance, "config_digest", "bad")], ["SVC-INSTANCE-LOG-REF", changed(instance, "log_ref", "../service.log")], ["SVC-INSTANCE-PID", changed(instance, "pid", 0)], ["SVC-INSTANCE-PROCESS-DIGEST", changed(instance, "process_digest", "bad")], ["SVC-INSTANCE-REF", changed(instance, "control_secret_ref", "secrets/not-a-uuid.control")], ["SVC-INSTANCE-REQUIRED", { ...instance, state: undefined }], ["SVC-INSTANCE-RESTART-CLOSED", { ...instance, last_restart: { attempted_at: timestamp, requested_config_digest: digest, effective_config_digest: digest, rollback_state: "not_needed", extra: true } }], ["SVC-INSTANCE-RESTART-ENUM", { ...instance, last_restart: { attempted_at: timestamp, requested_config_digest: digest, effective_config_digest: digest, rollback_state: "wrong" } }], ["SVC-INSTANCE-SECRET-DIGEST", changed(instance, "control_secret_digest", "bad")], ["SVC-INSTANCE-STATE", changed(instance, "state", "stopped")], ["SVC-INSTANCE-TIMESTAMP", changed(instance, "started_at", "tomorrow")], ["SVC-INSTANCE-UUID", changed(instance, "instance_id", "no")]])("%s rejects invalid instance", (_id, value) => expect(() => validateInstance(value)).toThrow());

test("SVC-OWNER-GLOBAL-PROJECT", () => expect(() => validateLockOwner({ ...owner, target: { ...owner.target, project_root_digest: digest } })).toThrow());
test("SVC-OWNER-TARGET-CLOSED", () => expect(() => validateLockOwner({ ...owner, target: { ...owner.target, extra: true } })).toThrow());
test("SVC-OWNER-OPERATION", () => expect(() => validateLockOwner(changed(owner, "operation", "status"))).toThrow());
test("SVC-OWNER-PROJECT-DIGEST", () => expect(() => validateLockOwner({ ...owner, target: { ...owner.target, scope: "project" } })).toThrow());
test("SVC-OWNER-TOKEN-REF", () => expect(() => validateLockOwner(changed(owner, "token_ref", "secrets/x.manager"))).toThrow());
test("SVC-OWNER-WINDOW", () => expect(() => validateLockOwner({ ...owner, expires_at: "2026-08-23T12:00:31.000Z" })).toThrow());
test("SVC-OWNER-UUID", () => expect(() => validateLockOwner(changed(owner, "owner_id", "bad"))).toThrow());
test("SVC-STOP-REQUEST-CLOSED", () => expect(() => validateStopRequest({ ...stopRequest, extra: true })).toThrow());
test("SVC-STOP-REQUEST-WINDOW", () => expect(() => validateStopRequest({ ...stopRequest, expires_at: "2026-08-23T12:00:31.000Z" })).toThrow());
test("SVC-STOP-REQUEST-NONCE", () => expect(() => validateStopRequest(changed(stopRequest, "nonce_ref", "control/nonces/bad.nonce"))).toThrow());
test("SVC-STRICT-JSON-DUPLICATE", () => expect(() => parseStrictJson(new TextEncoder().encode('{"a":1,"a":2}'))).toThrow());
test("SVC-STRICT-JSON-TRAILING", () => expect(() => parseStrictJson(new TextEncoder().encode('{} trailing'))).toThrow());

test.each([["SVC-PATH-TRAVERSAL", "../instance.json"], ["SVC-PATH-POSIX-ABS", "/instance.json"], ["SVC-PATH-WINDOWS-ABS", "C:\\instance.json"], ["SVC-PATH-ADS", "instance.json:secret"]])("%s rejects unsafe reference", (_id, ref) => { const root = mkdtempSync(join(tmpdir(), "glance-path-")); try { expect(() => resolveServiceRef(root, ref, false)).toThrow(); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-PATH-SYMLINK", () => { const root = mkdtempSync(join(tmpdir(), "glance-path-")); try { mkdirSync(join(root, "secrets")); symlinkSync(tmpdir(), join(root, "secrets", "link"), "junction"); expect(() => resolveServiceRef(root, "secrets/link/value", false)).toThrow(); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-PATH-JUNCTION", () => { const root = mkdtempSync(join(tmpdir(), "glance-path-")); try { mkdirSync(join(root, "control")); symlinkSync(tmpdir(), join(root, "control", "junction"), "junction"); expect(() => resolveServiceRef(root, "control/junction/value", false)).toThrow(); } finally { rmSync(root, { recursive: true, force: true }); } });

test("SVC-STATE-IO-NOT-ARCHIVED", () => { let archived = false; expect(() => readStateFileOrArchive("instance.json", value => value as object, { read() { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, archive() { archived = true; } })).toThrow("SERVICE_IO:STATE_READ"); expect(archived).toBe(false); });
test("SVC-STATE-ARCHIVE-INCOMPATIBLE", () => { let archived = false; expect(readStateFileOrArchive("instance.json", () => { throw new Error("schema"); }, { read: () => new TextEncoder().encode("{}\n"), archive: () => { archived = true; } })).toBeNull(); expect(archived).toBe(true); });
test("SVC-STATE-REREAD-VALIDATION", () => { const root = mkdtempSync(join(tmpdir(), "glance-state-")); try { const path = join(root, "state.json"); writeDurableJson(path, globalConfig); expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(globalConfig)}\n`); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-SECRET-NONCE-DURABLE", () => { const root = mkdtempSync(join(tmpdir(), "glance-state-")); try { const secret = join(root, "secrets", "secret.control"), nonce = join(root, "control", "nonces", "nonce.nonce"), bytes = new Uint8Array([1, 2, 3]); writePrivateBytes(secret, bytes); writePrivateBytes(nonce, bytes); expect(readFileSync(secret)).toEqual(Buffer.from(bytes)); expect(readFileSync(nonce)).toEqual(Buffer.from(bytes)); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-STATE-STRICT-INCOMPATIBLE", () => expect(() => readStateFileStrict("state.json", validateServiceConfig, { read: () => new TextEncoder().encode('{"x":1,"x":2}'), archive: () => {} })).toThrow(IncompatibleStateError));
test("SVC-STATE-IO-ERROR", () => expect(() => readStateFileStrict("state.json", validateServiceConfig, { read: () => { throw new Error("denied"); }, archive: () => {} })).toThrow(ServiceIoError));

test("SVC-PERMISSION-POSIX-DIR", () => { if (process.platform === "win32") return; const root = mkdtempSync(join(tmpdir(), "glance-perm-")); try { chmodSync(root, 0o700); assertPrivateMode(root, 0o700); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-PERMISSION-POSIX-FILE", () => { if (process.platform === "win32") return; const root = mkdtempSync(join(tmpdir(), "glance-perm-")), file = join(root, "private"); try { writeFileSync(file, "x", { mode: 0o600 }); assertPrivateMode(file, 0o600); } finally { rmSync(root, { recursive: true, force: true }); } });
test("SVC-PERMISSION-WINDOWS-ALLOWLIST", () => expect(() => assertWindowsAclPrivate(["CURRENT_USER", "SYSTEM"], "CURRENT_USER")).not.toThrow());
test("SVC-PERMISSION-WINDOWS-FOREIGN-PRINCIPAL", () => expect(() => assertWindowsAclPrivate(["CURRENT_USER", "EVERYONE"], "CURRENT_USER")).toThrow());
test("SVC-SCHEMA-EXTRACTOR-ARGS", async () => { const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "..", "scripts", "extract-glance-service-schemas.ts")], { stdout: "pipe", stderr: "pipe" }); expect(await child.exited).toBe(2); });

export const STATE_CASES = ["SVC-CONFIG-EXTRA", "SVC-CONFIG-GLOBAL-PASS", "SVC-CONFIG-GLOBAL-PROJECT", "SVC-CONFIG-HOST", "SVC-CONFIG-LIFETIME", "SVC-CONFIG-NO-OPEN", "SVC-CONFIG-PORT", "SVC-CONFIG-PROJECT-DIGEST", "SVC-CONFIG-PROJECT-LENGTH", "SVC-CONFIG-PROJECT-MISSING", "SVC-CONFIG-READ-ONLY", "SVC-CONFIG-SCHEMA-VERSION", "SVC-CONFIG-SCOPE-ENUM", "SVC-INSTANCE-CLOSED", "SVC-INSTANCE-CONFIG-DIGEST", "SVC-INSTANCE-LOG-REF", "SVC-INSTANCE-PID", "SVC-INSTANCE-PROCESS-DIGEST", "SVC-INSTANCE-REF", "SVC-INSTANCE-REQUIRED", "SVC-INSTANCE-RESTART-CLOSED", "SVC-INSTANCE-RESTART-ENUM", "SVC-INSTANCE-SECRET-DIGEST", "SVC-INSTANCE-STATE", "SVC-INSTANCE-TIMESTAMP", "SVC-INSTANCE-UUID", "SVC-PATH-ADS", "SVC-PATH-JUNCTION", "SVC-PATH-POSIX-ABS", "SVC-PATH-SYMLINK", "SVC-PATH-TRAVERSAL", "SVC-PATH-WINDOWS-ABS", "SVC-PERMISSION-POSIX-DIR", "SVC-PERMISSION-POSIX-FILE", "SVC-PERMISSION-WINDOWS-ALLOWLIST", "SVC-PERMISSION-WINDOWS-FOREIGN-PRINCIPAL", "SVC-STATE-DIRECTORY-FSYNC", "SVC-STATE-REREAD-VALIDATION"] as const;
