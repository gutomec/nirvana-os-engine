import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalizeJcs } from "./canonicalize.ts";
import { digestJcs } from "./state.ts";
import type { ServiceConfigV1 } from "./types.ts";

export interface ServiceHealthV1 { schema_version: "1.0.0"; mode: "service"; instance_id: string; port: number; scope: "global" | "project"; project_root_digest?: `sha256:${string}`; lifetime: "persistent"; allow_actions: false; engine_version: string; uptime_seconds: number; effective_config_digest: `sha256:${string}`; process_digest: `sha256:${string}`; extension_root_digest: `sha256:${string}`; read_only: true; persistent: true }

export function buildServiceHealth(config: ServiceConfigV1, instance: { instance_id: string; process_digest: string }, metadata: { engineVersion: string; extensionRootDigest: `sha256:${string}` }): Omit<ServiceHealthV1, "uptime_seconds"> {
  return {
    schema_version: "1.0.0",
    mode: "service",
    instance_id: instance.instance_id,
    port: config.port,
    scope: config.scope,
    ...(config.scope === "project" ? { project_root_digest: config.project_root_digest } : {}),
    lifetime: "persistent",
    allow_actions: false,
    engine_version: metadata.engineVersion,
    effective_config_digest: digestJcs(config),
    process_digest: instance.process_digest as `sha256:${string}`,
    extension_root_digest: metadata.extensionRootDigest,
    read_only: true,
    persistent: true,
  };
}

export interface SpawnedService { pid: number; unref(): void }
export interface ProcessInspection { exists: boolean; entrypoint?: string; argv?: string[] }
export interface ServiceProcessAdapter {
  spawn(argv: readonly string[], env: Readonly<Record<string, string>>, logPath: string): SpawnedService;
  inspect(pid: number): Promise<ProcessInspection>;
  terminateOwn(pid: number): never;
}

export function canonicalWorkerArgv(worker: string, serviceRoot: string, startupId: string): string[] {
  return [process.execPath, worker, "--service-root", serviceRoot, "--config-ref", "config.json", "--instance-ref", "instance.json", "--startup-id", startupId];
}

export interface WorkerIdentityParts { entrypoint: string; serviceRoot: string; startupId: string }

export function processDigestFromIdentity(parts: WorkerIdentityParts): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalizeJcs(parts)).digest("hex")}`;
}

export function extractWorkerIdentityFromArgv(argv: readonly string[]): WorkerIdentityParts | null {
  if (argv.length < 6) return null;
  const readFlag = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const serviceRoot = readFlag("--service-root");
  const startupId = readFlag("--startup-id");
  if (serviceRoot === undefined || startupId === undefined) return null;
  return { entrypoint: argv[1] ?? argv[0], serviceRoot, startupId };
}

function splitWindowsCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < commandLine.length; index++) {
    const character = commandLine[index];
    if (character === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && character === " ") { if (current) { parts.push(current); current = ""; } continue; }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function inspectWindowsProcess(pid: number): ProcessInspection {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -First 1 ExecutablePath,CommandLine; if($p){[Console]::Out.Write(($p|ConvertTo-Json -Compress))}`;
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const output = result.stdout ? new TextDecoder().decode(result.stdout).trim() : "";
  if (!output) return { exists: false };
  try {
    const parsed = JSON.parse(output) as { ExecutablePath?: string; CommandLine?: string };
    return { exists: true, entrypoint: parsed.ExecutablePath ?? undefined, argv: parsed.CommandLine ? splitWindowsCommandLine(parsed.CommandLine) : undefined };
  } catch { return { exists: false }; }
}

function inspectPosixProcess(pid: number): ProcessInspection {
  try {
    const bytes = new TextDecoder().decode(require("node:fs").readFileSync(`/proc/${pid}/cmdline`));
    const argv = bytes.split("\0").filter(part => part.length > 0);
    if (!argv.length) return { exists: false };
    return { exists: true, entrypoint: argv[0], argv };
  } catch {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
    const line = result.stdout ? new TextDecoder().decode(result.stdout).trim() : "";
    if (!line || result.exitCode !== 0) return { exists: false };
    return { exists: true, entrypoint: line.split(" ")[0]!, argv: line.split(" ") };
  }
}

export function createBunProcessAdapter(): ServiceProcessAdapter {
  return {
    spawn(argv: readonly string[], env: Readonly<Record<string, string>>, logPath: string): SpawnedService {
      mkdirSync(dirname(logPath), { recursive: true });
      const logDescriptor = openSync(logPath, "a");
      try {
        const child = Bun.spawn([...argv], { env: { ...process.env, ...env }, stdin: "ignore", stdout: logDescriptor, stderr: logDescriptor });
        return { pid: child.pid, unref() { child.unref(); } };
      } finally { closeSync(logDescriptor); }
    },
    async inspect(pid: number): Promise<ProcessInspection> {
      if (!Number.isInteger(pid) || pid <= 0) return { exists: false };
      return process.platform === "win32" ? inspectWindowsProcess(pid) : inspectPosixProcess(pid);
    },
    terminateOwn(): never { throw new Error("SERVICE_TERMINATE_FORBIDDEN"); },
  };
}

