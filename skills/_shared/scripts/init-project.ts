#!/usr/bin/env bun
/**
 * init-project.ts — Materialize a Nirvana project skeleton in <target_dir>.
 *
 * Creates:
 *   <target>/.env (global default unless --scope=...)
 *   <target>/.env.example (full reference)
 *   <target>/.gitignore
 *   <target>/AGENTS.md, CLAUDE.md, GEMINI.md (universal agent contract)
 *   <target>/.agents/skills/        (canonical, source-of-truth)
 *   <target>/.claude/skills        → symlink → ../.agents/skills
 *   <target>/.continue/skills      → symlink → ../.agents/skills
 *   <target>/.windsurf/skills      → symlink → ../.agents/skills
 *   <target>/.goose/skills         → symlink → ../.agents/skills
 *   <target>/.kilocode/skills      → symlink → ../.agents/skills
 *   <target>/.roo/skills           → symlink → ../.agents/skills
 *   <target>/.openhands/skills     → symlink → ../.agents/skills
 *   <target>/.qwen/skills          → symlink → ../.agents/skills
 *   <target>/.aider-desk/skills    → symlink → ../.agents/skills
 *   <target>/.nirvana/{squads,businesses,mind-clones}/
 *
 * Universal agents (Antigravity, Codex, Cursor, Copilot, OpenCode, Cline,
 * Replit, Warp, Amp, Gemini CLI, Deep Agents, Firebender, Dexto, Kimi CLI)
 * already read from .agents/skills directly — no symlink needed.
 *
 * Usage:
 *   bun init-project.ts <target_dir>
 *   bun init-project.ts <target_dir> --scope=project
 *   bun init-project.ts <target_dir> --link    (re-link symlinks only, do not overwrite .env)
 *   bun init-project.ts <target_dir> --copy    (copy files instead of symlink)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs, EXIT, log, paths } from "../lib/bun-helpers.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const TEMPLATE_DIR = path.join(SKILLS_ROOT, "_shared", "templates", "project-skeleton");

// skills.sh truth table: agents that need their own dir (will symlink to .agents/skills)
const PER_AGENT_SYMLINKS: Array<{ name: string; rel: string }> = [
  { name: "claude-code",   rel: ".claude/skills" },
  { name: "continue",      rel: ".continue/skills" },
  { name: "windsurf",      rel: ".windsurf/skills" },
  { name: "goose",         rel: ".goose/skills" },
  { name: "kilo",          rel: ".kilocode/skills" },
  { name: "roo",           rel: ".roo/skills" },
  { name: "openhands",     rel: ".openhands/skills" },
  { name: "qwen",          rel: ".qwen/skills" },
  { name: "aider-desk",    rel: ".aider-desk/skills" },
  { name: "kiro",          rel: ".kiro/skills" },
  { name: "junie",         rel: ".junie/skills" },
  { name: "augment",       rel: ".augment/skills" },
  { name: "trae",          rel: ".trae/skills" },
  { name: "rovodev",       rel: ".rovodev/skills" },
  { name: "zencoder",      rel: ".zencoder/skills" },
  { name: "neovate",       rel: ".neovate/skills" },
  { name: "pochi",         rel: ".pochi/skills" },
  { name: "mux",           rel: ".mux/skills" },
  { name: "kode",          rel: ".kode/skills" },
  { name: "qoder",         rel: ".qoder/skills" },
  { name: "codestudio",    rel: ".codestudio/skills" },
  { name: "codebuddy",     rel: ".codebuddy/skills" },
  { name: "codemaker",     rel: ".codemaker/skills" },
  { name: "command-code",  rel: ".commandcode/skills" },
  { name: "devin",         rel: ".devin/skills" },
  { name: "droid",         rel: ".factory/skills" },
  { name: "iflow-cli",     rel: ".iflow/skills" },
  { name: "mcpjam",        rel: ".mcpjam/skills" },
  { name: "openhands",     rel: ".openhands/skills" },
  { name: "mistral-vibe",  rel: ".vibe/skills" },
  { name: "tabnine-cli",   rel: ".tabnine/agent/skills" },
  { name: "cortex",        rel: ".cortex/skills" },
  { name: "crush",         rel: ".crush/skills" },
  { name: "pi",            rel: ".pi/skills" },
  { name: "bob",           rel: ".bob/skills" },
  { name: "adal",          rel: ".adal/skills" },
  { name: "codearts-agent", rel: ".codeartsdoer/skills" },
  // Hermes does NOT auto-discover project skills by CWD (HOME-global + external_dirs
  // only). This dir is created for portability/`--copy` deliveries; the `nrv-hermes`
  // wrapper points Hermes at it (or at .agents/skills) per session. See bin/nrv-hermes.
  { name: "hermes",        rel: ".hermes/skills" },
];

// Universal agents: read directly from .agents/skills, no symlink needed
const UNIVERSAL_AGENTS = [
  "antigravity", "codex", "cursor", "github-copilot", "opencode",
  "cline", "replit", "warp", "amp", "gemini-cli", "deepagents",
  "firebender", "dexto", "kimi-cli", "universal",
];

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyFile(src: string, dst: string, overwrite = false) {
  if (!fs.existsSync(src)) {
    log.warn(`template missing, skipped: ${src}`);
    return false;
  }
  if (!overwrite && fs.existsSync(dst)) {
    log.warn(`exists, kept: ${dst}`);
    return false;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  log.ok(`wrote ${dst}`);
  return true;
}

/**
 * Append the contents of `src` to `dst` IF `dst` doesn't already contain
 * `marker`. Idempotent: re-running is a no-op when the marker is present.
 * If `dst` doesn't exist, it's created from scratch with just the snippet.
 * Preserves the user's pre-existing content untouched (we never overwrite).
 */
