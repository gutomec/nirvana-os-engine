#!/usr/bin/env bun
// doctor-system.ts — full system diagnostic for Nirvana-OS.
//
// Reports on every layer of the stack so the user can pinpoint what's broken.
// Reuses the existing capability-doctor (which audits produces/example_briefs)
// but adds the runtime/binary/auth checks the user actually needs on day 1.
//
// Sections:
//   1. Binaries (bun, node, codex, claude-code, git, python3)
//   2. Skills (harness, businesses, squads in ~/.nirvana/skills/)
//   3. Registries (squads-registry, businesses-registry timestamps)
//   4. Hooks (PreToolUse, PostToolUse wired in settings.json)
//   5. Audit (today's audit.jsonl event counts)
//   6. Libraries (businesses/, squads/, mind-clones in _library/dna/)
//   7. Recent dispatches (active projects in .nirvana/outputs/)
//   8. Patches applied (key fixes from CORRECTION-REPORT)
//
// Exit codes:
//   0 = all green
//   1 = some warnings
//   2 = critical failures

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { paths as nrvPaths } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";
import { RUNTIME_TARGETS, RUNTIME_SKILL_DIRS, PROJECT_CONTRACT_FILES } from "../../_shared/lib/runtime-dirs.ts";
import { scanLibrary, authorsPacks, STRIP_HINT } from "../../_shared/lib/watermark-scan.ts";
import { listRuntimes } from "../../_shared/lib/host-agent-driver.ts";
import { expandEnv, findTempNrvEntries, readUserPath, tempRoots } from "../../_shared/lib/windows-user-path.ts";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import {
  describeSettingSource, discoverProjectRoot, engineConfigPath, globalConfigPath, projectConfigPath, resolveAllSettings, resolveSetting,
} from "../../_shared/lib/settings.ts";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m", magenta: "\x1b[35m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
const json = process.argv.includes("--json");
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

type Check = { name: string; status: "PASS" | "WARN" | "FAIL"; note: string };
const checks: Check[] = [];
function add(name: string, status: "PASS" | "WARN" | "FAIL", note: string) {
  checks.push({ name, status, note });
}

// NIRVANA_HOME first, like every other part of the engine (bun-helpers,
// paths.js, update-check). The doctor alone read os.homedir() directly, so with
// NIRVANA_HOME set it diagnosed a DIFFERENT home than the one the engine was
// actually using — silently, and it reported everything as fine. On Windows the
// gap is wider still: os.homedir() there follows USERPROFILE, so HOME alone
// relocates nothing.
const HOME = process.env.NIRVANA_HOME || os.homedir();
const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(HOME, ".nirvana", "skills")) ? path.join(HOME, ".nirvana", "skills") : path.join(HOME, ".claude", "skills"));

