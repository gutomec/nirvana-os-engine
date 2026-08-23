import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestSnapshot } from "../../lib/glance/extensions/canonicalize.ts";
import type { LoadedGlanceExtension } from "../../lib/glance/extensions/types.ts";
import {
  EXTENSION_BOOTSTRAP_PACKET,
  mountExtensionHost,
} from "../../lib/glance/views/extension-host.js";
import { UI_BYTES, validEnvelope } from "./glance-extension-fixtures.ts";

export interface ChannelHarness {
  sessionId: string;
  foreignWindow: unknown;
  events: unknown[];
  received: unknown[];
  connect(options?: { source?: unknown; origin?: string }): void;
  send(packet: unknown): void;
  sendBeforeConnect(packet: unknown): void;
  sendAfterClose(packet: unknown): void;
  advance(milliseconds: number): void;
  flush(): Promise<void>;
  close(reason?: string): void;
  state(): string;
  closedCounts(): { host: number; extension: number };
  listenerCounts(): { window: number; confirm: number; cancel: number };
  inboundDeliveries(): number;
}

class CountingEventTarget extends EventTarget {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    if (callback) {
      const values = this.listeners.get(type) ?? new Set();
      values.add(callback);
      this.listeners.set(type, values);
    }
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (callback) this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

export function makeHostHarness(options: { theme?: string } = {}): ChannelHarness {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const windowTarget = new CountingEventTarget();
  const foreignWindow = {};
  const events: unknown[] = [];
  const received: unknown[] = [];
  let extensionPort: MessagePort | undefined;
  let hostPort: MessagePort | undefined;
  let hostClosed = 0;
  let extensionClosed = 0;

  const iframeWindow = {
    postMessage(_packet: unknown, _origin: string, ports: MessagePort[]) {
      extensionPort = ports[0];
      extensionPort.addEventListener("message", (event) => received.push(event.data));
      extensionPort.start();
    },
  };
  const iframe = { contentWindow: iframeWindow };
  const confirmControl = new CountingEventTarget() as CountingEventTarget & { hidden: boolean };
  const cancelControl = new CountingEventTarget() as CountingEventTarget & { hidden: boolean };
  confirmControl.hidden = true;
  cancelControl.hidden = true;
  const hostRoot = { contains: (target: unknown) => target === confirmControl || target === cancelControl };
  const textTarget = { textContent: "" };
  const statusTarget = { textContent: "" };
  const pendingTarget = { textContent: "" };

  const host = mountExtensionHost({
    iframe,
    hostRoot,
    confirmControl,
    cancelControl,
    pendingTarget,
    textTarget,
    statusTarget,
    extensionId: "fixture-ext",
    locale: "pt-BR",
    theme: options.theme ?? "apple",
    tokens: {
      "surface-0": "#fff", "surface-1": "#f8f8f8", "surface-2": "#eee",
      "text-primary": "#111", "text-secondary": "#555", "border-default": "#ccc",
      "border-focus": "#06f", accent: "#06f", "success-fg": "#070",
      "warn-fg": "#850", "danger-fg": "#b00", "space-2": "8px",
    },
    manifestHosts: ["github.com"],
    coreHosts: ["github.com"],
    audit: (event: unknown) => events.push(event),
    monotonicNow: () => now,
    windowTarget,
    cryptoObject: { getRandomValues(bytes: Uint8Array) { bytes.fill(0xab); return bytes; } },
    messageChannelFactory: () => {
      const channel = new MessageChannel();
      hostPort = channel.port1;
      hostPort.addEventListener("close", () => { hostClosed++; }, { once: true });
      channel.port2.addEventListener("close", () => { extensionClosed++; }, { once: true });
      return channel;
    },
    setTimer: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer: (id: number) => { timers.delete(id); },
    open: () => ({ opener: null }),
  });

  const dispatch = (data: unknown, source: unknown, origin: string) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data }, source: { value: source }, origin: { value: origin },
    });
    windowTarget.dispatchEvent(event);
  };
  const advance = (milliseconds: number) => {
    now += milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    }
  };

  return {
    sessionId: host.sessionId,
    foreignWindow,
    events,
    received,
    connect(options = {}) { dispatch(EXTENSION_BOOTSTRAP_PACKET, options.source ?? iframeWindow, options.origin ?? "null"); },
    send(packet) { extensionPort?.postMessage(packet); },
    sendBeforeConnect(packet) { dispatch(packet, iframeWindow, "null"); },
    sendAfterClose(packet) { extensionPort?.postMessage(packet); },
    advance,
    async flush() { await Bun.sleep(5); },
    close(reason = "host_shutdown") { host.close(reason); },
    state: host.state,
    closedCounts: () => ({ host: hostClosed, extension: extensionClosed }),
    listenerCounts: () => ({ window: windowTarget.listenerCount(), confirm: confirmControl.listenerCount(), cancel: cancelControl.listenerCount() }),
    inboundDeliveries: host.inboundDeliveries,
  };
}

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
