import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { executeRealBrowser } from "./helpers/glance-real-browser.ts";
import {
  runBrowserContract,
  type BrowserProbe,
} from "./fixtures/glance/browser-probe/real-browser-contract.ts";

test("EXT-BROWSER-REQUIRES-LOCAL-BINARY fails instead of skipping when GLANCE_TEST_BROWSER is absent", async () => {
  const saved = process.env.GLANCE_TEST_BROWSER;
  delete process.env.GLANCE_TEST_BROWSER;
  try {
    await expect(executeRealBrowser()).rejects.toThrow("GLANCE_TEST_BROWSER_REQUIRED");
  } finally {
    if (saved) process.env.GLANCE_TEST_BROWSER = saved;
  }
});

test("EXT-BROWSER-FRAME-PROVENANCE rejects independently observed frame mismatch before host actions", async () => {
  const unexpected = async () => { throw new Error("UNEXPECTED_HOST_ACTION"); };
  const probe = {
    browserVersion: async () => ({
      product: "browser", revision: "revision", userAgent: "agent", jsVersion: "js",
      protocolVersion: "protocol", cdpSessionId: "live-session",
    }),
    requestFromIframe: async () => ({
      eventTrusted: true as const, eventType: "click" as const,
      frameId: "execution-context-frame", targetFrameId: "target-frame",
      messageType: "extension.open_external_url" as const, cdpSessionId: "live-session",
    }),
    confirmPointer: unexpected,
    confirmKeyboard: unexpected,
    cancelPointer: unexpected,
    cancelEscape: unexpected,
    confirmSynthetic: unexpected,
    advanceMonotonic: unexpected,
    setOpenMode: unexpected,
    pageCount: unexpected,
    closePopups: unexpected,
    failureReported: unexpected,
    openerWasNull: unexpected,
    baseline: unexpected,
  } satisfies BrowserProbe;
  await expect(runBrowserContract(probe)).rejects.toThrow("IFRAME_FRAME_MISMATCH");
});

test("EXT-BROWSER-CLEANUP-ON-THROW waits for process exit and removes the profile", async () => {
  let launched: { pid: number; profile: string } | undefined;
  let cleanup: { processIds: number[]; childExited: boolean; connectionClosed: boolean; profileRemoved: boolean } | undefined;
  await expect(executeRealBrowser({
    onLaunch(value) { launched = value; },
    afterConnect() { throw new Error("FORCED_BROWSER_CONTRACT_FAILURE"); },
    onCleanup(value) { cleanup = value; },
  })).rejects.toThrow("FORCED_BROWSER_CONTRACT_FAILURE");
  expect(launched).toBeDefined();
  expect(cleanup).toEqual({ processIds: [], childExited: true, connectionClosed: true, profileRemoved: true });
  expect(existsSync(launched!.profile)).toBe(false);
  let processRunning = true;
  try { process.kill(launched!.pid, 0); } catch { processRunning = false; }
  expect(processRunning).toBe(false);
}, 90_000);

test("EXT-BROWSER-REAL-CONTRACT observes the live iframe, trusted inputs, popups and layout", async () => {
  const result = await executeRealBrowser();
  for (const value of [result.browserProduct, result.browserRevision, result.browserUserAgent, result.browserJsVersion, result.browserProtocolVersion]) expect(value).toMatch(/\S/);
  expect(result.browserVersionCdpSessionId).toMatch(/\S/);
  expect(result.assertionCdpSessionId).toBe(result.browserVersionCdpSessionId);
  expect(result.iframeRequestTrusted).toBe(true);
  expect(result.iframeRequestEventType).toBe("click");
  expect(result.iframeRequestFrameId).toMatch(/\S/);
  expect(result.iframeTargetFrameId).toBe(result.iframeRequestFrameId);
  expect(result.iframeRequestFrameMatches).toBe(true);
  expect(result.browserProcessExited).toBe(true);
  expect(result.browserConnectionClosed).toBe(true);
  expect(result.browserProfileRemoved).toBe(true);
  expect(result).toMatchObject({
    iframeTrustedOpened: 1, cancelOpened: 0, escapeOpened: 0,
    escapeFocusId: "glance-extension-nav-fixture-ext", expiredOpened: 0, failedOpenOpened: 0,
    failureReported: true, syntheticOpened: 0, trustedPointerOpened: 1, trustedEnterOpened: 1,
    trustedSpaceOpened: 1, openerIsNull: true, pwned: false, cards759: "grid", table759: "none",
    cards760: "none", table760: "table", focusOutlineStyle: "solid", statusText: "External link could not be opened",
    iframeSandbox: "allow-scripts", iframeRoute: "/extensions/fixture-ext/ui/index.html",
    catalogRequested: true, hostControlOutsideIframe: true,
  });
}, 90_000);
