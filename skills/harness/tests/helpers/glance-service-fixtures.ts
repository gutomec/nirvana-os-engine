import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateWriteTestHarness, type PrivateWriteOperation } from "../../lib/glance/service/state.ts";

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
  const observePrivateWrite = (hook?: (operation: PrivateWriteOperation, perform: () => void, path?: string) => void) => {
    const events: string[] = [];
    const harness = createPrivateWriteTestHarness((operation, perform, path) => {
      events.push(operation);
      if (hook) hook(operation, perform, path); else perform();
    });
    return { write: harness.write, events };
  };
  const assertNoTemporaryResidue = () => {
    const visit = (directory: string) => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.name.endsWith(".tmp")) throw new Error("PRIVATE_STATE_TEMP_RESIDUE");
    });
    visit(root);
  };
  return { root, secret, nonce, secretPath: join(root, "secrets", "secret.control"), noncePath: join(root, "control", "nonces", "nonce.nonce"), assertPrivateAndDurable, observePrivateWrite, assertNoTemporaryResidue, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