// SECTION 1: BINARIES
function which(bin: string): string | null {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

const bins = [
  { name: "bun", required: true },
  // node + python3 are optional: the toolchain runs on Bun alone. They are only
  // used by a few legacy/optional helpers, so their absence is not a failure.
  { name: "node", required: false },
  { name: "python3", required: false },
  { name: "git", required: true },
  // Agent runtimes are NOT listed here — they come from the driver's own
  // roster below. This array used to carry 3 of the 9 (codex, claude, gemini),
  // so the other six never appeared in the report even when installed.
];

for (const b of bins) {
  const p = which(b.name);
  if (p) {
    let version = "";
    try {
      const r = spawnSync(b.name, ["--version"], { encoding: "utf8" });
      version = (r.stdout || r.stderr || "").split("\n")[0].slice(0, 50);
    } catch {}
    add(`binary: ${b.name}`, "PASS", `${p} ${version ? `(${version})` : ""}`);
  } else {
    add(`binary: ${b.name}`, b.required ? "FAIL" : "WARN", "not found in PATH");
  }
}

// SECTION 1a: AGENT RUNTIMES — one line per adapter the dispatch engine
// supports, from the driver's roster (never a local copy). Each is individually
// optional: dispatch falls through to the next one on PATH. What is NOT
// optional is having at least one — with zero runtimes no dispatch can run,
// which is a FAIL on the summary line, not nine quiet WARNs.
let runtimesOnPath = 0;
for (const rt of listRuntimes()) {
  const p = which(rt.cli);
  if (p) {
    runtimesOnPath++;
    add(`runtime: ${rt.name}`, "PASS", p);
  } else {
    add(`runtime: ${rt.name}`, "WARN", `'${rt.cli}' not found in PATH`);
  }
}
// Zero runtimes on a USER machine is critical — nothing can dispatch. On a
// headless CI runner it is the expected state of the world: the smoke job
// installs the engine on a bare image precisely to prove the install works
// before any runtime exists. Same fact, different severity per context —
// shipping this as unconditional FAIL turned every CI run red on all three
// platforms within the hour.
const headlessCI = process.env.CI === "true";
add(
  "runtime: dispatch",
  runtimesOnPath > 0 ? "PASS" : headlessCI ? "WARN" : "FAIL",
  runtimesOnPath > 0
    ? `${runtimesOnPath}/${listRuntimes().length} agent runtime(s) on PATH`
    : `no agent runtime on PATH — dispatch cannot run; install one (claude, codex, gemini, …)${headlessCI ? " (CI environment: reported as warning)" : ""}`,
);

// SECTION 1a-bis-judge: GAUNTLET EVALUATOR — which evaluator a Gauntlet started
// today would get, by the same selection the three canaries use
// (lib/gauntlet/evaluator-selection.ts), without running anything. The
// judgement is agentic by policy: an installed squad declaring
// quality.specification_conformance, else the engine's judge-x on a runtime
// that has a persona and is on PATH. The offline heuristic only by explicit
// opt-in, and no agentic evaluator at all means the Gauntlet will not start.
try {
  const { CONFORMANCE_CAPABILITY, describeRanking, loadInstalledSquads, selectGauntletEvaluator } = await import("../lib/gauntlet/evaluator-selection.ts");
  const { resolveJudgeXPromptPath } = await import("../lib/gauntlet/judge-x.ts");
  const agentsDir = path.join(SKILLS, "_shared", "agents");
  const judgeRuntimes = listRuntimes().filter((rt) => which(rt.cli) && resolveJudgeXPromptPath(rt.name, agentsDir)).map((rt) => rt.name);
  const judge = judgeRuntimes.length
    ? { available: true as const }
    : { available: false as const, reason: runtimesOnPath > 0 ? `no judge-x persona in ${agentsDir.replace(HOME, "~")} for a runtime on PATH` : "no agent runtime on PATH" };
  // The gauntlet.evaluator setting: the variable, else the project or global config.
  const evaluatorSetting = resolveSetting("gauntlet.evaluator");
  const envValue = evaluatorSetting.value || undefined;
  const chosenBy = evaluatorSetting.source === "env"
    ? `${evaluatorSetting.variable}=${evaluatorSetting.raw}`
    : `gauntlet.evaluator=${evaluatorSetting.value} (${describeSettingSource(evaluatorSetting).replace(HOME, "~")})`;
  // Any producer that is not a squad sees every installed squad as independent; the doctor asks as a business would.
  const selection = selectGauntletEvaluator({ envValue, producer: { kind: "business", slug: "doctor" }, installed: loadInstalledSquads(), judge });
  if (selection.kind === "heuristic") {
    add("gauntlet: evaluator", "WARN", `offline heuristic by explicit opt-in (${chosenBy}) — rounds are scored by the quality gate, not judged; unset it to judge with ${judgeRuntimes.length ? "judge-x" : "an agentic evaluator"}`);
  } else if (selection.kind === "unavailable") {
    // A warning, not a failure: standard dispatches run without a judge; only a Gauntlet refuses to start.
    add("gauntlet: evaluator", "WARN",
      `none — a Gauntlet will not start (${selection.reason}); install a squad declaring ${CONFORMANCE_CAPABILITY} and run nrv index, or a runtime with a judge-x persona (nrv update refreshes the engine's personas)`);
  } else if (selection.target.kind === "squad") {
    // The registry rung ranks (Squad Protocol v6 §30) — print WHY this squad won, not just that it did.
    const why = selection.source === "env" ? chosenBy
      : selection.ranking ? `registry, declares ${CONFORMANCE_CAPABILITY}; ${describeRanking(selection.ranking)}`
      : `registry, declares ${CONFORMANCE_CAPABILITY}`;
    add("gauntlet: evaluator", "PASS", `squad:${selection.target.slug}:${selection.target.capabilityId} (${why})`);
  } else {
    add("gauntlet: evaluator", "PASS", `${selection.target.slug} (${selection.source === "env" ? chosenBy : "engine default: no installed squad declares " + CONFORMANCE_CAPABILITY}; runtimes with a persona on PATH: ${judgeRuntimes.join(", ")})`);
  }
} catch (e) {
  add("gauntlet: evaluator", "WARN", `cannot be selected: ${(e as Error).message}`);
}

// SECTION 1a-ter: RUNTIME SKILL LINKAGE — a runtime on PATH whose skills dir
// lacks the engine link is the "installed everything, typed a brief, nothing
// dispatched" failure (owner report, 2026-08-21: OpenClaw fresh from npm has
// no ~/.agents until first run; the old dir-exists proxy skipped the link in
// silence). The installer now creates the dir; this check catches installs
// done before the fix, or dirs removed since.
for (const t of RUNTIME_TARGETS) {
  if (!which(t.bin)) continue; // runtime absent — nothing to link
  const harnessLink = path.join(t.skillsDir, "harness");
  if (fs.existsSync(harnessLink)) {
    add(`skills link: ${t.name}`, "PASS", t.skillsDir);
  } else {
    add(`skills link: ${t.name}`, "WARN",
      `'${t.bin}' on PATH but ${t.skillsDir} has no engine link — re-run: bun scripts/install.ts`);
  }
}

// SECTION 1a-quinquies: SQUAD DEPENDENCIES — a squad that calls ffmpeg,
// epubcheck or a Python library fails MID-RUN when the tool is absent: the
// dispatch is spent, the gate withholds, and the error reads as a broken
// squad rather than a missing package. Activation is advisory by design
// (nothing blocks a dispatch), so the cheap warning belongs here, before
// the expensive run. Checks the DECLARED check commands of squads that
// have a dependencies.yaml, capped so doctor stays fast.
try {
  const scope = resolveScope();
  const squadEntries = enumerate(scope, "squads").filter((e) => !e.overridden);
  const withDeps = squadEntries.filter((e) => fs.existsSync(path.join(e.dir, "dependencies.yaml")));
  if (withDeps.length) {
    // Collect the distinct system-tool checks across the library: the same
    // ffmpeg serves twenty squads, so probe each binary ONCE.
    const toolToSquads = new Map<string, string[]>();
    for (const e of withDeps) {
      let raw = "";
      try { raw = fs.readFileSync(path.join(e.dir, "dependencies.yaml"), "utf8"); } catch { continue; }
      // Deliberately a light scan, not a YAML parse: `check: "<cmd>"` lines
      // under system deps are the contract, and doctor must stay cheap.
      for (const m of raw.matchAll(/^\s*check:\s*"([^"]+)"/gm)) {
        const bin = m[1].trim().replace(/^command -v\s+/, "").split(/\s+/)[0];
        if (!bin || bin.startsWith("$")) continue;
        toolToSquads.set(bin, [...(toolToSquads.get(bin) ?? []), e.slug]);
      }
    }
    const missing: { bin: string; squads: string[] }[] = [];
    for (const [bin, slugs] of toolToSquads) {
      if (!which(bin)) missing.push({ bin, squads: [...new Set(slugs)] });
    }
    if (missing.length === 0) {
      add("squad deps", "PASS", `${withDeps.length} squad(s) declare dependencies; every declared tool is on PATH`);
    } else {
      const worst = missing.sort((a, b) => b.squads.length - a.squads.length).slice(0, 3);
      const detail = worst.map((m) => `${m.bin} (${m.squads.length} squad${m.squads.length > 1 ? "s" : ""})`).join(", ");
      add("squad deps", "WARN",
        `${missing.length} declared tool(s) missing — ${detail}${missing.length > 3 ? ", …" : ""}; install with: nrv activate --all`);
    }
  }
} catch { /* no library, or an unreadable one — not a doctor failure */ }

// SECTION 1a-quater: nul GHOST FILES (Windows) — a `>nul` redirect interpreted
// outside cmd.exe (PowerShell, Bun shell) materializes a literal file named
// `nul`; OneDrive then persists it as an undeletable, syncing ghost. Detection
// MUST be by directory listing: existsSync("nul") hits the DEVICE and answers
// true in every directory. Wrappers are fixed (`where /q`, gated by
// cmd-wrappers.test.ts); this finds machines already bitten.
if (process.platform === "win32") {
  for (const dir of [process.cwd(), os.homedir()]) {
    try {
      if (fs.readdirSync(dir).some((e) => e.toLowerCase() === "nul")) {
        add("nul ghost file", "WARN",
          `literal 'nul' file in ${dir} — remove with: del "\\\\?\\${dir}\\nul"`);
      }
    } catch { /* unreadable dir — skip */ }
  }
}