function appendWithMarker(src: string, dst: string, marker: string): boolean {
  if (!fs.existsSync(src)) {
    log.warn(`snippet missing: ${src}`);
    return false;
  }
  const snippet = fs.readFileSync(src, "utf8");
  if (fs.existsSync(dst)) {
    const existing = fs.readFileSync(dst, "utf8");
    if (existing.includes(marker)) {
      log.info(`marker present, no append: ${dst}`);
      return false;
    }
    fs.appendFileSync(dst, snippet);
    log.ok(`appended writing contract to ${dst}`);
    return true;
  }
  ensureDir(path.dirname(dst));
  fs.writeFileSync(dst, snippet, "utf8");
  log.ok(`created ${dst} (snippet only — no base template)`);
  return true;
}

function copyTree(src: string, dst: string) {
  ensureDir(dst);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function makeSymlink(linkPath: string, targetRel: string) {
  ensureDir(path.dirname(linkPath));
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false } as any)) {
    try {
      const cur = fs.readlinkSync(linkPath);
      if (cur === targetRel) { log.info(`symlink ok: ${linkPath} → ${targetRel}`); return; }
    } catch {}
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  try {
    // Windows: junction (não pede Developer Mode/admin), mas exige alvo ABSOLUTO.
    if (process.platform === "win32") {
      fs.symlinkSync(path.resolve(path.dirname(linkPath), targetRel), linkPath, "junction");
    } else {
      fs.symlinkSync(targetRel, linkPath, "dir");
    }
    log.ok(`symlink: ${linkPath} → ${targetRel}`);
  } catch (e: any) {
    log.warn(`symlink failed (${e.code}); falling back to copy: ${linkPath}`);
    const abs = path.resolve(path.dirname(linkPath), targetRel);
    if (fs.existsSync(abs)) copyTree(abs, linkPath);
  }
}

function relSymlinkTarget(linkAbs: string, canonicalAbs: string): string {
  return path.relative(path.dirname(linkAbs), canonicalAbs);
}

