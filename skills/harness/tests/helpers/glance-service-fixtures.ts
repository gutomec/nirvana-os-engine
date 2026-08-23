import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateWriteRuntime, type PrivateWriteRuntime } from "../../lib/glance/service/state.ts";

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
  const observePrivateWrite = (overrides: Partial<PrivateWriteRuntime> = {}) => {
    const events: string[] = [];
    const io: PrivateWriteRuntime = {
      fsyncFile: descriptor => { events.push("file-fsync"); return (overrides.fsyncFile ?? privateWriteRuntime.fsyncFile)(descriptor); },
      close: descriptor => { events.push("close"); return (overrides.close ?? privateWriteRuntime.close)(descriptor); },
      rename: (from, to) => { events.push("rename"); return (overrides.rename ?? privateWriteRuntime.rename)(from, to); },
      fsyncDirectory: path => { events.push("directory-fsync"); return (overrides.fsyncDirectory ?? privateWriteRuntime.fsyncDirectory)(path); },
      reread: path => { events.push("reread"); return (overrides.reread ?? privateWriteRuntime.reread)(path); },
      remove: path => { events.push("remove"); return (overrides.remove ?? privateWriteRuntime.remove)(path); },
    };
    return { io, events };
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
