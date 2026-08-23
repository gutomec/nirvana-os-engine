import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validRecord } from "./glance-extension-fixtures.ts";
import { startGlanceProcess } from "./glance-extension-host-harness.ts";
import { runBrowserContract } from "../fixtures/glance/browser-probe/real-browser-contract.ts";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
  sessionId?: string;
}

const DEFAULT_CDP_OPERATION_TIMEOUT_MS = 30_000;

class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<(message: CdpMessage) => void>>();
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  private constructor(
    private socket: WebSocket,
    private readonly operationTimeoutMs: number,
  ) {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CDP_CLOSED"));
      }
      this.pending.clear();
      this.listeners.clear();
      this.resolveClosed();
    });
  }

  static async connect(
    url: string,
    operationTimeoutMs = DEFAULT_CDP_OPERATION_TIMEOUT_MS,
  ): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP_CONNECT_TIMEOUT")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP_CONNECT_FAILED")); }, { once: true });
    });
    return new CdpConnection(socket, operationTimeoutMs);
  }

  private async receive(raw: unknown) {
    const text = typeof raw === "string" ? raw : raw instanceof Blob ? await raw.text() : new TextDecoder().decode(raw as ArrayBuffer);
    const message = JSON.parse(text) as CdpMessage;
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`CDP:${message.error.code}:${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method ?? "") ?? []) listener(message);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const packet: CdpMessage = { id, method, params };
    if (sessionId) packet.sessionId = sessionId;
    this.socket.send(JSON.stringify(packet));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_COMMAND_TIMEOUT:${method}`));
      }, this.operationTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  on(method: string, listener: (message: CdpMessage) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  waitFor(method: string, sessionId: string, timeout = this.operationTimeoutMs): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`CDP_EVENT_TIMEOUT:${method}`)); }, timeout);
      const off = this.on(method, (message) => {
        if (message.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(message);
      });
    });
  }

  isClosed() { return this.closed; }

  async close() {
    if (this.closed) return;
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close();
    await this.closedPromise;
  }
}

export const glanceRealBrowserInternals = { CdpConnection };

async function devtoolsUrl(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stream = child.stderr;
  if (!stream || typeof stream === "number") throw new Error("BROWSER_STDERR_UNAVAILABLE");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read = (async () => {
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("BROWSER_DEVTOOLS_URL_MISSING");
      buffer += decoder.decode(value, { stream: true });
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) return match[1];
    }
  })();
  return Promise.race([
    read,
    Bun.sleep(12_000).then(() => { throw new Error("BROWSER_LAUNCH_TIMEOUT"); }),
  ]);
}

