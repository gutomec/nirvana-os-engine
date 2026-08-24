#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { startServer, type ServerRuntime } from "../lib/glance/server.ts";
import { buildServiceHealth } from "../lib/glance/service/adapters.ts";
import { verifyStopRequestAgainstInstance } from "../lib/glance/service/control.ts";
import { publishNoReplace } from "../lib/glance/service/no-replace.ts";
import { createNativeNoReplace } from "../lib/glance/service/no-replace-native.ts";
import { resolveServiceRef } from "../lib/glance/service/paths.ts";
import { validateInstance, validateServiceConfig, validateStartupReady, validateStopRequest } from "../lib/glance/service/schema-validator.ts";
import { drainServer } from "../lib/glance/service/request-drain.ts";
import { parseStrictJson } from "../lib/glance/service/strict-json.ts";
import { digestJcs, readStateFileStrict, writePrivateBytes } from "../lib/glance/service/state.ts";

export interface ServiceWorkerArgs { serviceRoot: string; configRef: string; instanceRef: string; startupId: string }
export interface WorkerRuntime {
  io: { read(path: string): Uint8Array; archive(path: string): void };
  readPrivate(path: string): Uint8Array;
  waitForStartupReady(path: string, deadlineMs: number): Promise<unknown>;
  consumeStartupReady(path: string, startupId: string): Promise<void>;
  watchStop(callback: (request: unknown) => Promise<void>): Promise<void>;
  validateAndConsume(request: unknown, secret: Uint8Array, nonce: Uint8Array, instance: unknown): Promise<void>;
  drain(server: Bun.Server<unknown>): Promise<void>;
  finalizeStop(instance: unknown): Promise<void>;
  serverRuntime?: Partial<ServerRuntime>;
  metadata: { engineVersion: string; extensionRootDigest: `sha256:${string}` };
}

export async function runServiceWorker(args: ServiceWorkerArgs, runtime: WorkerRuntime): Promise<void> {
  const configPath = resolveServiceRef(args.serviceRoot, args.configRef, true);
  const readyPath = resolveServiceRef(args.serviceRoot, `control/startup/${args.startupId}.ready.json`, false);
  const ready = validateStartupReady(await runtime.waitForStartupReady(readyPath, 10_000));
  if (ready.startup_id !== args.startupId) throw new Error("STARTUP_IDENTITY");
  const instancePath = resolveServiceRef(args.serviceRoot, args.instanceRef, true);
  const instance = readStateFileStrict(instancePath, validateInstance, runtime.io);
  if (instance.instance_id !== ready.instance_id || digestJcs(instance) !== ready.instance_digest) throw new Error("STARTUP_INSTANCE_DIGEST");
  const config = readStateFileStrict(configPath, validateServiceConfig, runtime.io);
  if (digestJcs(config) !== instance.config_digest) throw new Error("STARTUP_CONFIG_DIGEST");
  await runtime.consumeStartupReady(readyPath, args.startupId);
  const secretPath = resolveServiceRef(args.serviceRoot, instance.control_secret_ref, true);
  const secret = runtime.readPrivate(secretPath);
  const serviceHealth = buildServiceHealth(config, instance, runtime.metadata);
  const running = await startServer({ port: config.port, open: false, allowActions: false, theme: "apple", lifetime: { mode: "persistent" }, serviceHealth }, runtime.serverRuntime);
  await runtime.watchStop(async request => {
    const noncePath = resolveServiceRef(args.serviceRoot, (request as { nonce_ref: string }).nonce_ref, true);
    const nonce = runtime.readPrivate(noncePath);
    await runtime.validateAndConsume(request, secret, nonce, instance);
    await runtime.drain(running.server);
  });
  await runtime.finalizeStop(instance);
}

export function createWorkerNonce(path: string, bytes: Uint8Array): void {
  writePrivateBytes(path, bytes);
}

