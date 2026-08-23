import { expect, test } from "bun:test";
import { startGlanceProcess } from "./helpers/glance-extension-host-harness.ts";
import { validRecord } from "./helpers/glance-extension-fixtures.ts";

test("EXT-HOST-PRODUCTION-ASSETS are served by the real Glance process without cache", async () => {
  const running = await startGlanceProcess({ extension: validRecord, dataset: "valid", scope: "global" });
  try {
    for (const asset of ["extension-host.js", "extension-message-validator.js", "extension-message-schema-registry.js", "extension-host.css"]) {
      const response = await fetch(`http://127.0.0.1:${running.port}/${asset}`);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("cache-control"), asset).toBe("no-store");
      expect((await response.text()).length, asset).toBeGreaterThan(20);
    }
  } finally {
    await running.stop();
  }
});

test("EXT-HOST-NO-EXTENSION preserves the legacy Glance root and keeps extension chrome hidden", async () => {
  const running = await startGlanceProcess({
    extension: validRecord,
    dataset: "valid",
    scope: "global",
    installExtension: false,
  });
  try {
    const base = `http://127.0.0.1:${running.port}`;
    const [root, catalog, health] = await Promise.all([
      fetch(`${base}/`).then(response => response.text()),
      fetch(`${base}/api/extensions`).then(response => response.json()),
      fetch(`${base}/api/health`),
    ]);
    expect(health.status).toBe(200);
    expect(catalog.extensions).toEqual([]);
    expect(root).toContain('id="glance-extension-navigation" class="glance-extension-catalog" aria-label="Extensions" hidden');
    expect(root).toContain('id="glance-extension-panel" class="detail-pane glance-extension-pane" hidden');
  } finally {
    await running.stop();
  }
});