async function browserProcessIds(profile: string): Promise<number[]> {
  if (process.platform === "win32") {
    const probe = Bun.spawn([
      "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$needle=$env:GLANCE_BROWSER_PROFILE; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
    ], {
      env: { ...process.env, GLANCE_BROWSER_PROFILE: profile },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`BROWSER_PROCESS_PROBE_FAILED:${stderr.trim()}`);
    return stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
  }
  const probe = Bun.spawn(["ps", "-axo", "pid=,command="], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`BROWSER_PROCESS_PROBE_FAILED:${stderr.trim()}`);
  return stdout.split(/\r?\n/).filter((line) => line.includes(profile)).map((line) => Number(/^\s*(\d+)/.exec(line)?.[1])).filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function waitForBrowserProcessTreeExit(profile: string, timeout: number): Promise<number[]> {
  const deadline = Date.now() + timeout;
  let remaining: number[] = [];
  do {
    remaining = await browserProcessIds(profile);
    if (remaining.length === 0) return remaining;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  return remaining;
}

async function closeBrowserProcessTree(profile: string): Promise<number[]> {
  let remaining = await waitForBrowserProcessTreeExit(profile, 2_000);
  if (remaining.length === 0) return remaining;
  for (const pid of remaining) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  remaining = await waitForBrowserProcessTreeExit(profile, 5_000);
  if (remaining.length === 0) return remaining;
  for (const pid of remaining) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return waitForBrowserProcessTreeExit(profile, 5_000);
}

export interface BrowserCleanupObservation {
  processIds: number[];
  childExited: boolean;
  connectionClosed: boolean;
  profileRemoved: boolean;
}

export interface RealBrowserExecutionOptions {
  onLaunch?(value: { pid: number; profile: string }): void;
  afterConnect?(): void;
  onCleanup?(value: BrowserCleanupObservation): void;
}

export async function executeRealBrowser(options: RealBrowserExecutionOptions = {}): Promise<any> {
  const browser = process.env.GLANCE_TEST_BROWSER;
  if (!browser) throw new Error("GLANCE_TEST_BROWSER_REQUIRED");
  if (!existsSync(browser)) throw new Error("GLANCE_TEST_BROWSER_NOT_FOUND");

  const fixtureRoot = join(import.meta.dir, "../fixtures/glance/browser-probe");
  const glance = await startGlanceProcess({
    extension: validRecord,
    dataset: "valid",
    scope: "global",
    uiBytes: readFileSync(join(fixtureRoot, "iframe.html")),
    payload: { markup: '<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>' },
  });
  const profile = mkdtempSync(join(tmpdir(), "glance-browser-profile-"));
  const child = Bun.spawn([
    browser,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--host-resolver-rules=MAP github.com ~NOTFOUND",
    "about:blank",
  ], { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });

  let cdp: CdpConnection | undefined;
  let result: any;
  let browserProcessExited = false;
  try {
    options.onLaunch?.({ pid: child.pid, profile });
    const wsUrl = await devtoolsUrl(child);
    cdp = await CdpConnection.connect(wsUrl);
    options.afterConnect?.();
    const initialTargets = await cdp.send("Target.getTargets");
    const persistentTargets = new Set<string>(initialTargets.targetInfos.filter((item: any) => item.type === "page").map((item: any) => item.targetId));
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const hostTargetId = created.targetId as string;
    persistentTargets.add(hostTargetId);
    const attached = await cdp.send("Target.attachToTarget", { targetId: hostTargetId, flatten: true });
    const sessionId = attached.sessionId as string;
    if (!sessionId) throw new Error("CDP_SESSION_MISSING");

    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${glance.port}/` }, sessionId);
    await loaded;

    const evaluate = async (expression: string, targetSessionId = sessionId) => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }, targetSessionId);
      if (result.exceptionDetails) throw new Error(`BROWSER_EVALUATION_FAILED:${result.exceptionDetails.text}`);
      return result.result?.value;
    };
    const waitUntil = async (expression: string, targetSessionId = sessionId) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await evaluate(expression, targetSessionId)) return;
        await Bun.sleep(25);
      }
      throw new Error(`BROWSER_OBSERVATION_TIMEOUT:${expression}`);
    };
    await waitUntil("typeof glance === 'function'");
    try {
      await waitUntil("document.querySelector('#glance-extension-nav-fixture-ext') !== null");
    } catch {
      await evaluate(`(async () => {
        const app = glance();
        app.$watch = () => {};
        app.$nextTick = callback => queueMicrotask(callback);
        window.__glanceManualApp = app;
        await app.boot();
      })()`);
      await waitUntil("document.querySelector('#glance-extension-nav-fixture-ext') !== null");
    }

    const mouse = async (x: number, y: number, targetSessionId = sessionId) => {
      await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, targetSessionId);
      await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, targetSessionId);
    };
    const rect = async (selector: string, targetSessionId = sessionId) => evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`, targetSessionId);
    const clickHost = async (selector: string) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center'})`);
      const value = await rect(selector);
      await mouse(value.x + value.width / 2, value.y + value.height / 2);
    };
    await clickHost("#glance-extension-nav-fixture-ext");
    try {
      await waitUntil("document.querySelector('#glance-extension-status')?.textContent === 'Snapshot loaded'");
    } catch (error) {
      const observation = await evaluate("({status:document.querySelector('#glance-extension-status')?.textContent,src:document.querySelector('#glance-extension-frame')?.src,audit:document.querySelector('#glance-extension-status')?.dataset.auditEvent})");
      throw new Error(`${error instanceof Error ? error.message : error}:${JSON.stringify(observation)}`);
    }
    await evaluate(`(() => {
      window.__testOriginalOpen = window.open.bind(window);
      window.__monotonicOffset = 0;
      const originalNow = performance.now.bind(performance);
      Object.defineProperty(performance, 'now', { configurable: true, value: () => originalNow() + window.__monotonicOffset });
    })()`);

    let iframeSessionId: string | undefined;
    let iframeTargetFrameId: string | undefined;
    let iframeExecutionContextFrameId: string | undefined;
    const frameInfo = async () => {
      if (iframeSessionId && iframeTargetFrameId && iframeExecutionContextFrameId) {
        return {
          targetFrameId: iframeTargetFrameId,
          executionContextFrameId: iframeExecutionContextFrameId,
          sessionId: iframeSessionId,
        };
      }
      const deadline = Date.now() + 10_000;
      let target: any;
      while (!target && Date.now() < deadline) {
        const targets = await cdp!.send("Target.getTargets");
        target = targets.targetInfos.find((item: any) => item.type === "iframe" && item.url.endsWith("/extensions/fixture-ext/ui/index.html"));
        if (!target) await Bun.sleep(25);
      }
      if (!target) throw new Error("IFRAME_TARGET_MISSING");
      const attachedIframe = await cdp!.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      iframeSessionId = attachedIframe.sessionId;
      if (!iframeSessionId) throw new Error("IFRAME_CDP_SESSION_MISSING");
      let resolveExecutionContext!: (frameId: string) => void;
      const executionContextFrame = new Promise<string>((resolve) => { resolveExecutionContext = resolve; });
      const removeExecutionContextListener = cdp!.on("Runtime.executionContextCreated", (message) => {
        if (message.sessionId !== iframeSessionId || iframeExecutionContextFrameId) return;
        const auxData = message.params?.context?.auxData;
        if (auxData?.isDefault !== true || typeof auxData.frameId !== "string" || !auxData.frameId) return;
        iframeExecutionContextFrameId = auxData.frameId;
        resolveExecutionContext(auxData.frameId);
      });
      try {
        await cdp!.send("Runtime.enable", {}, iframeSessionId);
        await cdp!.send("Page.enable", {}, iframeSessionId);
        const tree = await cdp!.send("Page.getFrameTree", {}, iframeSessionId);
        iframeTargetFrameId = tree.frameTree.frame.id;
        if (!iframeTargetFrameId) throw new Error("IFRAME_TARGET_FRAME_ID_MISSING");
        iframeExecutionContextFrameId = await Promise.race([
          executionContextFrame,
          Bun.sleep(10_000).then(() => { throw new Error("IFRAME_EXECUTION_CONTEXT_FRAME_ID_MISSING"); }),
        ]);
      } finally {
        removeExecutionContextListener();
      }
      return {
        targetFrameId: iframeTargetFrameId,
        executionContextFrameId: iframeExecutionContextFrameId,
        sessionId: iframeSessionId,
      };
    };
    const iframe = await frameInfo();
    await waitUntil("document.querySelector('#request-open') !== null && document.querySelector('#payload').textContent.length > 0", iframe.sessionId);

    let lastOpenerNull = false;

    const probe = {
      async browserVersion() {
        const value = await cdp!.send("Browser.getVersion", {}, iframe.sessionId);
        return { ...value, cdpSessionId: iframe.sessionId };
      },
      async requestFromIframe() {
        const target = await frameInfo();
        const inner = await rect("#request-open", target.sessionId);
        await mouse(inner.x + inner.width / 2, inner.y + inner.height / 2, target.sessionId);
        await waitUntil("document.querySelector('#request-open').dataset.eventType === 'click'", target.sessionId);
        await waitUntil("document.querySelector('#glance-extension-confirm').hidden === false");
        const observed = await evaluate(`(() => { const b=document.querySelector('#request-open'); return { trusted:b.dataset.eventTrusted, type:b.dataset.eventType, messageType:b.dataset.messageType }; })()`, target.sessionId);
        return {
          eventTrusted: observed.trusted === "true",
          eventType: observed.type,
          frameId: target.executionContextFrameId,
          targetFrameId: target.targetFrameId,
          messageType: observed.messageType,
          cdpSessionId: target.sessionId,
        };
      },
      async confirmPointer() { await clickHost("#glance-extension-confirm"); },
      async confirmKeyboard(key: "Enter" | " ") {
        await evaluate("document.querySelector('#glance-extension-confirm').focus()");
        const code = key === "Enter" ? "Enter" : "Space";
        const windowsVirtualKeyCode = key === "Enter" ? 13 : 32;
        await cdp!.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode }, sessionId);
        await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }, sessionId);
      },
      async cancelPointer() { await clickHost("#glance-extension-cancel"); },
      async cancelEscape() {
        const before = await this.pageCount();
        await cdp!.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
        await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
        await Bun.sleep(50);
        return {
          opened: (await this.pageCount()) - before,
          focusId: await evaluate("document.activeElement?.id || ''"),
        };
      },
      async confirmSynthetic() { await evaluate("document.querySelector('#glance-extension-confirm').click()"); },
      async advanceMonotonic(ms: number) { await evaluate(`window.__monotonicOffset += ${JSON.stringify(ms)}`); },
      async setOpenMode(mode: "normal" | "failure") {
        await evaluate(mode === "failure" ? "window.open = () => null" : "window.open = window.__testOriginalOpen");
      },
      async pageCount() {
        const targets = await cdp!.send("Target.getTargets");
        return targets.targetInfos.filter((item: any) => item.type === "page").length;
      },
      async closePopups() {
        const targets = await cdp!.send("Target.getTargets");
        let sawPopup = false;
        let popupOpenerNull = true;
        for (const item of targets.targetInfos) {
          if (item.type !== "page" || persistentTargets.has(item.targetId)) continue;
          sawPopup = true;
          const attachedPopup = await cdp!.send("Target.attachToTarget", { targetId: item.targetId, flatten: true });
          await cdp!.send("Runtime.enable", {}, attachedPopup.sessionId);
          const observed = await cdp!.send("Runtime.evaluate", { expression: "window.opener === null", returnByValue: true }, attachedPopup.sessionId);
          popupOpenerNull &&= observed.result?.value === true;
          await cdp!.send("Target.closeTarget", { targetId: item.targetId });
        }
        if (sawPopup) lastOpenerNull = popupOpenerNull;
      },
      async failureReported() { return Boolean(await evaluate("document.querySelector('#glance-extension-status')?.dataset.auditEvent === 'external_open_failed'")); },
      async openerWasNull() { return lastOpenerNull; },
      async baseline() {
        await cdp!.send("Emulation.setDeviceMetricsOverride", { width: 759, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        const at759 = await evaluate("({panel:getComputedStyle(document.querySelector('#glance-extension-panel')).display})");
        await cdp!.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        const at760 = await evaluate("({panel:getComputedStyle(document.querySelector('#glance-extension-panel')).display})");

        const layoutTarget = await cdp!.send("Target.createTarget", { url: `http://127.0.0.1:${glance.port}/extensions/fixture-ext/ui/index.html` });
        const layoutAttached = await cdp!.send("Target.attachToTarget", { targetId: layoutTarget.targetId, flatten: true });
        const layoutSessionId = layoutAttached.sessionId as string;
        if (!layoutSessionId) throw new Error("LAYOUT_CDP_SESSION_MISSING");
        let inner759: any;
        let inner760: any;
        try {
          await cdp!.send("Runtime.enable", {}, layoutSessionId);
          await cdp!.send("Page.enable", {}, layoutSessionId);
          await waitUntil("document.querySelector('#cards') !== null && document.querySelector('#table') !== null", layoutSessionId);
          await cdp!.send("Emulation.setDeviceMetricsOverride", { width: 759, height: 900, deviceScaleFactor: 1, mobile: false }, layoutSessionId);
          inner759 = await evaluate("({cards:getComputedStyle(document.querySelector('#cards')).display,table:getComputedStyle(document.querySelector('#table')).display})", layoutSessionId);
          await cdp!.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, layoutSessionId);
          inner760 = await evaluate("({cards:getComputedStyle(document.querySelector('#cards')).display,table:getComputedStyle(document.querySelector('#table')).display})", layoutSessionId);
        } finally {
          await cdp!.send("Target.closeTarget", { targetId: layoutTarget.targetId });
        }
        await evaluate("document.querySelector('#glance-extension-confirm').focus()");
        const main = await evaluate("({focus:getComputedStyle(document.querySelector('#glance-extension-confirm')).outlineStyle,status:document.querySelector('#glance-extension-status').textContent,sandbox:document.querySelector('#glance-extension-frame').getAttribute('sandbox'),src:new URL(document.querySelector('#glance-extension-frame').src).pathname,outside:!document.querySelector('#glance-extension-frame').contains(document.querySelector('#glance-extension-confirm')),catalog:performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === '/api/extensions')})");
        const frame = await frameInfo();
        const inner = await evaluate("({pwned:window.pwned,payload:document.querySelector('#payload').textContent})", frame.sessionId);
        if (inner.pwned !== false || !inner.payload.includes("<script>")) throw new Error("PAYLOAD_TEXT_OBSERVATION_MISSING");
        return {
          pwned: inner.pwned,
          cards759: inner759.cards, table759: inner759.table, cards760: inner760.cards, table760: inner760.table,
          panel759: at759.panel, panel760: at760.panel,
          focusOutlineStyle: main.focus, statusText: main.status, iframeSandbox: main.sandbox,
          iframeRoute: main.src, catalogRequested: main.catalog, hostControlOutsideIframe: main.outside,
        };
      },
    };

    result = await runBrowserContract(probe);
  } finally {
    try {
      await Promise.race([
        cdp?.send("Browser.close") ?? Promise.resolve(),
        Bun.sleep(2_000).then(() => { throw new Error("BROWSER_CLOSE_TIMEOUT"); }),
      ]);
    } catch {}
    if (child.exitCode === null) {
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited && child.exitCode === null) child.kill("SIGTERM");
    }
    await child.exited;
    browserProcessExited = true;
    await cdp?.close();
    await glance.stop();
    const remainingProcessIds = await closeBrowserProcessTree(profile);
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); cleanupError = undefined; break; }
      catch (error) { cleanupError = error; await Bun.sleep(50); }
    }
    const cleanupObservation = {
      processIds: remainingProcessIds,
      childExited: browserProcessExited,
      connectionClosed: cdp?.isClosed() ?? true,
      profileRemoved: !existsSync(profile),
    };
    options.onCleanup?.(cleanupObservation);
    if (cleanupError) throw cleanupError;
    if (remainingProcessIds.length > 0) throw new Error(`BROWSER_PROCESS_TREE_CLEANUP_FAILED:${remainingProcessIds.join(",")}`);
    if (!browserProcessExited) throw new Error("BROWSER_PROCESS_CLEANUP_FAILED");
    if (cdp && !cdp.isClosed()) throw new Error("BROWSER_CONNECTION_CLEANUP_FAILED");
    if (existsSync(profile)) throw new Error("BROWSER_PROFILE_CLEANUP_FAILED");
  }
  return {
    ...result,
    browserProcessExited,
    browserConnectionClosed: cdp?.isClosed() ?? true,
    browserProfileRemoved: !existsSync(profile),
  };
}