// SECTION 1a-bis: CLAUDE CODE AUTH — a persistent CLAUDE_CODE_OAUTH_TOKEN export
// in a shell startup file (the pattern our own docs used to recommend) makes the
// *interactive* Claude Code session authenticate as a setup-token. That profile
// omits `subscriptionType`, so the model picker cannot confirm the plan and walls
// plan-included models behind "requires usage credits". Restarting never clears
// it, because the startup file re-exports on every new session. Nirvana never
// required it: detectHost() probes PATH and the spawned CLI uses its own login.
//
// We scan startup files instead of process.env because Bun merges .env files into
// process.env, and a project-scoped .env is exactly the pattern we recommend —
// probing the env would flag the correct setup as broken.
//
// Only *exported* vars count: a bare `VAR=x` in an rc stays shell-local and
// never reaches the spawned CLI. Covers zsh (honouring ZDOTDIR), bash/sh/ksh,
// fish, nushell and PowerShell, since the harmful pattern is shell-agnostic.
if (which("claude")) {
  const zdot = process.env.ZDOTDIR || HOME;
  const startupFiles = [
    ...[".zshrc", ".zshenv", ".zprofile", ".zlogin"].map(f => path.join(zdot, f)),
    ...[".bashrc", ".bash_profile", ".bash_login", ".profile", ".kshrc"].map(f => path.join(HOME, f)),
    path.join(HOME, ".config/fish/config.fish"),
    path.join(HOME, ".config/nushell/env.nu"),
    path.join(HOME, ".config/nushell/config.nu"),
    // PowerShell profiles. "Documents" is frequently redirected to OneDrive on
    // Windows, so both roots have to be probed.
    ...["Documents", "OneDrive/Documents"].flatMap(d =>
      ["PowerShell", "WindowsPowerShell"].map(p =>
        path.join(HOME, d, p, "Microsoft.PowerShell_profile.ps1"))),
  ];
  // sh/bash/zsh/ksh: `export X=`, `declare -x X=`, `typeset -x X=`
  const POSIX = /^\s*(?:export|declare\s+-\S*x\S*|typeset\s+-\S*x\S*)\s+CLAUDE_CODE_OAUTH_TOKEN\s*=/;
  // fish: `set -gx X v` — the flag block must actually export (`-x` / `--export`)
  const FISH = /^\s*set\s+((?:-{1,2}[\w-]+\s+)+)CLAUDE_CODE_OAUTH_TOKEN\b/;
  // nushell `$env.X = ...` and PowerShell `$env:X = ...`
  const ENVOBJ = /^\s*\$env[.:]CLAUDE_CODE_OAUTH_TOKEN\s*=/;
  const exportsToken = (line: string): boolean => {
    if (POSIX.test(line) || ENVOBJ.test(line)) return true;
    const m = FISH.exec(line);
    return !!m && /(^|\s)-{1,2}\w*(x|export)/.test(m[1]);
  };
  const offenders = startupFiles.filter(f => {
    try { return fs.readFileSync(f, "utf8").split(/\r?\n/).some(exportsToken); }
    catch { return false; }
  }).map(f => f.replace(HOME, "~"));
  // Windows persists user env in the registry (`setx`,
  // [Environment]::SetEnvironmentVariable), not in any startup file — scanning
  // files alone would miss the most common Windows case entirely.
  if (process.platform === "win32") {
    const hives: [string, string][] = [
      ["HKCU", "Environment"],
      ["HKLM", "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"],
    ];
    for (const [hive, key] of hives) {
      try {
        const r = spawnSync("reg", ["query", `${hive}\\${key}`, "/v", "CLAUDE_CODE_OAUTH_TOKEN"], { encoding: "utf8" });
        if (r.status === 0 && /CLAUDE_CODE_OAUTH_TOKEN/i.test(r.stdout || "")) {
          offenders.push(`${hive}\\${key} (registry)`);
        }
      } catch {}
    }
  }
  if (offenders.length) {
    add("auth: claude-code", "WARN",
      `CLAUDE_CODE_OAUTH_TOKEN is exported in ${offenders.join(", ")} — the interactive model picker `
      + "hides plan-included models behind \"requires usage credits\". Remove the export, run /login, and "
      + "keep the token in a project .env injected per command if a headless runner needs it.");
  } else {
    add("auth: claude-code", "PASS", "no persistent CLAUDE_CODE_OAUTH_TOKEN export (shell startup files / Windows registry)");
  }
}

