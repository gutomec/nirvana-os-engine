import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createPrivateStateFixture() {
  const root = mkdtempSync(join(tmpdir(), "glance-service-"));
  const secret = new Uint8Array([1, 2, 3]);
  const nonce = new Uint8Array([4, 5, 6]);
  const assertPrivateAndDurable = (paths: readonly string[]) => {
    for (const path of paths) {
      if (!existsSync(path) || !readFileSync(path).length) throw new Error("PRIVATE_STATE_MISSING");
      if (process.platform !== "win32" && (statSync(path).mode & 0o777) !== 0o600) throw new Error("PRIVATE_STATE_MODE");
    }
  };
  return { root, secret, nonce, secretPath: join(root, "secrets", "secret.control"), noncePath: join(root, "control", "nonces", "nonce.nonce"), assertPrivateAndDurable, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
