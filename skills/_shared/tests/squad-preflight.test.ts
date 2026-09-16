// squad-preflight.test.ts — what a squad declares of its host is said before it runs.
//
// Credentials (`env_vars`) and MCP servers (`mcps`) in dependencies.yaml are
// the host's to provide. The preflight reads the declaration, checks the
// environment and the host's own MCP configuration files, and produces the
// warning lines the doctor, the prep step and the headless runner print.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { preflightWarnings, squadPreflight } from "../lib/squad-preflight.ts";

const require = createRequire(import.meta.url);
const { _mentionsServer, normalizeMcps } = require("../lib/host-mcp.js");

function squad(deps: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nrv-preflight-"));
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "dependencies.yaml"), deps, "utf8");
  return dir;
}

describe("squadPreflight", () => {
  test("required credentials missing from the environment are named; optional ones are not warnings", () => {
    const dir = squad("schema_version: \"1.0\"\nenv_vars:\n  - name: ACME_KEY\n    required: true\n    description: \"the vendor key\"\n  - name: ACME_REGION\n    required: false\n");
    try {
      const p = squadPreflight(dir, { env: { PATH: "/usr/bin" } });
      expect(p.declared).toBe(true);
      expect(p.missingRequired.map((v) => v.name)).toEqual(["ACME_KEY"]);
      expect(p.missingOptional.map((v) => v.name)).toEqual(["ACME_REGION"]);
      const lines = preflightWarnings(p, "acme-squad");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("ACME_KEY");
      expect(lines[0]).toContain("the vendor key");
      expect(preflightWarnings(squadPreflight(dir, { env: { ACME_KEY: "x" } }), "acme-squad")).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the {required: [...], optional: [...]} shape is read too", () => {
    const dir = squad("env_vars:\n  required: [ONE_KEY]\n  optional: [TWO_KEY]\n");
    try {
      const p = squadPreflight(dir, { env: {} });
      expect(p.missingRequired.map((v) => v.name)).toEqual(["ONE_KEY"]);
      expect(p.missingOptional.map((v) => v.name)).toEqual(["TWO_KEY"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a declared MCP server is a host warning naming the server, never a block", () => {
    const dir = squad("mcps:\n  - name: comfyui-mcp-test-zz\n    purpose: image generation\n  - plain-mcp-name-zz\n");
    try {
      const p = squadPreflight(dir, { env: {} });
      expect(p.mcps.map((m) => m.name)).toEqual(["comfyui-mcp-test-zz", "plain-mcp-name-zz"]);
      expect(p.mcps[0].purpose).toBe("image generation");
      expect(p.mcpsNotConfigured.length).toBe(2);
      const lines = preflightWarnings(p, "media-squad");
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("the squad does not run MCP servers");
      expect(lines[0]).toContain("configure it in the runtime");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a project .mcp.json that names the server counts as configured", () => {
    const dir = squad("mcps:\n  - name: local-mcp-zz\n");
    const proj = mkdtempSync(join(tmpdir(), "nrv-preflight-proj-"));
    try {
      writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { "local-mcp-zz": { command: "x" } } }), "utf8");
      const p = squadPreflight(dir, { env: {}, cwd: proj });
      expect(p.mcpsNotConfigured).toEqual([]);
      expect(p.mcps[0].configured_in).toEqual(["project (.mcp.json)"]);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  test("no dependencies.yaml, or one without host declarations, is silent", () => {
    const dir = squad("system:\n  - name: git\n");
    try {
      expect(squadPreflight(dir).declared).toBe(false);
      expect(preflightWarnings(squadPreflight(dir), "s")).toEqual([]);
      expect(squadPreflight(join(dir, "nope")).declared).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("host-mcp", () => {
  test("recognises a JSON mcpServers key and a Codex TOML table", () => {
    expect(_mentionsServer('{"mcpServers":{"comfyui":{"command":"x"}}}', "comfyui")).toBe(true);
    expect(_mentionsServer("[mcp_servers.comfyui]\ncommand = \"x\"\n", "comfyui")).toBe(true);
    expect(_mentionsServer("[mcp_servers.\"comfy.ui\"]\n", "comfy.ui")).toBe(true);
    expect(_mentionsServer('{"mcpServers":{"other":{}}}', "comfyui")).toBe(false);
  });

  test("normalises strings and objects, drops junk", () => {
    expect(normalizeMcps(["a", { name: "b", purpose: "p", required: true }, 3, { nope: 1 }])).toEqual([
      { name: "a", purpose: null, required: false },
      { name: "b", purpose: "p", required: true },
    ]);
    expect(normalizeMcps("not-a-list")).toEqual([]);
  });
});