// SECTION 1b: ENVIRONMENT — functional probes of the spots that already broke
// in production on Windows (GNU tar treating C: as a remote host, symlinks
// without privilege, Bun throwing EEXIST). Each probe EXERCISES the behavior
// instead of guessing by platform; runs the same on macOS/Linux/Windows.
{
  const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-doctor-env-"));
  const relFrom = (base: string, p: string) => {
    const r = path.relative(base, p);
    return (r === "" ? "." : r.includes(":") ? p : r).split(path.sep).join("/");
  };

  // tar: present? which flavor? (Git Bash's GNU tar vs Win10+/macOS bsdtar)
  const tarVer = spawnSync("tar", ["--version"], { encoding: "utf8" });
  if (tarVer.status !== 0) {
    add("env: tar", "FAIL", "tar not found — nrv update/install cannot extract archives");
  } else {
    const first = (tarVer.stdout || "").split("\n")[0];
    const flavor = /GNU tar/i.test(first) ? "GNU tar" : /bsdtar|libarchive/i.test(first) ? "bsdtar" : first.slice(0, 40);
    add("env: tar", "PASS", flavor);

    // tar roundtrip: create and extract an archive with the SAME technique the
    // engine uses (cwd + relative paths). Catches regressions of the
    // "C: como host remoto" bug.
    try {
      const src = path.join(envTmp, "src"); const out = path.join(envTmp, "out");
      fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(src, "probe.txt"), "ok");
      const tgz = path.join(envTmp, "probe.tar.gz");
      const cr = spawnSync("tar", ["-czf", relFrom(src, tgz), "probe.txt"], { encoding: "utf8", cwd: src });
      const ex = cr.status === 0
        ? spawnSync("tar", ["-xzf", relFrom(path.dirname(tgz), tgz), "-C", relFrom(path.dirname(tgz), out)], { encoding: "utf8", cwd: path.dirname(tgz) })
        : cr;
      if (ex.status === 0 && fs.existsSync(path.join(out, "probe.txt"))) {
        add("env: tar roundtrip", "PASS", "create+extract with relative paths works");
      } else {
        add("env: tar roundtrip", "FAIL", (ex.stderr || "extract produced no file").split("\n")[0].slice(0, 70));
      }
    } catch (e) {
      add("env: tar roundtrip", "FAIL", (e as Error).message.slice(0, 70));
    }
  }

  // directory links: junction on Windows (no Developer Mode), symlink on POSIX.
  try {
    const linkTarget = path.join(envTmp, "link-target"); fs.mkdirSync(linkTarget, { recursive: true });
    const linkPath = path.join(envTmp, "link-probe");
    fs.symlinkSync(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
    add("env: dir links", "PASS", process.platform === "win32" ? "junction ok (no admin needed)" : "symlink ok");
  } catch (e) {
    add("env: dir links", "WARN", `cannot link dirs (${(e as NodeJS.ErrnoException).code}) — installs fall back to copy`);
  }

  // repeated mkdir: Bun on Windows can throw EEXIST even with recursive:true.
  // The engine tolerates it, but the probe flags the runtime bug on this machine.
  try {
    const dup = path.join(envTmp, "dup-probe");
    fs.mkdirSync(dup, { recursive: true });
    fs.mkdirSync(dup, { recursive: true });
    add("env: mkdir recursive", "PASS", "repeat mkdir is silent (as on POSIX)");
  } catch (e) {
    add("env: mkdir recursive", "WARN", `runtime throws ${(e as NodeJS.ErrnoException).code} on existing dir — engine tolerates it`);
  }

  try { fs.rmSync(envTmp, { recursive: true, force: true }); } catch { /* tmp */ }

  // user PATH (Windows): engines up to 0.8.0 persisted %USERPROFILE%\.local\bin
  // to HKCU\Environment\Path even when USERPROFILE was a test's temporary HOME,
  // and deleting that HOME never removed the entry (issue #87: 22 of them on
  // one machine). The value is read as stored, so an unexpanded
  // %LOCALAPPDATA%\Temp\nrv-* entry is found too. Only reported here;
  // `nrv install --repair-path --apply` removes exactly these.
  if (process.platform === "win32") {
    const reg = readUserPath();
    if (!reg) {
      add("env: user PATH", "WARN", "could not read HKCU\\Environment\\Path (no such value, or PowerShell unavailable) — temporary nrv entries not checked");
    } else {
      const stale = findTempNrvEntries(reg.value, tempRoots());
      if (stale.length === 0) {
        add("env: user PATH", "PASS", "no temporary nrv entries in HKCU\\Environment\\Path");
      } else {
        const exists = (e: string) => fs.existsSync(expandEnv(e));
        const missing = stale.filter((e) => !exists(e)).length;
        const shown = stale.slice(0, 3).map((e) => `${e}${exists(e) ? "" : " (missing)"}`);
        add("env: user PATH", "WARN",
          `${stale.length} temporary nrv entr${stale.length === 1 ? "y" : "ies"} in HKCU\\Environment\\Path, ${missing} pointing at `
          + `directories that no longer exist: ${shown.join("; ")}${stale.length > shown.length ? `; … ${stale.length - shown.length} more` : ""}`
          + " — review with `nrv install --repair-path`, remove with `nrv install --repair-path --apply`");
      }
    }
  }
}

// SECTION 2: SKILLS
const requiredSkills = ["harness", "businesses", "squads", "_shared"];
for (const s of requiredSkills) {
  const p = path.join(SKILLS, s);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const skillMd = path.join(p, "SKILL.md");
    add(`skill: ${s}`, "PASS", fs.existsSync(skillMd) ? "with SKILL.md" : "(no SKILL.md)");
  } else {
    add(`skill: ${s}`, "FAIL", `missing ${p}`);
  }
}

// A runtime that honors BOTH the cross-runtime convention dir (~/.agents/skills)
// and its own (~/.gemini/skills, …) loads the same SKILL.md twice and logs
// "Skill conflict detected" for every skill — seen live on gemini-cli. Nothing
// breaks (both paths resolve to the same file) but the noise reads like a real
// problem, so name it precisely. Compared by realpath so a dir reachable under
// two names is not mistaken for two dirs.
const agentsSkillsDir = path.join(HOME, ".agents", "skills");
if (fs.existsSync(agentsSkillsDir)) {
  let agentsReal = "";
  try { agentsReal = fs.realpathSync(agentsSkillsDir); } catch { /* unreadable — skip */ }
  const otherDirs = RUNTIME_SKILL_DIRS.filter(d => {
    try { return fs.existsSync(d) && fs.realpathSync(d) !== agentsReal; } catch { return false; }
  });
  const doubled = new Map<string, string[]>();
  for (const s of requiredSkills) {
    let target = "";
    try { target = fs.realpathSync(path.join(agentsSkillsDir, s)); } catch { continue; }
    const also = otherDirs.filter(d => {
      try { return fs.realpathSync(path.join(d, s)) === target; } catch { return false; }
    });
    if (also.length) doubled.set(s, also);
  }
  if (doubled.size) {
    const dirs = [...new Set([...doubled.values()].flat())].map(d => d.replace(HOME, "~")).join(", ");
    add("skills: duplicate exposure", "WARN",
      `${doubled.size} skill(s) reachable through ~/.agents/skills AND ${dirs} — same file, but runtimes reading both log "Skill conflict detected". ~/.agents/skills is not created by this engine; remove it if nothing else needs it.`);
  } else {
    add("skills: duplicate exposure", "PASS", "no skill reachable through two directories");
  }
}

// Backup litter. Two shapes, two harms. A *.bak / *backup* entry INSIDE a
// runtime skills dir gets scanned like a skill, so a stale pre-migration copy
// loads next to the real one (seen live: squads.pre-nirvana.*.bak under
// ~/.antigravity/skills). And skills-backup-* piling up beside ~/.nirvana/skills
// are full copies of the tree nothing will ever read — `nrv update` keeps
// exactly one (the latest) and prunes the rest, so more than one here means
// that prune is not running.
{
  const litter: string[] = [];
  for (const d of RUNTIME_SKILL_DIRS) {
    try {
      for (const entry of fs.readdirSync(d)) {
        if (/\.bak$|\.old$|backup/i.test(entry)) litter.push(path.join(d, entry).replace(HOME, "~"));
      }
    } catch { /* dir absent — fine */ }
  }
  let staleBackups: string[] = [];
  try {
    staleBackups = fs.readdirSync(path.dirname(SKILLS))
      .filter((e) => e.startsWith("skills-backup-")).sort();
  } catch { /* parent unreadable — fine */ }
  const extra = staleBackups.length > 1 ? staleBackups.slice(0, -1) : [];
  if (litter.length || extra.length) {
    const parts: string[] = [];
    if (litter.length) parts.push(`${litter.length} stale entr${litter.length === 1 ? "y" : "ies"} inside skills dirs (${litter.join(", ")}) — loaded as if they were skills`);
    if (extra.length) parts.push(`${extra.length} old skills-backup-* beside ~/.nirvana/skills — nrv update keeps only the latest`);
    add("skills: backup litter", "WARN", parts.join("; ") + ". Safe to delete.");
  } else {
    add("skills: backup litter", "PASS", "no *.bak inside skills dirs, at most one skills-backup");
  }
}

