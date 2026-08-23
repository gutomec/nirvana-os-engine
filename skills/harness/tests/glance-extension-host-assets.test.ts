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
