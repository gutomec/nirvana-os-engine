import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureLockIdentity,
  createPrivateLockCandidateDirectory,
  removeLockCandidateIfOwned,
  removeLockTokenIfOwned,
  type LockIo,
} from "../../lib/glance/service/lock.ts";
import type { NativeNoReplace } from "../../lib/glance/service/no-replace.ts";
import { fsyncDirectory, restrictDirectory } from "../../lib/glance/service/permissions.ts";
import { validateLockOwner } from "../../lib/glance/service/schema-validator.ts";
import {
  createPrivateWriteTestHarness,
  readStateFileStrict,
  writeDurableJson,
  writePrivateBytes,
  type PrivateWriteOperation,
} from "../../lib/glance/service/state.ts";

export type LockFailure =
  | "none"
  | "token-write"
  | "owner-write"
  | "file-fsync"
  | "close"
  | "directory-fsync"
  | "reread"
  | "validation"
  | "native-noncollision"
  | "native-eacces-with-existing-destination"
  | "substitute-candidate"
  | "substitute-token"
  | "cleanup-both";

const text = new TextEncoder();
const foreignToken = text.encode("foreign-token");

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function injected(operation: string): Error {
  return new Error(`INJECTED:${operation}`);
}

function collisionCode(): number {
  return process.platform === "win32" ? 183 : 17;
}

export function validLockOwner() {
  const acquired = new Date("2026-08-23T12:00:00.000Z");
  const expires = new Date(acquired.getTime() + 30_000);
  return {
    schema_version: "1.0.0",
    owner_id: "00000000-0000-4000-8000-000000000001",
    manager_pid: 1,
    operation: "start",
    target: {
      nirvana_home_digest: `sha256:${"1".repeat(64)}`,
      scope: "global",
      port: 3737,
    },
    acquired_at: acquired.toISOString(),
    expires_at: expires.toISOString(),
    token_ref: "secrets/00000000-0000-4000-8000-000000000002.manager",
    token_digest: `sha256:${createHash("sha256").update(new Uint8Array([1])).digest("hex")}`,
  };
}

export function makeLockIo(failure: LockFailure = "none") {
  const root = mkdtempSync(join(tmpdir(), "glance-lock-"));
  restrictDirectory(root);
  const destination = join(root, "manager.lock");
  const events: string[] = [];
  const cleanupAttempts: string[] = [];
  let candidatePath = "";
  let tokenPath = "";
  let expectedToken = new Uint8Array();
  let foreignCandidatePath = "";

  if (failure === "native-eacces-with-existing-destination") {
    createPrivateLockCandidateDirectory(destination);
    writeFileSync(join(destination, "foreign.txt"), "foreign-destination");
  }

  const failPrivateWrite = (target: PrivateWriteOperation) =>
    createPrivateWriteTestHarness((operation, perform) => {
      events.push(operation);
      if (operation === target) throw injected(operation);
      perform();
    });

  const writeToken = (candidate: string, token: Uint8Array) => {
    events.push("token-write");
    if (failure === "token-write") throw injected("token-write");
    tokenPath = join(candidate, ".owner-token");
    expectedToken = token.slice();
    if (failure === "file-fsync") failPrivateWrite("file-fsync").write(tokenPath, token);
    else if (failure === "close") failPrivateWrite("close").write(tokenPath, token);
    else if (failure === "directory-fsync") failPrivateWrite("directory-fsync").write(tokenPath, token);
    else if (failure === "reread") failPrivateWrite("reread").write(tokenPath, token);
    else writePrivateBytes(tokenPath, token);
  };

  const native: NativeNoReplace = {
    publish(candidate, target) {
      events.push("native-publish");
      if (failure === "native-noncollision" || failure === "native-eacces-with-existing-destination") {
        return { ok: false, code: 13, name: "EACCES" };
      }
      if (existsSync(target)) return { ok: false, code: collisionCode(), name: process.platform === "win32" ? "ERROR_ALREADY_EXISTS" : "EEXIST" };
      renameSync(candidate, target);
      return { ok: true };
    },
  };

  const io: LockIo = {
    candidate(operation) {
      candidatePath = join(root, `.${operation}.candidate`);
      return candidatePath;
    },
    destination,
    mkdir(path) {
      events.push("mkdir");
      createPrivateLockCandidateDirectory(path);
    },
    identity(path) {
      events.push("identity");
      return captureLockIdentity(path);
    },
    writeToken,
    writeOwner(candidate, owner) {
      events.push("owner-write");
      if (failure === "owner-write") throw injected("owner-write");
      writeDurableJson(join(candidate, "owner.json"), owner);
    },
    secureAndSync(candidate) {
      events.push("secure-and-sync");
      restrictDirectory(candidate);
      fsyncDirectory(candidate);
    },
    rereadAndValidate(candidate) {
      events.push("reread-and-validate");
      readStateFileStrict(join(candidate, "owner.json"), validateLockOwner, { read: readFileSync, archive() { throw new Error("archive not allowed"); } });
      if (!sameBytes(readFileSync(tokenPath), expectedToken)) throw injected("validation");
      if (failure === "validation" || failure === "cleanup-both") throw injected("validation");
      if (failure === "substitute-candidate") {
        rmSync(candidate, { recursive: true, force: true });
        createPrivateLockCandidateDirectory(candidate);
        writeFileSync(join(candidate, "foreign.txt"), "foreign-candidate");
        writeFileSync(join(candidate, ".owner-token"), foreignToken);
        foreignCandidatePath = candidate;
        throw injected("candidate-substitution");
      }
      if (failure === "substitute-token") {
        writeFileSync(tokenPath, foreignToken);
        throw injected("token-substitution");
      }
    },
    removeIfIdentity(path, identity) {
      cleanupAttempts.push("candidate");
      if (failure === "cleanup-both") throw injected("candidate-cleanup");
      removeLockCandidateIfOwned(path, identity, join(path, ".owner-token"), expectedToken);
    },
    removeTokenIfOwned(candidate, token) {
      cleanupAttempts.push("token");
      if (failure === "cleanup-both") throw injected("token-cleanup");
      removeLockTokenIfOwned(join(candidate, ".owner-token"), token);
    },
    native,
  };

  const listCandidates = () => existsSync(root)
    ? readdirSync(root).filter(name => name.endsWith(".candidate")).map(name => join(root, name))
    : [];
  const listTokens = () => {
    const paths: string[] = [];
    const visit = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name === ".owner-token") paths.push(path);
      }
    };
    visit(root);
    return paths;
  };

  return Object.assign(io, {
    root,
    events,
    cleanupAttempts,
    candidatePaths: listCandidates,
    tokenPaths: listTokens,
    foreignCandidateIntact: () => foreignCandidatePath !== "" && readFileSync(join(foreignCandidatePath, "foreign.txt"), "utf8") === "foreign-candidate",
    foreignTokenIntact: () => tokenPath !== "" && existsSync(tokenPath) && sameBytes(readFileSync(tokenPath), foreignToken),
    destinationOwner: () => JSON.parse(readFileSync(join(destination, "owner.json"), "utf8")),
    destinationToken: () => readFileSync(join(destination, ".owner-token")),
    destinationForeignMarker: () => readFileSync(join(destination, "foreign.txt"), "utf8"),
    destinationEntries: () => readdirSync(destination).sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  });
}