// Project contract. `nrv init` writes AGENTS.md + CLAUDE.md + GEMINI.md into a
// project root; whichever one the runtime reads carries the invocation contract
// "before touching the project, regardless of skill activation". A working
// directory with none of them still orchestrates — the skill carries the
// protocol, and since 2026-08-13 the dispatch instruction carries the build and
// writing rules — but nothing tells the runtime to reach for the skill in the
// first place. That is a real degradation and it should be visible, not
// inferred. Checked only when the cwd looks like a working project, so running
// the doctor from a home directory is not scolded.
{
  const cwd = process.cwd();
  const looksLikeProject = [".git", "package.json", "outputs", ".nirvana"].some((m) => fs.existsSync(path.join(cwd, m)));
  const found = PROJECT_CONTRACT_FILES.filter((f) => fs.existsSync(path.join(cwd, f)));
  if (!looksLikeProject) {
    add("project: contract", "PASS", "cwd is not a project — nothing to check");
  } else if (found.length) {
    add("project: contract", "PASS", `${found.join(", ")} present`);
  } else {
    add("project: contract", "WARN",
      `no ${PROJECT_CONTRACT_FILES.join(" / ")} in ${cwd.replace(HOME, "~")} — the runtime has no instruction to invoke Nirvana, so a brief may be answered inline instead of dispatched. Fix: nrv init .`);
  }
}

// SECTION 3: REGISTRIES — same path resolution as the indexer (scope-aware via
// bun-helpers). The fixed path $HOME/.squads-registry.json was the LEGACY spot
// from before the ~/.nirvana migration: the doctor said "missing" right after a
// successful `nrv index`, because each one looked at a different place.
const squadsReg = nrvPaths.SQUADS_REGISTRY_PATH;
const bizReg = nrvPaths.BUSINESSES_REGISTRY_PATH;
// Mind-clones registry — same path resolution as _shared/scripts/index-clones.ts
// (project scope → <projectRoot>/.nirvana/, global → ~/.nirvana/). Before
// routing-360 Phase 2.5 the doctor never checked it, so it could sit stale for
// days while squads/businesses were flagged.
const clonesReg = (() => {
  try {
    const scope = resolveScope();
    return scope.projectRoot
      ? path.join(scope.projectRoot, ".nirvana", ".mind-clones-registry.json")
      : path.join(HOME, ".nirvana", ".mind-clones-registry.json");
  } catch {
    return path.join(HOME, ".nirvana", ".mind-clones-registry.json");
  }
})();
for (const [reg, label] of [[squadsReg, "squads"], [bizReg, "businesses"], [clonesReg, "mind-clones"]] as const) {
  if (fs.existsSync(reg)) {
    const stat = fs.statSync(reg);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600_000;
    const sizeKB = Math.round(stat.size / 1024);
    if (ageHours > 24) {
      add(`registry: ${label}`, "WARN", `${sizeKB}KB, ${Math.round(ageHours)}h stale — run \`nrv index\``);
    } else {
      add(`registry: ${label}`, "PASS", `${sizeKB}KB, ${Math.round(ageHours)}h old`);
    }
  } else {
    add(`registry: ${label}`, "FAIL", "missing — run `nrv index`");
  }
}

// SECTION 4: HOOKS
try {
  const settingsPath = path.join(HOME, ".claude/settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const pre = settings?.hooks?.PreToolUse || [];
    const post = settings?.hooks?.PostToolUse || [];
    const preNirvana = pre.filter((h: any) => JSON.stringify(h).includes("audit-emit-from-hook")).length;
    const postNirvana = post.filter((h: any) => JSON.stringify(h).includes("audit-emit-from-hook")).length;
    add("hooks: PreToolUse", preNirvana > 0 ? "PASS" : "WARN", `${preNirvana} nirvana hooks of ${pre.length} total`);
    add("hooks: PostToolUse", postNirvana > 0 ? "PASS" : "WARN", `${postNirvana} nirvana hooks of ${post.length} total`);
  } else {
    add("hooks: settings.json", "WARN", "claude-code settings.json not found");
  }
} catch (e: any) {
  add("hooks: settings.json", "FAIL", `parse error: ${e.message}`);
}

// A dispatched project leaves a dir with ANY of these markers: businesses/
// (business dispatch), squads/ (squad dispatch), HANDOFF.json, deliverables/
// or brief.md. We count by project name (dedup across roots). OS-safe: separate
// segments in path.join (Windows).
const OUTPUT_ROOTS = [
  path.join(process.cwd(), "outputs"),
  path.join(process.cwd(), ".nirvana", "outputs"),
  path.join(HOME, ".nirvana", "outputs"),
];
const DISPATCH_MARKERS = ["businesses", "squads", "HANDOFF.json", "deliverables", "brief.md"];
function countDispatchProjects(): number {
  const seen = new Set<string>();
  for (const root of OUTPUT_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const p of fs.readdirSync(root)) {
      const projPath = path.join(root, p);
      try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }
      if (DISPATCH_MARKERS.some(m => fs.existsSync(path.join(projPath, m)))) seen.add(p);
    }
  }
  return seen.size;
}
const dispatchProjects = countDispatchProjects();

// SECTION 5: AUDIT
// Report REAL activity — never mislead. Previously it only looked at TODAY in the
// cwd scope and, if empty, guessed "no dispatches yet?" (false when the dispatch was
// on another day, in another folder, or the agent — e.g. Codex — never ran `nrv audit emit`).
const today = new Date().toISOString().slice(0, 10);
const { harnessLogsDir } = require(path.join(SKILLS, "_shared/lib/log-paths.ts"));
// Possible scopes: project (cwd) + global (~/.harness-logs).
const auditRoots = Array.from(new Set<string>([harnessLogsDir(), path.join(HOME, ".harness-logs")]));
let auditDates: string[] = [];
let todayLines: string[] = [];
for (const root of auditRoots) {
  if (!fs.existsSync(root)) continue;
  for (const d of fs.readdirSync(root)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(root, d, "audit.jsonl"))) auditDates.push(d);
  }
  const todayFile = path.join(root, today, "audit.jsonl");
  if (fs.existsSync(todayFile)) {
    const l = fs.readFileSync(todayFile, "utf8").split("\n").filter(x => x.trim());
    if (l.length) todayLines = l;
  }
}
auditDates = Array.from(new Set(auditDates)).sort();
if (todayLines.length) {
  const counts: Record<string, number> = {};
  // Unreadable lines were counted in the total and missing from the breakdown,
  // so the check said "N events, all good" over a partly corrupt log. A health
  // report must not smooth over data it could not read.
  let unreadable = 0;
  for (const l of todayLines) {
    try { const e = parseAuditLine(l); counts[e.event] = (counts[e.event] || 0) + 1; }
    catch { unreadable++; }
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).slice(0, 6).join(" ");
  const readable = todayLines.length - unreadable;
  if (unreadable) {
    add("audit: today", "WARN", `${readable} readable event(s) today · ${unreadable} UNREADABLE line(s) in the log · ${summary}`);
  } else {
    add("audit: today", "PASS", `${todayLines.length} events today · ${summary}`);
  }
} else if (auditDates.length) {
  add("audit: recent", "PASS", `no events today; last activity ${auditDates[auditDates.length - 1]} (${auditDates.length} day(s) logged)`);
} else if (dispatchProjects > 0) {
  add("audit: log", "WARN", `${dispatchProjects} dispatch output(s) found but NO audit events — the running agent isn't emitting 'nrv audit emit' (scripted 'nrv dispatch' writes them automatically; see SKILL.md)`);
} else {
  add("audit: log", "WARN", "no audit log and no dispatch outputs — nothing dispatched yet");
}

