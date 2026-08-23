import { expect, test } from "bun:test";
import { ExtensionHostController } from "../lib/glance/views/extension-host.js";

function runtime(overrides: Record<string, unknown> = {}) {
  let now = 100;
  const audits: unknown[] = [];
  const opened = { opener: {} as unknown };
  const hostRoot = { contains: (target: unknown) => target === confirmControl || target === cancelControl };
  const confirmControl = { id: "confirm" };
  const cancelControl = { id: "cancel" };
  const textTarget = { textContent: "" };
  const statusTarget = { textContent: "" };
  const calls: unknown[][] = [];
  return {
    value: {
      manifestHosts: ["github.com"], coreHosts: ["github.com"], hostRoot,
      confirmControl, cancelControl, textTarget, statusTarget,
      monotonicNow: () => now,
      audit: (event: unknown) => audits.push(event),
      open: (...args: unknown[]) => { calls.push(args); return opened; },
      ...overrides,
    },
    confirmControl, cancelControl, audits, calls, opened, textTarget, statusTarget,
    advance: (ms: number) => { now += ms; },
  };
}

const trusted = (target: unknown, extra: Record<string, unknown> = {}) => ({
  isTrusted: true, currentTarget: target, type: "click", ...extra,
});

test("EXT-OPEN-MANIFEST-INTERSECTION accepts only exact allowlisted GitHub HTTPS", () => {
  const cases = [
    "http://github.com/gutomec/nirvana-os-engine", "https://sub.github.com/a", "https://github.com.evil.test/a",
    "https://user:pass@github.com/a", "https://github.com:443/a", "https://github.com:444/a", "https://github.com/a#token",
    "https://ＧＩＴＨＵＢ.com/a", "https://*.github.com/a", "//github.com/a",
  ];
  for (const url of cases) {
    const h = runtime();
    expect(() => new ExtensionHostController(h.value).requestOpen(url, "GitHub", "11111111-1111-4111-8111-111111111111"), url).toThrow("URL_REJECTED");
  }
  const manifestDenied = runtime({ manifestHosts: [] });
  expect(() => new ExtensionHostController(manifestDenied.value).requestOpen("https://github.com/a", "GitHub", "11111111-1111-4111-8111-111111111111")).toThrow("URL_REJECTED");
});

test("EXT-OPEN-POINTER-ENTER-SPACE requires a trusted host-owned control", () => {
  for (const activation of [
    { type: "click" }, { type: "keydown", key: "Enter" }, { type: "keydown", key: " " },
  ]) {
    const h = runtime();
    const controller = new ExtensionHostController(h.value);
    controller.requestOpen("https://github.com/gutomec/nirvana-os-engine", "GitHub", "11111111-1111-4111-8111-111111111111");
    expect(controller.confirm(trusted(h.confirmControl, activation))).toBe(true);
    expect(h.calls).toEqual([["https://github.com/gutomec/nirvana-os-engine", "_blank", "noopener,noreferrer"]]);
    expect(h.opened.opener).toBeNull();
    expect(h.audits).toEqual([{ event: "external_open_confirmed", request_id: "11111111-1111-4111-8111-111111111111", monotonic_ms: 100 }]);
  }
  const h = runtime();
  const controller = new ExtensionHostController(h.value);
  controller.requestOpen("https://github.com/a", "GitHub", "11111111-1111-4111-8111-111111111111");
  expect(controller.confirm({ ...trusted(h.confirmControl), isTrusted: false })).toBe(false);
  expect(controller.confirm(trusted({ id: "iframe-control" }))).toBe(false);
  expect(controller.confirm(trusted(h.cancelControl))).toBe(false);
});

test("EXT-OPEN-CANCEL-EXPIRED-FAILURE never reports an unobserved open", () => {
  const cancelled = runtime();
  const cancelController = new ExtensionHostController(cancelled.value);
  cancelController.requestOpen("https://github.com/a", "GitHub", "11111111-1111-4111-8111-111111111111");
  expect(cancelController.cancel()).toBe(false);
  expect(cancelController.confirm(trusted(cancelled.confirmControl))).toBe(false);

  const expired = runtime();
  const expiredController = new ExtensionHostController(expired.value);
  expiredController.requestOpen("https://github.com/a", "GitHub", "11111111-1111-4111-8111-111111111111");
  expired.advance(30_001);
  expect(expiredController.confirm(trusted(expired.confirmControl))).toBe(false);
  expect(expired.audits).toEqual([{ event: "external_open_expired", request_id: "11111111-1111-4111-8111-111111111111" }]);

  const failed = runtime({ open: () => null });
  const failedController = new ExtensionHostController(failed.value);
  failedController.requestOpen("https://github.com/a", "GitHub", "11111111-1111-4111-8111-111111111111");
  expect(failedController.confirm(trusted(failed.confirmControl))).toBe(false);
  expect(failed.audits).toEqual([{ event: "external_open_failed", request_id: "11111111-1111-4111-8111-111111111111" }]);
});

test("EXT-DOM-PAYLOAD-SCRIPT and EXT-STATUS-TEXT render untrusted strings only through textContent", () => {
  const h = runtime();
  const controller = new ExtensionHostController(h.value);
  controller.renderText('<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>');
  controller.renderStatus("Snapshot expired");
  expect(h.textTarget.textContent).toContain("<script>");
  expect(h.statusTarget.textContent).toBe("Snapshot expired");
});
