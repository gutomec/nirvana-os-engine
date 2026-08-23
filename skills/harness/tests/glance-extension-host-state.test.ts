import { expect, test } from "bun:test";
import { makeHostHarness, type ChannelHarness } from "./helpers/glance-extension-host-harness.ts";

const ready = (h: ChannelHarness, sequence = 0, overrides: Record<string, unknown> = {}) => ({
  schema_version: "1.0.0", protocol: "glance.extension.messages", session_id: h.sessionId,
  sequence, type: "extension.ready", payload: { ui_version: "1.0.0", accepted_envelope_versions: ["1.0.0"] }, ...overrides,
});
const request = (h: ChannelHarness, sequence: number) => ({
  schema_version: "1.0.0", protocol: "glance.extension.messages", session_id: h.sessionId,
  sequence, type: "extension.open_external_url",
  payload: { request_id: "11111111-1111-4111-8111-111111111111", url: "https://github.com/gutomec/nirvana-os-engine", display_label: "GitHub" },
});

test("EXT-CONTRACT-HOST-EXTENSION-MESSAGECHANNEL transfers one real port and activates only after ready zero", async () => {
  const h = makeHostHarness();
  h.connect();
  await h.flush();
  expect(h.received).toHaveLength(1);
  expect(h.received[0]).toMatchObject({ type: "host.init", sequence: 0, session_id: h.sessionId, payload: { theme: "apple" } });
  expect(Object.keys((h.received[0] as any).payload.tokens)).toHaveLength(12);
  h.send(ready(h));
  await h.flush();
  expect(h.state()).toBe("active");
  h.close();
  await h.flush();
  expect(h.events.at(-1)).toEqual({ event: "extension_channel_closed", reason: "host_shutdown" });
  expect(h.closedCounts()).toEqual({ host: 1, extension: 1 });
  expect(h.listenerCounts()).toEqual({ window: 0, confirm: 0, cancel: 0 });
});

test("EXT-HOST-THEMES accepts only the three normative theme names", async () => {
  for (const theme of ["apple", "apple-dark", "awwwards"]) {
    const h = makeHostHarness({ theme });
    expect(h.state(), theme).toBe("bootstrapping");
    h.close();
    await h.flush();
  }
  expect(() => makeHostHarness({ theme: "system" })).toThrow("theme invalid");
});

const REJECTIONS = [
  { id: "EXT-HOST-SOURCE", sequence: -1, drive: (h: ChannelHarness) => h.connect({ source: h.foreignWindow }) },
  { id: "EXT-HOST-ORIGIN", sequence: -1, drive: (h: ChannelHarness) => h.connect({ origin: "https://example.test" }) },
  { id: "EXT-HOST-ACTIVATE-BEFORE-BOOTSTRAP", sequence: 0, drive: (h: ChannelHarness) => h.sendBeforeConnect(ready(h)) },
  { id: "EXT-HOST-LATE-BOOTSTRAP", sequence: -1, drive: (h: ChannelHarness) => { h.advance(5001); h.connect(); } },
  { id: "EXT-HOST-DUP-BOOTSTRAP", sequence: -1, drive: (h: ChannelHarness) => { h.connect(); h.connect(); } },
  { id: "EXT-HOST-SESSION", sequence: 0, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h, 0, { session_id: "b".repeat(64) })); } },
  { id: "EXT-HOST-DIRECTION", sequence: 0, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h, 0, { type: "host.init" })); } },
  { id: "EXT-HOST-INVALID-SCHEMA", sequence: 0, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h, 0, { schema_version: "2.0.0" })); } },
  { id: "EXT-HOST-SEQUENCE-REPEAT", sequence: 0, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h)); h.send(request(h, 0)); } },
  { id: "EXT-HOST-SEQUENCE-REGRESS", sequence: 0, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h)); h.send(request(h, 1)); h.send(request(h, 0)); } },
  { id: "EXT-HOST-SEQUENCE-SKIP", sequence: 2, drive: (h: ChannelHarness) => { h.connect(); h.send(ready(h)); h.send(request(h, 2)); } },
  { id: "EXT-HOST-READY-TIMEOUT", sequence: -1, drive: (h: ChannelHarness) => { h.connect(); h.advance(5001); } },
] as const;

test.each(REJECTIONS)("$id closes the production channel with one redacted rejection", async ({ drive, sequence }) => {
  const h = makeHostHarness();
  drive(h);
  await h.flush();
  expect(h.events.at(-1)).toEqual({ event: "extension_message_rejected", sequence });
  expect(JSON.stringify(h.events.at(-1))).not.toContain(h.sessionId);
  expect(h.state()).not.toBe("active");
  expect(h.closedCounts()).toEqual({ host: 1, extension: 1 });
  expect(h.listenerCounts()).toEqual({ window: 0, confirm: 0, cancel: 0 });
});

test("EXT-HOST-INVALID-INIT leaves no ready timer after terminal cleanup", async () => {
  const h = makeHostHarness({ tokens: {} });
  h.connect();
  await h.flush();
  expect(h.state()).toBe("rejected");
  expect(h.events).toEqual([{ event: "extension_message_rejected", sequence: 0 }]);
  expect(h.listenerCounts()).toEqual({ window: 0, confirm: 0, cancel: 0 });
  expect(h.closedCounts()).toEqual({ host: 1, extension: 1 });
  expect(h.pendingTimerCount()).toBe(0);
});

test("EXT-HOST-AFTER-CLOSE-IS-DISCARDED observes the real platform port after-close behavior", async () => {
  const h = makeHostHarness();
  h.connect(); h.send(ready(h));
  await h.flush();
  expect(h.state()).toBe("active");
  const deliveredBefore = h.inboundDeliveries();
  const eventsBefore = h.events.length;
  h.close("host_shutdown");
  await h.flush();
  h.sendAfterClose(request(h, 1));
  await h.flush();
  expect(h.inboundDeliveries()).toBe(deliveredBefore);
  expect(h.events.length).toBe(eventsBefore + 1);
  expect(h.state()).toBe("closed");
});