// SECTION 6: LIBRARIES
const homeBiz = path.join(HOME, "businesses");
const homeSquads = path.join(HOME, "squads");
const dnaLib = path.join(HOME, "businesses/_library/dna");
if (fs.existsSync(homeBiz)) {
  const dirs = fs.readdirSync(homeBiz).filter(d => fs.statSync(path.join(homeBiz, d)).isDirectory() && !d.startsWith("_"));
  add("library: businesses", "PASS", `${dirs.length} businesses in ~/businesses/`);
} else {
  add("library: businesses", "WARN", "~/businesses/ not created yet");
}
if (fs.existsSync(homeSquads)) {
  const dirs = fs.readdirSync(homeSquads).filter(d => fs.statSync(path.join(homeSquads, d)).isDirectory());
  add("library: squads", "PASS", `${dirs.length} squads in ~/squads/`);
} else {
  add("library: squads", "WARN", "~/squads/ not created yet");
}
if (fs.existsSync(dnaLib)) {
  // Flat layout: dna/<slug>/MANIFEST.yaml — count clone dirs that hold a manifest.
  const cloneCount = fs.readdirSync(dnaLib).filter(d => {
    const p = path.join(dnaLib, d);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "MANIFEST.yaml"));
  }).length;
  add("library: mind-clones", "PASS", `${cloneCount} clones in _library/dna/`);
} else {
  add("library: mind-clones", "WARN", "no mind-clone library — run with --starter");
}