function printHelp() {
  console.log(`init-project — scaffold a new Nirvana project

USAGE
  bun init-project.ts <target_dir>                    create project at <target_dir>
  bun init-project.ts <target_dir> --scope=project    set NIRVANA_SCOPE=project in .env
  bun init-project.ts <target_dir> --scope=merge      set NIRVANA_SCOPE=merge in .env
  bun init-project.ts <target_dir> --with-skills      symlink .agents/skills → ~/.nirvana/skills
  bun init-project.ts <target_dir> --copy             embed a snapshot of all skills (portable)
  bun init-project.ts <target_dir> --link             re-run skill linking (no-op without --with-skills)
  bun init-project.ts <target_dir> --force            overwrite existing files
  bun init-project.ts -h | --help                     this message

CREATES (default — minimal)
  <target>/.env                  active config (commit it)
  <target>/.env.example          full reference of every NIRVANA_* var
  <target>/.gitignore            sensible defaults
  <target>/README.md             quickstart pointer
  <target>/AGENTS.md             universal agent contract (canonical)
  <target>/CLAUDE.md             same content — Claude Code reads this
  <target>/GEMINI.md             same content — Gemini-CLI reads this
  <target>/.nirvana/             squads/ businesses/ mind-clones/ outputs/

  Note: by default the project does NOT create .agents/skills/ or per-agent
  symlinks. Every modern agent runtime (Gemini-CLI, Cursor, Codex, OpenCode,
  Cline, Warp, …) reads from your HOME (~/.agents/skills which links to
  ~/.nirvana/skills), so duplicating in the project would only trigger
  "skill conflict" warnings.

ADDITIONALLY CREATED with --with-skills (HOME-linked, dev-friendly)
  <target>/.agents/skills        symlink → ~/.nirvana/skills
  <target>/.claude/skills        symlink → ../.agents/skills (40+ agent runtimes)
  …                              every per-agent dir under <target>/

ADDITIONALLY CREATED with --copy (portable, recipient-friendly)
  <target>/.agents/skills/       full snapshot of ~/.nirvana/skills (committable)
  <target>/.claude/skills        symlink → ../.agents/skills
  …                              every per-agent dir copied locally

NEXT STEPS (after init)
  cd <target>
  $EDITOR .env                                          # pick scope, configure
  bun ~/.nirvana/skills/squads/scripts/index-squads.ts   # if scope=project, index local
  bun ~/.nirvana/skills/harness/scripts/glance.ts        # see your project in cockpit

WHEN TO USE EACH MODE
  default        → developing on your own machine; HOME has ~/.nirvana/skills
  --with-skills  → multiple users on the same machine sharing the same HOME
                   skills (rare); makes the project explicit about what it
                   reads. Equivalent functionally to default for a single user.
  --copy         → delivering the project to a client / another machine that
                   may NOT have ~/.nirvana/skills. Snapshot is self-contained
                   and survives moves; trade-off: ~100 MB extra disk per project
                   and manual re-sync to pick up upstream skill updates.

EXAMPLES
  bun init-project.ts ~/projects/foguero                  # default, your own dev box
  bun init-project.ts ~/projects/foguero --scope=project  # isolated squads/businesses
  bun init-project.ts ~/projects/cliente-x --copy         # portable delivery
`);
}