export type ExistingServiceVerdict =
  | { kind: "match"; restartRequired: false }
  | { kind: "stale"; processAbsent: boolean }
  | { kind: "indeterminate"; code: string }
  | { kind: "conflict"; code: string }
  | { kind: "drift"; restartRequired: true };

export interface VerifiedTerminationTarget { entrypoint: string; serviceRoot: string; startupId: string }

async function probeHealth(url: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json() as Record<string, unknown>;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

export async function fetchServiceHealth(port: number, timeoutMs = 750): Promise<Record<string, unknown> | undefined> {
  return probeHealth(`http://127.0.0.1:${port}/api/health`, timeoutMs);
}

export async function portFreeProbe(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
    probe.stop(true);
    return true;
  } catch { return false; }
}

export async function terminateVerifiedProcess(adapter: ServiceProcessAdapter, pid: number, expected: VerifiedTerminationTarget, options: { waitMs?: number; sleep?(ms: number): Promise<void>; expectedDigest?: string } = {}): Promise<"terminated" | "absent" | "foreign" | "indeterminate"> {
  const waitMs = options.waitMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let inspection: ProcessInspection;
  try { inspection = await adapter.inspect(pid); } catch { return "indeterminate"; }
  if (!inspection.exists) return "absent";
  const liveIdentity = inspection.argv ? extractWorkerIdentityFromArgv(inspection.argv) : null;
  if (!liveIdentity) return "foreign";
  if (liveIdentity.entrypoint !== expected.entrypoint || liveIdentity.serviceRoot !== expected.serviceRoot || liveIdentity.startupId !== expected.startupId) return "foreign";
  if (options.expectedDigest && processDigestFromIdentity(liveIdentity) !== options.expectedDigest) return "foreign";
  if (process.platform === "win32") {
    const killed = Bun.spawnSync(["taskkill", "/F", "/PID", String(pid), "/T"], { stdout: "pipe", stderr: "pipe" });
    if (killed.exitCode !== 0) return "indeterminate";
  } else {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "indeterminate"; }
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    let stillThere: boolean;
    try { stillThere = (await adapter.inspect(pid)).exists; } catch { return "indeterminate"; }
    if (!stillThere) return "terminated";
    if (Date.now() >= deadline) return "indeterminate";
    await sleep(50);
  }
}

export interface ExistingServiceEvidence {
  expected: {
    instanceId: string;
    effectiveConfigDigest: string;
    engineVersion: string;
    workerEntrypoint: string;
    expectedServiceRoot: string;
    recordedProcessDigest: string;
  };
  process: ProcessInspection;
  portOwnedByListener: boolean;
  health?: Record<string, unknown>;
}

export function classifyExistingService(evidence: ExistingServiceEvidence): ExistingServiceVerdict {
  const { expected, process, health } = evidence;
  if (!process.exists) return { kind: "stale", processAbsent: true };
  if (!health || typeof health !== "object") return { kind: "indeterminate", code: "HEALTH_UNAVAILABLE" };
  if (health.mode !== "service") return { kind: "conflict", code: "FOREIGN_LISTENER" };
  if (health.instance_id !== expected.instanceId) return { kind: "conflict", code: "INSTANCE_CONFLICT" };
  if (health.effective_config_digest !== expected.effectiveConfigDigest) return { kind: "conflict", code: "CONFIG_CONFLICT" };
  if (health.engine_version !== expected.engineVersion) return { kind: "conflict", code: "ENGINE_CONFLICT" };
  const liveIdentity = process.argv ? extractWorkerIdentityFromArgv(process.argv) : null;
  if (!liveIdentity) return { kind: "conflict", code: "FOREIGN_LISTENER" };
  const liveProcessDigest = processDigestFromIdentity(liveIdentity);
  if (health.process_digest !== expected.recordedProcessDigest && health.process_digest !== liveProcessDigest) {
    return { kind: "conflict", code: "PROCESS_CONFLICT" };
  }
  if (liveIdentity.serviceRoot !== expected.expectedServiceRoot) return { kind: "conflict", code: "ROOT_CONFLICT" };
  if (liveIdentity.entrypoint !== expected.workerEntrypoint || liveProcessDigest !== expected.recordedProcessDigest) {
    return { kind: "drift", restartRequired: true };
  }
  return { kind: "match", restartRequired: false };
}