export interface StartupReadinessDeps {
  now(): number;
  schedule(callback: () => void, ms: number): unknown;
  pollMs?: number;
  read?(path: string): Uint8Array;
  remove?(path: string): void;
  capture?: Map<string, Uint8Array>;
}

export function createStartupReadiness(deps: StartupReadinessDeps) {
  const pollMs = deps.pollMs ?? 25;
  const read = deps.read ?? readFileSync;
  const remove = deps.remove ?? ((path: string) => rmSync(path, { force: true }));
  const captured = deps.capture ?? new Map<string, Uint8Array>();
  return {
    async waitForStartupReady(path: string, deadlineMs: number): Promise<unknown> {
      const startedAt = deps.now();
      for (;;) {
        let bytes: Uint8Array;
        try {
          bytes = read(path);
        } catch {
          if (deps.now() - startedAt >= deadlineMs) throw new Error("STARTUP_READY_TIMEOUT");
          await new Promise<void>(resolveTask => deps.schedule(resolveTask, pollMs));
          continue;
        }
        captured.set(path, bytes);
        return parseStrictJson(bytes);
      }
    },
    async consumeStartupReady(path: string, startupId: string): Promise<void> {
      let bytes: Uint8Array;
      try { bytes = read(path); } catch (cause) { throw new Error("STARTUP_READY_CONSUME_MISSING", { cause }); }
      const original = captured.get(path);
      if (original && !Buffer.from(bytes).equals(Buffer.from(original))) throw new Error("STARTUP_READY_SUBSTITUTED");
      const ready = validateStartupReady(parseStrictJson(bytes));
      if (ready.startup_id !== startupId) throw new Error("STARTUP_READY_FOREIGN");
      remove(path);
      captured.delete(path);
    },
  };
}

function consumeNonceOnce(path: string, expected: Uint8Array): void {
  let observed: Uint8Array;
  try { observed = readFileSync(path); } catch (cause) { throw new Error("NONCE_ALREADY_CONSUMED", { cause }); }
  if (!Buffer.from(observed).equals(Buffer.from(expected))) throw new Error("NONCE_SUBSTITUTED");
  rmSync(path, { force: true });
}

export interface StopControlDeps {
  root: string;
  now(): number;
  schedule(callback: () => void, ms: number): unknown;
  pollMs?: number;
  readPrivate(path: string): Uint8Array;
}

export function createStopControl(deps: StopControlDeps) {
  const native = createNativeNoReplace();
  const pollMs = deps.pollMs ?? 25;
  const pendingDir = join(deps.root, "control", "pending");
  const processingDir = join(deps.root, "control", "processing");
  const state: { callback?: (request: unknown) => Promise<void>; completed: boolean; finish?: () => void; claimedPath?: string } = { completed: false };
  const listPending = (): string[] => {
    try { return readdirSync(pendingDir).filter(name => name.endsWith(".json")).sort(); } catch { return []; }
  };
  const claim = (name: string): string | undefined => {
    const from = join(pendingDir, name), to = join(processingDir, name);
    try { mkdirSync(processingDir, { recursive: true }); publishNoReplace(native, from, to); return to; } catch { return undefined; }
  };
  return {
    watchStop(callback: (request: unknown) => Promise<void>): Promise<void> {
      state.callback = callback;
      return new Promise<void>((resolveWatcher, rejectWatcher) => {
        state.finish = resolveWatcher;
        void (async () => {
          for (;;) {
            if (state.completed) return resolveWatcher();
            await new Promise<void>(resolveTick => deps.schedule(resolveTick, pollMs));
            if (state.completed) return resolveWatcher();
            for (const name of listPending()) {
              const claimed = claim(name);
              if (!claimed) continue;
              try {
                const bytes = readFileSync(claimed);
                const request = validateStopRequest(parseStrictJson(bytes));
                state.claimedPath = claimed;
                await callback(request);
                state.completed = true;
                return resolveWatcher();
              } catch {}
            }
          }
        })().catch(rejectWatcher);
      });
    },
    async deliver(request: unknown): Promise<void> {
      if (!state.callback) throw new Error("WORKER_WATCHER_NOT_STARTED");
      await state.callback(request);
      state.completed = true;
      state.finish?.();
    },
    async validateAndConsume(request: unknown, secret: Uint8Array, nonce: Uint8Array, instance: unknown): Promise<void> {
      const typedRequest = validateStopRequest(request);
      verifyStopRequestAgainstInstance({ request: typedRequest, secret, nonce, instance: instance as { instance_id: string }, now: deps.now() });
      const noncePath = resolveServiceRef(deps.root, typedRequest.nonce_ref, false);
      consumeNonceOnce(noncePath, nonce);
      if (state.claimedPath) rmSync(state.claimedPath, { force: true });
    },
  };
}