function main() {
  const { positional, flags } = parseArgs();

  if (flags.h || flags.help) {
    printHelp();
    process.exit(EXIT.OK);
  }

  if (!positional[0]) {
    console.error("error: <target_dir> is required");
    console.error("hint:  bun init-project.ts --help");
    process.exit(EXIT.INVALID_ARGS);
  }

  const target = path.resolve(positional[0]);
  const linkOnly = !!flags.link;
  const useCopy = !!flags.copy;
  // Skills materialization is opt-in. By default we do NOT create
  // `<project>/.agents/skills` because every modern agent runtime (Gemini-CLI,
  // Cursor, Codex, etc.) already reads from `~/.agents/skills` (which we link
  // to ~/.nirvana/skills globally). Creating both would cause "skill conflict"
  // warnings — the project would shadow the home library with the same files.
  // Use `--with-skills` (or `--copy`) when you need a portable client delivery
  // that doesn't depend on $HOME.
  const withSkills = !!flags["with-skills"] || useCopy;
  const scope = (flags["scope"] as string) || null;
  const force = !!flags.force;

  if (!fs.existsSync(TEMPLATE_DIR)) {
    log.fail(`Template not found: ${TEMPLATE_DIR}`);
    process.exit(EXIT.FAILURES);
  }

  log.info(`Initializing Nirvana project at: ${target}`);
  ensureDir(target);

  if (!linkOnly) {
    copyFile(path.join(TEMPLATE_DIR, ".env"), path.join(target, ".env"), force);
    copyFile(path.join(TEMPLATE_DIR, ".env.example"), path.join(target, ".env.example"), true);
    copyFile(path.join(TEMPLATE_DIR, ".gitignore"), path.join(target, ".gitignore"), force);
    copyFile(path.join(TEMPLATE_DIR, "README.md"), path.join(target, "README.md"), force);

    // Universal agent contract — materialize as AGENTS.md (canonical) plus
    // CLAUDE.md / GEMINI.md (runtime-specific filenames pointing at the same
    // content). Forces every agent runtime to read the Nirvana invocation
    // contract before touching the project, regardless of skill activation.
    //
    // Two phases per target file:
    //   1. If the file doesn't exist, copy the base template (universal agent
    //      contract: Nirvana protocol, behavioral guidelines, etc.).
    //   2. Always append the writing-contract snippet ONLY if its marker isn't
    //      already present (idempotent). Pre-existing user rules are preserved.
    const agentsTemplate = path.join(SKILLS_ROOT, "_shared", "templates", "AGENTS.md");
    const writingContractSnippet = path.join(SKILLS_ROOT, "_shared", "templates", "writing-contract-snippet.md");
    const WRITING_CONTRACT_MARKER = "<!-- nirvana-os:writing-contract:v1 -->";
    if (fs.existsSync(agentsTemplate)) {
      for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
        const dst = path.join(target, name);
        // Phase 1: only copy the base if the file is absent (never overwrite
        // pre-existing rules the user wrote).
        if (!fs.existsSync(dst)) {
          copyFile(agentsTemplate, dst, false);
        } else {
          log.warn(`exists, kept: ${dst}`);
        }
        // Phase 2: append the writing contract (idempotent via marker).
        appendWithMarker(writingContractSnippet, dst, WRITING_CONTRACT_MARKER);
      }
    } else {
      log.warn(`AGENTS.md template missing: ${agentsTemplate} — skipping agent contract`);
    }

    if (scope && scope !== "global") {
      const envPath = path.join(target, ".env");
      let env = fs.readFileSync(envPath, "utf8");
      env = env.replace(/^NIRVANA_SCOPE=.*$/m, `NIRVANA_SCOPE=${scope}`);
      fs.writeFileSync(envPath, env);
      log.ok(`set NIRVANA_SCOPE=${scope} in .env`);
    }
  }

  // Canonical source-of-truth dir — OPT-IN ONLY.
  //
  // Default behavior (no --with-skills, no --copy): we do NOT create
  // `<project>/.agents/skills`. Every modern agent runtime (Gemini-CLI, Cursor,
  // Codex, OpenCode, Cline, Warp, Antigravity, …) already reads from
  // `~/.agents/skills` (which links to ~/.nirvana/skills globally), so the
  // project would only duplicate the same paths and trigger "skill conflict"
  // warnings.
  //
  // With --with-skills: `.agents/skills/` becomes a symlink to ~/.nirvana/skills
  // (useful when the project will be opened from a path that doesn't share
  // $HOME with the original user).
  //
  // With --copy: snapshot of ~/.nirvana/skills is copied into `.agents/skills/`.
  // Use this for portable client deliveries that should not depend on $HOME.
  //
  // With --link (re-link): only re-runs the symlink/copy step. Skipped entirely
  // if neither --with-skills nor --copy is set.
  const canonical = path.join(target, ".agents", "skills");
  const HOME_SKILLS = SKILLS_ROOT;
  if (!withSkills) {
    log.info(`skipping .agents/skills (default — agents read from ~/.agents/skills globally; pass --with-skills to materialize locally)`);
  } else if (!fs.existsSync(HOME_SKILLS)) {
    log.warn(`global skills dir not found: ${HOME_SKILLS} — creating empty .agents/skills/`);
    ensureDir(path.dirname(canonical));
    ensureDir(canonical);
  } else if (useCopy) {
    ensureDir(path.dirname(canonical));
    if (fs.existsSync(canonical) && force) fs.rmSync(canonical, { recursive: true, force: true });
    if (!fs.existsSync(canonical)) {
      ensureDir(canonical);
      for (const e of fs.readdirSync(HOME_SKILLS)) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const src = path.join(HOME_SKILLS, e);
        const dst = path.join(canonical, e);
        try {
          const st = fs.statSync(src);
          if (st.isDirectory()) copyTree(src, dst);
          else fs.copyFileSync(src, dst);
        } catch (e: any) { log.warn(`skip ${src}: ${e.message}`); }
      }
      log.ok(`copied skills snapshot: ${HOME_SKILLS} → ${canonical}`);
    } else {
      log.info(`skills dir exists; --force to overwrite: ${canonical}`);
    }
  } else {
    // Default: symlink `.agents/skills` → ~/.nirvana/skills
    let needCreate = true;
    if (fs.existsSync(canonical) || fs.lstatSync(canonical, { throwIfNoEntry: false } as any)) {
      try {
        const cur = fs.readlinkSync(canonical);
        if (path.resolve(path.dirname(canonical), cur) === HOME_SKILLS) {
          needCreate = false;
          log.info(`skills symlink ok: ${canonical} → ${HOME_SKILLS}`);
        }
      } catch {
        // Not a symlink. If empty dir, replace; otherwise warn and keep.
        try {
          const entries = fs.readdirSync(canonical);
          if (entries.length === 0) {
            fs.rmdirSync(canonical);
          } else if (force) {
            fs.rmSync(canonical, { recursive: true, force: true });
          } else {
            log.warn(`existing skills dir is not a symlink and not empty; pass --force to replace: ${canonical}`);
            needCreate = false;
          }
        } catch {}
      }
    }
    if (needCreate) {
      try {
        // Junction no Windows: dispensa Developer Mode/admin (alvo já é absoluto).
        fs.symlinkSync(HOME_SKILLS, canonical, process.platform === "win32" ? "junction" : "dir");
        log.ok(`skills symlink: ${canonical} → ${HOME_SKILLS}`);
      } catch (e: any) {
        log.warn(`symlink failed (${e.code}); falling back to copy`);
        ensureDir(canonical);
        for (const e of fs.readdirSync(HOME_SKILLS)) {
          if (e === "node_modules" || e.startsWith(".")) continue;
          const src = path.join(HOME_SKILLS, e);
          const dst = path.join(canonical, e);
          const st = fs.statSync(src);
          if (st.isDirectory()) copyTree(src, dst);
          else fs.copyFileSync(src, dst);
        }
      }
    }
  }

  // .nirvana subtree
  for (const sub of ["squads", "businesses", "mind-clones"]) {
    ensureDir(path.join(target, ".nirvana", sub));
  }
  copyFile(path.join(TEMPLATE_DIR, ".nirvana", "README.md"), path.join(target, ".nirvana", "README.md"), force);

  // Per-agent symlinks (or copies) — only when withSkills is on.
  // Otherwise we'd create dozens of symlinks pointing to a non-existent
  // `.agents/skills` and waste filesystem entries while triggering
  // skill-conflict warnings for any agent that also reads from $HOME.
  if (withSkills) {
    const seen = new Set<string>();
    for (const a of PER_AGENT_SYMLINKS) {
      if (seen.has(a.rel)) continue;
      seen.add(a.rel);
      const link = path.join(target, a.rel);
      if (useCopy) {
        ensureDir(link);
        copyTree(canonical, link);
        log.ok(`copied: ${link}`);
      } else {
        makeSymlink(link, relSymlinkTarget(link, canonical));
      }
    }
  }

  if (withSkills) {
    log.ok(`done. universal agents (${UNIVERSAL_AGENTS.length}) read .agents/skills directly:`);
    log.info(`  ${UNIVERSAL_AGENTS.join(", ")}`);
  } else {
    log.ok(`done. project relies on the user's $HOME skills (~/.nirvana/skills).`);
    log.info(`Pass --with-skills (or --copy) to embed a local copy when the project may be opened from another HOME (deliveries, CI, recipients without ~/.nirvana/skills).`);
  }
  log.info(`Next: $EDITOR ${path.join(target, ".env")}  →  pick scope, then drop skills/squads in.`);
  // Verify hooks are installed in the user's agent settings.
  try {
    const result = require("node:child_process").spawnSync("bun", [path.join(SKILLS_ROOT, "_shared", "scripts", "install.ts"), "--check"], { encoding: "utf8" });
    if (result.status !== 0) {
      log.warn(`Audit hooks are NOT yet wired into your agents. Run: nrv install`);
      log.info(`(this configures Claude Code + Gemini-CLI to emit audit events automatically)`);
    } else {
      log.ok(`Audit hooks active across installed agents — runs auto-track in 'nrv glance'.`);
    }
  } catch { /* check is best-effort */ }
  process.exit(EXIT.OK);
}

main();
