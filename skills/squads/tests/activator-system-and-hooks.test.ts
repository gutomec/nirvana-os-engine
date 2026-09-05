import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");

interface Fixture {
  root: string;
  squadDir: string;
  stateFile: string;
  binDir: string;
}

function fixture(dependencies: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "activator-system-hooks-"));
  const squadDir = join(root, "squads", "fixture-squad");
  const stateFile = join(root, "state", "fixture-squad", "activated.json");
  const binDir = join(root, "bin");
  mkdirSync(squadDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(squadDir, "squad.yaml"), 'name: fixture-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: test\n');
  writeFileSync(join(squadDir, "dependencies.yaml"), dependencies);
  return { root, squadDir, stateFile, binDir };
}

function fakeExecutable(f: Fixture, name: string): void {
  if (process.platform === "win32") {
    writeFileSync(join(f.binDir, `${name}.cmd`), "@exit /b 0\r\n");
  } else {
    writeFileSync(join(f.binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
}

function activate(f: Fixture): { status: number | null; json: any; stderr: string } {
  const result = spawnSync(process.execPath, [ACTIVATOR, "activate", "fixture-squad"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NIRVANA_SKILLS_DIR: join(REPO, "skills"),
      NIRVANA_RESOLVED_SQUAD_PATH: f.squadDir,
      NIRVANA_STATE_DIR: join(f.root, "state"),
      NIRVANA_HOME: f.root,
      PATH: `${f.binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr ?? "" };
}

describe("system executable presence", () => {
  test("a string dependency uses a platform-safe argv probe", () => {
    const f = fixture("system:\n  - nirvana-presence-fixture\n");
    fakeExecutable(f, "nirvana-presence-fixture");
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.steps.system[0].status).toBe("already_present");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("a manifest name cannot become shell syntax", () => {
    const f = fixture('system:\n  - "fixture-tool&echo"\n');
    try {
      const result = activate(f);
      expect(result.json.steps.system[0].status).toBe("invalid_system_tool");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an object without check falls back to its present executable name", () => {
    const f = fixture("system:\n  - name: nirvana-object-fixture\n");
    fakeExecutable(f, "nirvana-object-fixture");
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.steps.system[0].status).toBe("already_present");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an absent object without check reports the missing tool instead of platform incompatibility", () => {
    const f = fixture("system:\n  - name: nirvana-certainly-absent-tool\n");
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.steps.system[0].status).toBe("missing_system_tool");
      expect(result.json.warnings).toHaveLength(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("a plain LICENSE file found by where.exe is not an executable", () => {
    const f = fixture("system:\n  - LICENSE\n");
    writeFileSync(join(f.binDir, "LICENSE"), "not executable\n");
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.steps.system[0].status).toBe("missing_system_tool");
      expect(result.json.warnings).toHaveLength(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("post-install hook contracts", () => {
  test("legacy string and object hooks both succeed", () => {
    const f = fixture([
      "post_install:",
      '  - "exit 0"',
      "  - name: object hook",
      '    command: "exit 0"',
      "",
    ].join("\n"));
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.steps.post_install.items.map((item: any) => item.status)).toEqual(["ok", "ok"]);
      expect(result.json.steps.post_install.items[1].name).toBe("object hook");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an optional failing hook is a warning and does not block activation", () => {
    const f = fixture("post_install:\n  - name: optional hook\n    command: \"exit 7\"\n    optional: true\n");
    try {
      const result = activate(f);
      expect(result.status).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.failures).toHaveLength(0);
      expect(result.json.warnings[0]).toMatchObject({ step: "post_install", name: "optional hook", status: "failed", optional: true });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("a required failing hook exits 1 and preserves existing activation state", () => {
    const f = fixture('post_install:\n  - name: required hook\n    command: "exit 7"\n');
    const previous = '{"marker":"previous-state"}\n';
    mkdirSync(join(f.root, "state", "fixture-squad"), { recursive: true });
    writeFileSync(f.stateFile, previous);
    try {
      const result = activate(f);
      expect(result.status).toBe(1);
      expect(result.json.ok).toBe(false);
      expect(result.json.failures[0]).toMatchObject({ step: "post_install", name: "required hook", status: "failed" });
      expect(readFileSync(f.stateFile, "utf8")).toBe(previous);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an invalid required hook fails honestly while an invalid optional hook warns", () => {
    const required = fixture("post_install:\n  - name: malformed required hook\n");
    const optional = fixture("post_install:\n  - name: malformed optional hook\n    optional: true\n");
    try {
      const requiredResult = activate(required);
      expect(requiredResult.status).toBe(1);
      expect(requiredResult.json.failures[0]).toMatchObject({ status: "failed", name: "malformed required hook" });

      const optionalResult = activate(optional);
      expect(optionalResult.status).toBe(0);
      expect(optionalResult.json.ok).toBe(true);
      expect(optionalResult.json.warnings[0]).toMatchObject({ status: "failed", optional: true });
      expect(existsSync(optional.stateFile)).toBe(true);
    } finally {
      rmSync(required.root, { recursive: true, force: true });
      rmSync(optional.root, { recursive: true, force: true });
    }
  });
});