export function createProductionRuntime(serviceRoot: string, metadata: { engineVersion: string; extensionRootDigest: `sha256:${string}` }, overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const readiness = createStartupReadiness({ now: () => Date.now(), schedule: (callback, ms) => setTimeout(callback, ms) });
  const stopControl = createStopControl({ root: serviceRoot, now: () => Date.now(), schedule: (callback, ms) => setTimeout(callback, ms), readPrivate: readFileSync });
  const finalizeStop = async (instance: unknown): Promise<void> => {
    const typed = validateInstance(instance);
    const instancePath = resolveServiceRef(serviceRoot, "instance.json", false);
    const coreOf = (value: unknown): Record<string, unknown> => {
      const copy = { ...(value as Record<string, unknown>) };
      delete copy.state;
      return copy;
    };
    try {
      if (digestJcs(coreOf(parseStrictJson(readFileSync(instancePath)))) !== digestJcs(coreOf(typed))) return;
      rmSync(instancePath, { force: true });
    } catch { return; }
    try { rmSync(resolveServiceRef(serviceRoot, typed.control_secret_ref, true), { force: true }); } catch {}
    try { appendFileSync(resolveServiceRef(serviceRoot, typed.log_ref, false), `[glance-service] stopped ${typed.instance_id}\n`); } catch {}
  };
  return {
    io: { read: readFileSync, archive: path => { rmSync(path); } },
    readPrivate: readFileSync,
    waitForStartupReady: readiness.waitForStartupReady,
    consumeStartupReady: readiness.consumeStartupReady,
    watchStop: stopControl.watchStop,
    validateAndConsume: stopControl.validateAndConsume,
    drain: server => drainServer(server),
    finalizeStop,
    metadata,
    ...overrides,
  };
}

function parseWorkerArgv(argv: readonly string[]): ServiceWorkerArgs {
  const expected = ["--service-root", "--config-ref", "--instance-ref", "--startup-id"] as const;
  if (argv.length !== 8) throw new Error("WORKER_ARGV_LENGTH");
  const parsed: Partial<Record<(typeof expected)[number], string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!expected.includes(flag as (typeof expected)[number])) throw new Error(`WORKER_ARGV_FLAG:${flag}`);
    parsed[flag as (typeof expected)[number]] = argv[index + 1];
  }
  for (const flag of expected) if (!parsed[flag]) throw new Error(`WORKER_ARGV_MISSING:${flag}`);
  return { serviceRoot: parsed["--service-root"]!, configRef: parsed["--config-ref"]!, instanceRef: parsed["--instance-ref"]!, startupId: parsed["--startup-id"]! };
}

if (import.meta.main) {
  try {
    const args = parseWorkerArgv(process.argv.slice(2));
    const skillsRoot = resolve(dirname(dirname(dirname(import.meta.path))));
    const versionBytes = readFileSync(join(skillsRoot, "VERSION"));
    const metadata = { engineVersion: new TextDecoder().decode(versionBytes).trim(), extensionRootDigest: `sha256:${createHash("sha256").update(versionBytes).digest("hex")}` as `sha256:${string}` };
    runServiceWorker(args, createProductionRuntime(args.serviceRoot, metadata)).then(
      () => { process.exitCode = 0; },
      error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
