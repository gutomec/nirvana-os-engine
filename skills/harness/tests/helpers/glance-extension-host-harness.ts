import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestSnapshot } from "../../lib/glance/extensions/canonicalize.ts";
import type { LoadedGlanceExtension } from "../../lib/glance/extensions/types.ts";
import { UI_BYTES, validEnvelope } from "./glance-extension-fixtures.ts";

export interface StartGlanceProcessOptions {
  extension: LoadedGlanceExtension;
  dataset: "valid" | "invalid";
  scope: "global" | "project";
}

export interface RunningGlanceProcess {
  port: number;
  home: string;
  stop(): Promise<void>;
}

function pathDigest(value: string): `sha256:${string}` {
  const normalized = resolve(value).replace(/\\/g, "/").replace(/\/$/, "");
  const platformValue = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `sha256:${createHash("sha256").update(platformValue, "utf8").digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reserveLoopbackPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function waitForHealth(port: number, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`GLANCE_EXITED_BEFORE_HEALTH:${await child.exited}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("GLANCE_HEALTH_TIMEOUT");
}

export async function startGlanceProcess(options: StartGlanceProcessOptions): Promise<RunningGlanceProcess> {
  const home = mkdtempSync(join(tmpdir(), "glance-extension-process-"));
  const extensionRoot = join(home, ".nirvana", "glance", "extensions", options.extension.manifest.id);
  mkdirSync(join(extensionRoot, "ui"), { recursive: true });
  mkdirSync(join(extensionRoot, "data"), { recursive: true });
  writeJson(join(extensionRoot, "glance-extension.json"), options.extension.manifest);
  writeFileSync(join(extensionRoot, "ui", "index.html"), UI_BYTES);
  const envelope = validEnvelope(
    options.extension.manifest.id,
    options.scope,
    options.scope === "project" ? pathDigest(home) : undefined,
  );
  const now = new Date().toISOString();
  envelope.freshness.observed_at = now;
  envelope.freshness.state = "fresh";
  envelope.generated_at = now;
  envelope.snapshot_id = digestSnapshot(envelope as unknown as Record<string, unknown>);
  if (options.dataset === "invalid") envelope.payload = { records: [{ altered: true }] };
  writeJson(join(extensionRoot, "data", "snapshot.snapshot.json"), envelope);

  const port = reserveLoopbackPort();
  const glanceScript = join(import.meta.dir, "../../scripts/glance.ts");
  const child = Bun.spawn([
    process.execPath,
    glanceScript,
    "--port",
    String(port),
    "--no-open",
    "--read-only",
  ], {
    cwd: join(import.meta.dir, "../../../.."),
    env: {
      ...process.env,
      NIRVANA_HOME: home,
      NIRVANA_SCOPE: options.scope,
      NIRVANA_SCOPE_QUIET: "1",
      ...(options.scope === "project" ? { NIRVANA_PROJECT_ROOT: home } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    await waitForHealth(port, child);
    return { port, home, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
