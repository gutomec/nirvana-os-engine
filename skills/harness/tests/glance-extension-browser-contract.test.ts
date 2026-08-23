import { expect, test } from "bun:test";
import { executeRealBrowser } from "./helpers/glance-real-browser.ts";

test("EXT-BROWSER-REQUIRES-LOCAL-BINARY fails instead of skipping when GLANCE_TEST_BROWSER is absent", async () => {
  const saved = process.env.GLANCE_TEST_BROWSER;
  delete process.env.GLANCE_TEST_BROWSER;
  try {
    await expect(executeRealBrowser()).rejects.toThrow("GLANCE_TEST_BROWSER_REQUIRED");
  } finally {
    if (saved) process.env.GLANCE_TEST_BROWSER = saved;
  }
});

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
  expect(result).toMatchObject({
    iframeTrustedOpened: 1, cancelOpened: 0, expiredOpened: 0, failedOpenOpened: 0,
    failureReported: true, syntheticOpened: 0, trustedPointerOpened: 1, trustedEnterOpened: 1,
    trustedSpaceOpened: 1, openerIsNull: true, pwned: false, cards759: "grid", table759: "none",
    cards760: "none", table760: "table", focusOutlineStyle: "solid", statusText: "Snapshot expired",
    iframeSandbox: "allow-scripts", hostControlOutsideIframe: true,
  });
}, 45_000);