// SECTION 6.2: PROTOCOL
//
// What the library DECLARES, counted, so a rollout is visible before it is
// enforced: how many squads are still on v5 while the engine reads v6, and how
// many businesses still carry fields v2 retired. Never a FAIL — this is a
// migration dashboard, and CI treats a doctor exit >= 2 as a broken machine.
// Blocking is `nrv validate`'s job, behind its own flags.
{
  const RETIRED_SEAT_FIELDS = /^(heartbeat|self_score_contract|draws_from|dna_reference|budget_monthly_usd|mentions|escalation_triggers|disclosure_template|default_tools|project_tool_overrides):/m;
  const declared = (file: string): string | null => {
    try { return /^protocol:\s*["']?([\d.]+)/m.exec(fs.readFileSync(file, "utf8").slice(0, 4096))?.[1] ?? null; }
    catch { return null; }
  };
  const dirsOf = (root: string): string[] => {
    try { return fs.readdirSync(root).filter((d) => !d.startsWith("_") && !d.startsWith(".")); } catch { return []; }
  };

  if (fs.existsSync(homeSquads)) {
    const byProtocol = new Map<string, number>();
    for (const slug of dirsOf(homeSquads)) {
      const manifest = path.join(homeSquads, slug, "squad.yaml");
      if (!fs.existsSync(manifest)) continue;
      const v = declared(manifest) ?? "unset";
      byProtocol.set(v, (byProtocol.get(v) ?? 0) + 1);
    }
    const total = [...byProtocol.values()].reduce((a, b) => a + b, 0);
    const spread = [...byProtocol.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${n}×${v}`).join(" · ");
    const belowSix = total - (byProtocol.get("6.0") ?? 0);
    add("protocol: squads", belowSix > 0 ? "WARN" : "PASS",
      belowSix > 0
        ? `${spread} — ${belowSix} below 6.0; migrate one with \`nrv migrate <slug> --to 6\``
        : `${total} squads, all on 6.0`);
  }

  if (fs.existsSync(homeBiz)) {
    let v1 = 0, withRetired = 0, total = 0;
    for (const slug of dirsOf(homeBiz)) {
      const manifest = path.join(homeBiz, slug, "business.yaml");
      if (!fs.existsSync(manifest)) continue;
      total++;
      if ((declared(manifest) ?? "1.0") !== "2.0") v1++;
      const empDir = path.join(homeBiz, slug, "employees");
      let hit = false;
      try {
        for (const f of fs.readdirSync(empDir)) {
          if (!f.endsWith(".md")) continue;
          if (RETIRED_SEAT_FIELDS.test(fs.readFileSync(path.join(empDir, f), "utf8").slice(0, 4096))) { hit = true; break; }
        }
      } catch { /* no employees/ is a different check's problem */ }
      if (hit) withRetired++;
    }
    add("protocol: businesses", v1 > 0 || withRetired > 0 ? "WARN" : "PASS",
      v1 > 0 || withRetired > 0
        ? `${v1} of ${total} still on protocol 1.0 · ${withRetired} carry fields v2 retired — \`nrv validate business <slug> --fix\``
        : `${total} businesses on protocol 2.0, no retired fields`);
  }
}

// SECTION 6.5: PAID INSTALL
//
// The doctor had nothing here. On a machine where a paid pack installed its
// content but never installed its license, every check above passed and the
// last line read "All systems nominal" — while `nrv update <slug>` was already
// broken and would stay broken until the buyer wrote to support days later.
// These are the things a buyer would notice were missing, if anything told them.
const licStore = path.join(HOME, ".nirvana-license", "PROVENANCE.json");
const packsDir = path.join(HOME, ".nirvana", "packs");
const installedPacks = fs.existsSync(packsDir)
  ? fs.readdirSync(packsDir).filter((f) => f.endsWith(".json"))
  : [];

if (installedPacks.length === 0) {
  add("paid: pack", "PASS", "no paid pack installed (free engine)");
} else {
  const names = installedPacks.map((f) => f.replace(/\.json$/, ""));
  add("paid: pack", "PASS", `${names.join(", ")}`);

  if (!fs.existsSync(licStore)) {
    add("paid: license", "FAIL",
      `pack installed but no license at ${licStore.replace(HOME, "~")} — ` +
      `"nrv update ${names[0]}" cannot work. Fix: nrv license install`);
  } else {
    try {
      const prov = JSON.parse(fs.readFileSync(licStore, "utf8"));
      if (!prov.license_key) {
        add("paid: license", "FAIL", "PROVENANCE.json has no license_key — that copy has no provenance");
      } else if (!prov.signature) {
        add("paid: license", "WARN", `${prov.license_key} — unsigned (offline use is fine; support cannot verify it)`);
      } else {
        add("paid: license", "PASS", `${prov.license_key}${prov.edition ? ` (${prov.edition})` : ""}`);
      }
    } catch (e) {
      add("paid: license", "FAIL", `cannot read ${licStore.replace(HOME, "~")}: ${(e as Error).message}`);
    }
  }

  // The overlay is only real if the components it recorded are on disk. A
  // manifest that lists content nobody can find is the expensive failure: the
  // install LOOKS complete.
  for (const f of installedPacks) {
    const slug = f.replace(/\.json$/, "");
    try {
      const man = JSON.parse(fs.readFileSync(path.join(packsDir, f), "utf8"));
      const kinds: Array<[string, string]> = [
        ["squads", homeSquads], ["businesses", homeBiz], ["mind-clones", dnaLib],
      ];
      const missing: string[] = [];
      let total = 0;
      for (const [kind, dir] of kinds) {
        for (const slugName of Object.keys(man[kind] ?? {})) {
          total++;
          if (!fs.existsSync(path.join(dir, slugName))) missing.push(`${kind}/${slugName}`);
        }
      }
      if (total === 0) add(`paid: content ${slug}`, "WARN", "manifest records no components");
      else if (missing.length) {
        add(`paid: content ${slug}`, "FAIL",
          `${missing.length} of ${total} missing from the library (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}) — re-run: nrv update ${slug}`);
      } else add(`paid: content ${slug}`, "PASS", `${total} components present`);
    } catch (e) {
      add(`paid: content ${slug}`, "FAIL", `unreadable manifest: ${(e as Error).message}`);
    }
  }
}

// The cross-language alias groups, at the path the router actually reads. Its
// absence is a silent routing downgrade: a brief in one language against an
// entity declared in another stops getting its coverage lift, and nothing says
// so at dispatch time.
try {
  const aliasPath = (nrvPaths as Record<string, string>).KEYWORD_ALIASES_PATH;
  if (!aliasPath) add("routing: aliases", "WARN", "this engine predates KEYWORD_ALIASES_PATH");
  else if (!fs.existsSync(aliasPath)) {
    add("routing: aliases", "WARN",
      `${aliasPath.replace(HOME, "~")} missing — cross-language routing runs without alias lift. Fix: nrv index`);
  } else {
    const groups = JSON.parse(fs.readFileSync(aliasPath, "utf8"));
    const n = Array.isArray(groups) ? groups.length : 0;
    if (n === 0) add("routing: aliases", "WARN", "no alias groups — a corpus in one language emits none");
    else add("routing: aliases", "PASS", `${n} cross-language group(s)`);
  }
} catch (e) {
  add("routing: aliases", "WARN", `cannot read alias groups: ${(e as Error).message}`);
}

// Invocation keys nothing reads. `triggers:` and `trigger_threshold:` name a
// command (`*full-tutoring`, `*wiki`) and how many must match before a workflow
// fires — a convention from before the agentic router, and one NO version of
// the protocol ever defined: v4 does not, v5 mentions it zero times, and v6
// mentions it once, in the line that preserves it verbatim in `extensions`.
// No code reads either key. Routing is decided by produces, keywords and
// example_briefs, weighed by a maestro comparing candidates.
//
// So this reports and stops. There is no fixer, and there will not be one:
// those commands are text the author wrote, the normalizer keeps them on
// purpose, and deleting an author's content to clear a diagnostic line is the
// opposite of what the fixers do. The goal is for dead surface to stop being
// INVISIBLE, not to stop existing. WARN, never FAIL — same contract as the
// Protocol section above.
if (fs.existsSync(homeSquads)) {
  try {
    const { readSquadWorkflows } = await import("../../squads/lib/workflow-reader.ts");
    const VESTIGIAL = ["triggers", "trigger_threshold"] as const;
    const perKey = new Map<string, number>(VESTIGIAL.map((k) => [k, 0]));
    let files = 0, squads = 0, workflows = 0;
    for (const slug of fs.readdirSync(homeSquads)) {
      if (slug.startsWith(".")) continue;
      let hit = false;
      for (const w of readSquadWorkflows(path.join(homeSquads, slug))) {
        if (!w.normalized) continue;
        workflows++;
        const ext = w.normalized.canonical.extensions;
        const found = VESTIGIAL.filter((k) => ext[k] !== undefined);
        if (!found.length) continue;
        files++; hit = true;
        for (const k of found) perKey.set(k, (perKey.get(k) ?? 0) + 1);
      }
      if (hit) squads++;
    }
    const spread = VESTIGIAL.filter((k) => (perKey.get(k) ?? 0) > 0).map((k) => `${perKey.get(k)}× \`${k}\``).join(" · ");
    if (files === 0) {
      add("routing: vestigial triggers", "PASS", `${workflows} workflow(s) read, none declares an invocation key the router ignores`);
    } else {
      add("routing: vestigial triggers", "WARN",
        `${files} of ${workflows} workflow(s) in ${squads} squad(s) declare ${spread} — decorative. `
        + `No protocol version defines those keys and no code reads them; routing goes by produces, keywords and example_briefs. `
        + `They are preserved verbatim in \`extensions\` and no fixer removes them: this line exists so the dead surface is visible, not so it gets deleted.`);
    }
  } catch (e) {
    add("routing: vestigial triggers", "WARN", `could not read the workflow library: ${(e as Error).message}`);
  }
}

// Corpus language, because it decides how good `fast` mode can be.
//
// The agentic router (the default) reads the digest and reasons, so it routes a
// brief in any language against an entity declared in any other. `fast` is BM25:
// it matches tokens, and a brief and an entity in different languages share
// none. Measured on 20 held-out paraphrase pairs, cross-language parity in fast
// mode was 25%.
//
// So this is a progress bar, not an error. A mixed corpus is not broken — it is
// partway to one language, and this says how far.
try {
  const { corpusMix } = await import("../../_shared/lib/corpus-language.ts");
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const mix = corpusMix(req(path.join(SKILLS, "harness", "lib", "registry-loader.js")).loadAll());
  if (!mix) add("corpus: language", "PASS", "no content library — nothing to weigh");
  else if (mix.minorityPct < 10) {
    add("corpus: language", "PASS", `${mix.enPct}% English / ${mix.ptPct}% Portuguese — fast mode is on solid ground`);
  } else {
    add("corpus: language", "WARN",
      `${mix.enPct}% English / ${mix.ptPct}% Portuguese · ${mix.queue.length} entities still to translate. `
      + `The agentic default is unaffected; 'fast' mode routes by token match, so a brief in one language `
      + `can miss entities declared in the other.`);
  }
} catch (e) {
  add("corpus: language", "WARN", `could not weigh the corpus: ${(e as Error).message}`);
}

// Per-buyer watermarks in a library that AUTHORS packs. Rationale and mechanics
// live in _shared/lib/watermark-scan.ts, shared with the end of `nrv update` — the
// command that introduces them.
{
  const isAuthor = authorsPacks(HOME);
  const libs = [nrvPaths.SQUADS_DIR, nrvPaths.BUSINESSES_DIR].filter(d => fs.existsSync(d));
  let hits = 0, scanned = 0;
  const dirty: string[] = [];
  for (const lib of libs) {
    const r = scanLibrary(lib);
    hits += r.hits.length; scanned += r.scanned;
    if (r.hits.length) dirty.push(`${lib.replace(HOME, "~")} (${r.hits.length})`);
  }
  if (!libs.length) {
    add("library: watermarks", "PASS", "no content library on this machine");
  } else if (!hits) {
    add("library: watermarks", "PASS", `clean — ${scanned} files checked in ${libs.length} librar${libs.length > 1 ? "ies" : "y"}`);
  } else if (isAuthor) {
    add("library: watermarks", "FAIL",
      `${hits} per-buyer marker(s) in ${dirty.join(", ")} — this machine authors packs, so they would ship and misattribute every buyer's copy. ${STRIP_HINT}`);
  } else {
    add("library: watermarks", "WARN",
      `${hits} per-buyer marker(s) in ${dirty.join(", ")} — normal for installed paid content; only a problem if this machine builds packs`);
  }
}

// SECTION 7: RECENT DISPATCHES
// Count dispatched projects by REAL marker (business OR squad OR HANDOFF/brief),
// not just `businesses/` — previously a squad dispatch (the starter pack is
// squad-heavy) counted zero and the label lied "HANDOFF.json".
add("recent: dispatched projects", dispatchProjects > 0 ? "PASS" : "WARN",
    dispatchProjects > 0
      ? `${dispatchProjects} dispatch project dir(s) in outputs/ (cwd or ~/.nirvana/outputs)`
      : "no dispatch project dirs in outputs/ (cwd or ~/.nirvana/outputs)");

// SECTION 8: KEY PATCHES APPLIED
const keyFiles: [string, string][] = [
  [path.join(SKILLS, "_shared/lib/handoff.js"), "F1: updateHandoffPhase"],
  [path.join(SKILLS, "businesses/scripts/verify-deliverable.ts"), "F2: verify-deliverable"],
  [path.join(SKILLS, "businesses/lib/loader-cli.py"), "F4: loader-cli wrapper"],
  [path.join(SKILLS, "businesses/lib/employee-prompt.ts"), "F8: DNA injection helper"],
  [path.join(SKILLS, "harness/scripts/quality-gate.ts"), "F9: quality-gate driver"],
  [path.join(SKILLS, "harness/scripts/validate-chain.ts"), "F3 enforcer: validate-chain"],
];
for (const [file, label] of keyFiles) {
  add(`patch: ${label}`, fs.existsSync(file) ? "PASS" : "FAIL", fs.existsSync(file) ? "applied" : `missing ${file}`);
}

// SECTION 9: CONFIG — the effective value and origin of every operational
// setting (_shared/lib/settings-schema.ts), by the same resolution every reader
// uses (env > project > global > engine default > default): one line per key,
// no secrets (the schema holds none). A config file the resolver cannot read is
// a FAIL here, because every reader refuses it the same way.
try {
  const projectRoot = discoverProjectRoot();
  const files: Array<[string, string | null]> = [
    ["project", projectRoot ? projectConfigPath(projectRoot) : null],
    ["global", globalConfigPath()],
    ["engine", engineConfigPath()],
  ];
  const settings = resolveAllSettings(); // refuses a broken file before any line is added
  add("config: files", "PASS", files
    .map(([label, file]) => `${label} ${file ? `${file.replace(HOME, "~")}${fs.existsSync(file) ? "" : " (absent)"}` : "(none)"}`)
    .join(" · "));
  for (const setting of settings) {
    add(`config: ${setting.key}`, "PASS", `${JSON.stringify(setting.value)} (${describeSettingSource(setting).replace(HOME, "~")})`);
  }
} catch (e) {
  add("config: files", "FAIL", `${(e as Error).message} — fix the file; every reader refuses it the same way (nrv config list shows the same error)`);
}

// OUTPUT
const passCount = checks.filter(c => c.status === "PASS").length;
const warnCount = checks.filter(c => c.status === "WARN").length;
const failCount = checks.filter(c => c.status === "FAIL").length;
const total = checks.length;

if (json) {
  console.log(JSON.stringify({
    summary: { total, pass: passCount, warn: warnCount, fail: failCount },
    checks,
  }, null, 2));
  process.exit(failCount > 0 ? 2 : (warnCount > 0 ? 1 : 0));
}

console.log("");
console.log(c("bold", "  Nirvana-OS Doctor"));
console.log(c("dim", `  ${total} checks · ${passCount} pass · ${warnCount} warn · ${failCount} fail`));
console.log("");

let lastCategory = "";
for (const ck of checks) {
  const category = ck.name.split(":")[0];
  if (category !== lastCategory) {
    if (lastCategory) console.log("");
    console.log(c("magenta", "  " + category.toUpperCase()));
    lastCategory = category;
  }
  const icon = ck.status === "PASS" ? c("green", "✓") : ck.status === "WARN" ? c("yellow", "⚠") : c("red", "✗");
  const detail = ck.name.split(":").slice(1).join(":").trim();
  console.log(`    ${icon} ${c("bold", detail.padEnd(28))} ${c("dim", ck.note)}`);
}

console.log("");
if (failCount > 0) {
  console.log(c("red", `  ✗ ${failCount} critical failure(s). Fix before dispatching anything.`));
  process.exit(2);
} else if (warnCount > 0) {
  console.log(c("yellow", `  ⚠ ${warnCount} warning(s). System usable but degraded.`));
  process.exit(1);
} else {
  console.log(c("green", "  ✓ All systems nominal. Nirvana-OS is impeccable."));
  process.exit(0);
}
