// host-mcp.js — where the HOST runtime keeps its MCP servers.
//
// A squad never runs an MCP server. It declares one (dependencies.yaml,
// `mcps:`) so the operator knows what the runtime that executes the squad
// (Claude Code, Codex, Gemini CLI, Antigravity, …) must have configured. This
// module answers one question for that declaration: in which of the host
// configuration files this machine has does a server of that name appear?
// Plain CommonJS so the activator (JS) and the TypeScript callers share it.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The files each runtime documents for MCP servers, label first. Presence is
 *  a name match inside the file: a `mcpServers` map key (Claude Code, Gemini,
 *  a project `.mcp.json`) or a `[mcp_servers.<name>]` table (Codex). */
function hostMcpConfigFiles(cwd) {
  const home = os.homedir();
  const files = [
    ["claude-code (~/.claude.json)", path.join(home, ".claude.json")],
    ["claude-code (~/.claude/settings.json)", path.join(home, ".claude", "settings.json")],
    ["codex (~/.codex/config.toml)", path.join(home, ".codex", "config.toml")],
    ["gemini-cli (~/.gemini/settings.json)", path.join(home, ".gemini", "settings.json")],
    ["antigravity (~/.antigravity/settings.json)", path.join(home, ".antigravity", "settings.json")],
  ];
  if (cwd) files.push(["project (.mcp.json)", path.join(cwd, ".mcp.json")]);
  return files;
}

function mentionsServer(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // JSON: "name": { … } under mcpServers. TOML: [mcp_servers.name] or [mcp_servers."name"].
  return new RegExp(`"${esc}"\\s*:`).test(text) || new RegExp(`\\[mcp_servers\\.("?)${esc}\\1\\]`).test(text);
}

/** Labels of the host configuration files where a server named `name` appears. */
function mcpConfiguredIn(name, opts) {
  const found = [];
  for (const [label, file] of hostMcpConfigFiles(opts && opts.cwd)) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (mentionsServer(text, name)) found.push(label);
  }
  return found;
}

/** Normalises the `mcps:` list of a dependencies.yaml: strings or objects. */
function normalizeMcps(mcps) {
  if (!Array.isArray(mcps)) return [];
  const out = [];
  for (const m of mcps) {
    if (typeof m === "string" && m.trim()) out.push({ name: m.trim(), purpose: null, required: false });
    else if (m && typeof m === "object" && typeof m.name === "string" && m.name.trim()) {
      out.push({ name: m.name.trim(), purpose: typeof m.purpose === "string" ? m.purpose : null, required: !!m.required });
    }
  }
  return out;
}

module.exports = { hostMcpConfigFiles, mcpConfiguredIn, normalizeMcps, _mentionsServer: mentionsServer };
