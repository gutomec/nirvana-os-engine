/**
 * runtime-dirs.ts — the ONE definition of what the engine wires into runtimes.
 *
 * `scripts/install.ts` (bootstrap installer) and
 * `skills/_shared/scripts/uninstall-engine.ts` both need this list. They used to
 * keep private copies and drifted: the uninstaller never learned about
 * `~/.pi/agent/skills`, so `nrv uninstall --engine` left the pi links orphaned.
 * One module, one truth — a new runtime is added here and both sides follow.
 *
 * Import path from the bootstrap installer: the release tarball ships
 * `scripts/install.ts` NEXT TO the full `skills/` tree (see
 * scripts/build-engine-tarball.ts), i.e. the same relative layout as the repo,
 * so `../skills/_shared/lib/runtime-dirs.ts` resolves in both contexts.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime skill targets, in install order. NO runtime is a prerequisite, not
 * even Claude Code. A runtime counts as installed when EITHER its home dir
 * exists OR its CLI binary is on PATH — two signals, because the single
 * dir-exists proxy silently skipped freshly npm-installed runtimes whose home
 * dir is only created on first run (OpenClaw: binary present, ~/.agents
 * absent, linking skipped with no error, and the buyer concluded the product
 * was broken). With the binary present the installer now CREATES the dir; the
 * old rule of never conjuring ~/.claude on a machine that never had Claude
 * Code still holds, because a missing binary still skips — loudly.
 *
 * `note` is printed after linking: runtime-specific facts the user cannot
 * discover from inside the runtime (OpenClaw reads no project contract).
 */
export interface RuntimeTarget {
  /** Adapter name as the docs and doctor call it. */
  name: string;
  /** CLI binary probed on PATH (second install signal). */
  bin: string;
  /** The skills directory the engine links/copies into. */
  skillsDir: string;
  /** Printed once after wiring — invocation facts the runtime can't teach. */
  note?: string;
}

export const RUNTIME_TARGETS: RuntimeTarget[] = [
  { name: "claude-code", bin: "claude", skillsDir: join(homedir(), ".claude/skills") },
  { name: "codex", bin: "codex", skillsDir: join(homedir(), ".codex/skills") },
  { name: "gemini-cli", bin: "gemini", skillsDir: join(homedir(), ".gemini/skills") },
  { name: "antigravity-cli", bin: "agy", skillsDir: join(homedir(), ".antigravity/skills") },
  // Pi Coding Agent (Agent Skills standard)
  { name: "pi", bin: "pi", skillsDir: join(homedir(), ".pi/agent/skills") },
  // OpenClaw reads ~/.agents/skills as its "personal agent skills" source. It
  // is a real runtime dir, not a stray: linking the engine there is the only
  // way an OpenClaw session ever sees the harness. Note that a SYMLINK of this
  // whole directory to another runtime's tree is a different thing and a bad
  // one — it makes every skill reachable twice and runtimes that honour both
  // paths log "Skill conflict detected" (see doctor: duplicate exposure).
  // Per-skill links into ~/.nirvana/skills, like every other entry here, do not
  // have that problem.
  {
    name: "openclaw",
    bin: "openclaw",
    skillsDir: join(homedir(), ".agents/skills"),
    note: "OpenClaw works in an agent's WORKSPACE, not in cwd: a project meets it when the project IS the workspace — `openclaw agents add <name> --workspace <project> --non-interactive` — and then AGENTS.md is the agent's operating instructions and every nrv call logs in the project. Dispatch is the scripted path (nrv dispatch --exec).",
  },
];

/** Back-compat view (uninstaller iterates plain dirs). */
export const RUNTIME_SKILL_DIRS = RUNTIME_TARGETS.map((t) => t.skillsDir);

/**
 * The instruction files agent runtimes read from a project root. `nrv init`
 * writes all three so every supported adapter finds one: AGENTS.md serves
 * antigravity, codex, grok, kimi and pi; CLAUDE.md serves claude-code;
 * GEMINI.md serves gemini-cli. Checking for any ONE of them is how you ask
 * "was this project initialised?" without assuming a runtime.
 */
export const PROJECT_CONTRACT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** The skill trees the engine ships, copies to ~/.nirvana/skills and links into every runtime dir. */
export const SKILLS = ["harness", "businesses", "squads", "_shared", "nirvana-os"];

/**
 * Marker file the installer writes inside a COPIED runtime skill directory
 * (Windows, Codex, `--copy-skills`). It is how a later install or uninstall
 * tells OUR copy apart from a user directory that merely shares the name.
 */
export const COPY_MARKER = ".nirvana-skill-copy";
