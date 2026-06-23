#!/usr/bin/env bun
/**
 * nrv.ts — cross-platform dispatcher for the nrv command.
 *
 * Faithful port of bin/nrv (the bash master command). Exists so Windows can run
 * `nrv` through Bun ALONE, with no Git Bash / WSL dependency: the Windows
 * `nrv.cmd` launcher calls `bun .../nrv.ts %*`. On macOS/Linux, bin/nrv (bash)
 * stays the primary entry point.
 *
 * KEEP IN SYNC with bin/nrv: every subcommand here mirrors a case there.
 */

import { spawnSync } from "node:child_process";
import { renderHelp } from "../lib/commands.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const HOME = homedir();
const SKILLS = process.env.NIRVANA_SKILLS_DIR || (existsSync(join(HOME, ".nirvana", "skills")) ? join(HOME, ".nirvana", "skills") : join(HOME, ".claude", "skills"));
const H = join(SKILLS, "harness", "scripts");
const S = join(SKILLS, "_shared", "scripts");
const BUN = process.execPath; // the bun running this file

/** Run a bun script with args, then exit with its status. */
function runScript(script: string, args: string[]): never {
  const r = spawnSync(BUN, [script, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const rest = argv.slice(1);

switch (cmd) {
  case "version": case "--version": case "-v": case "-V": {
    let v = "unknown";
    const vf = join(SKILLS, "VERSION");
    if (existsSync(vf)) v = readFileSync(vf, "utf8").trim();
    else {
      const pj = join(SKILLS, "..", "package.json");
      if (existsSync(pj)) { try { v = JSON.parse(readFileSync(pj, "utf8")).version || v; } catch {} }
    }
    const ef = join(SKILLS, "EDITION");
    const edition = existsSync(ef) ? readFileSync(ef, "utf8").trim() : "Nirvana-OS Genesis Circle";
    console.log(`nrv ${v} (${edition})`);
    process.exit(0);
  }
  case "glance": runScript(join(H, "glance.ts"), rest);
  case "route": runScript(join(H, "route.ts"), rest);
  case "use-businesses": case "business": case "businesses":
    runScript(join(H, "route.ts"), [...rest, "--prefer", "business"]);
  case "use-squads": case "squad": case "squads":
    runScript(join(H, "route.ts"), [...rest, "--prefer", "squad"]);
  case "find": runScript(join(H, "find.ts"), rest);
  case "validate": runScript(join(H, "validate.ts"), rest);
  case "watch": case "tail": runScript(join(H, "watch.ts"), rest);
  case "watch-fs": case "fswatch": runScript(join(H, "watch-fs.ts"), rest);
  case "index": runScript(join(H, "index.ts"), rest);
  case "pack-manifest": case "gen-pack-manifest": runScript(join(S, "gen-pack-manifest.ts"), rest);
  case "init": case "init-project": runScript(join(S, "init-project.ts"), rest);
  case "install": {
    const f = rest[0] ?? "";
    if (["--bootstrap", "--check", "--starter", "--no-starter", "--dry"].includes(f)) runScript(join(S, "install.ts"), rest);
    runScript(join(S, "install-asset.ts"), rest);
  }
  case "setup": runScript(join(S, "install.ts"), rest);
  case "install-content": runScript(join(S, "install-content.ts"), rest);
  case "uninstall": {
    if (rest[0] && !rest[0].startsWith("-")) {
      // Pack pago (Trilha A) tem precedência sobre o asset registry (Trilha B).
      const packManifest = join(HOME, ".nirvana", "packs", `${rest[0]}.json`);
      if (existsSync(packManifest) || rest.includes("--kind=pack")) runScript(join(S, "uninstall-pack.ts"), rest);
      runScript(join(S, "uninstall-asset.ts"), rest);
    }
    if (["--engine", "--all"].includes(rest[0])) runScript(join(S, "uninstall-engine.ts"), rest.slice(1));
    if (rest[0] === "--hooks") runScript(join(S, "install.ts"), ["--uninstall", ...rest.slice(1)]);
    console.error("usage: nrv uninstall <name> | --engine | --hooks");
    process.exit(2);
  }
  case "installed": case "list-installed": runScript(join(S, "list-installed.ts"), rest);
  case "validate-mind-clones": case "mc-validate": runScript(join(S, "validate-mind-clones.ts"), rest);
  case "validate-trace": case "trace-validate": runScript(join(H, "validate-trace.ts"), rest);
  case "baseline": runScript(join(H, "baseline.ts"), rest);
  case "improver": runScript(join(H, "improver.ts"), rest);
  case "gate": {
    if (["voice-fidelity", "voice", "mind-clone-voice-fidelity"].includes(rest[0] ?? "")) runScript(join(H, "gate-voice-fidelity.ts"), rest.slice(1));
    console.log("usage: nrv gate <rubric> <args>\navailable rubrics: voice-fidelity");
    process.exit(2);
  }
  case "doctor": case "capability-doctor": {
    const sub = rest[0] ?? "system";
    if (["--capability", "capability"].includes(sub)) runScript(join(S, "capability-doctor.ts"), rest.slice(1));
    runScript(join(H, "doctor-system.ts"), (sub === "--system" || sub === "system") ? rest.slice(1) : rest);
  }
  case "dispatch": runScript(join(H, "dispatch.ts"), rest);
  case "run": case "autopilot": runScript(join(H, "dispatch.ts"), [...rest, "--exec"]);
  case "auto": runScript(join(H, "dispatch.ts"), [...rest, "--exec", "--auto"]);
  case "revise": runScript(join(H, "revise.ts"), rest);
  case "clean": case "clean-project": case "purge": runScript(join(H, "clean-project.ts"), rest);
  case "update": case "self-update": case "upgrade": {
    if (rest[0] && !rest[0].startsWith("-")) runScript(join(S, "update-pack.ts"), rest);
    runScript(join(H, "update.ts"), rest);
  }
  case "pack": runScript(join(H, "pack.ts"), rest);
  case "audit-view": case "audit": runScript(join(H, "audit-view.ts"), rest);
  case "search": runScript(join(H, "search.ts"), rest);
  case "export": runScript(join(H, "export.ts"), rest);
  case "ask": runScript(join(H, "ask.ts"), rest);
  case "launch": runScript(join(H, "launch.ts"), rest);
  case "tui": case "cockpit-tui": runScript(join(H, "tui.ts"), rest);
  case "validate-chain": case "chain-validate": case "chain": runScript(join(H, "validate-chain.ts"), rest);
  case "resume": case "resume-project": runScript(join(S, "resume-project.ts"), rest);
  case "list-squads": case "squads-list": runScript(join(SKILLS, "squads", "scripts", "list-squads.ts"), rest);
  case "list-businesses": case "businesses-list": runScript(join(SKILLS, "businesses", "scripts", "list-businesses.ts"), rest);
  case "list-clones": case "clones-list": case "list-mind-clones": case "mind-clones": runScript(join(S, "list-clones.ts"), rest);
  case "inspect-clone": case "clone-inspect": case "inspect-mind-clone": runScript(join(S, "inspect-clone.ts"), rest);
  case "find-clone": case "clone-find": case "find-mind-clone": runScript(join(S, "find-clone.ts"), rest);
  case "validate-starter": case "starter-validate": runScript(join(HOME, "nirvana-os", "scripts", "validate-starter.ts"), rest);
  case "license": case "verify-license": case "whoami": runScript(join(S, "license.ts"), rest);
  case "help": case "-h": case "--help": case "":
    printHelp();
    process.exit(0);
  default:
    console.error(`nrv: unknown subcommand '${cmd}'\n     run 'nrv help' to list available commands`);
    process.exit(2);
}

function printHelp(): void {
  const octo = join(SKILLS, "harness", "assets", "octo.ansi");
  if (process.stdout.isTTY && !process.env.NO_COLOR && existsSync(octo)) {
    process.stdout.write("\n" + readFileSync(octo, "utf8"));
    process.stdout.write("  \x1b[1;38;2;230;57;53mNirvana-OS\x1b[0m  \x1b[2m·  command a universe of companies\x1b[0m\n\n");
  }
  console.log(renderHelp());
}
