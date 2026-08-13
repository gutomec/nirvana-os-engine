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
 * Runtime skill directories, in install order. NO runtime is a prerequisite,
 * not even Claude Code: each is wired only when it is actually installed (its
 * home dir exists). The canonical tree at ~/.nirvana/skills is the one thing
 * always created, and every runtime consumes it from there.
 */
export const RUNTIME_SKILL_DIRS = [
  join(homedir(), ".claude/skills"),
  join(homedir(), ".codex/skills"),
  join(homedir(), ".gemini/skills"),
  join(homedir(), ".antigravity/skills"),
  join(homedir(), ".pi/agent/skills"),   // Pi Coding Agent (Agent Skills standard)
  // OpenClaw reads ~/.agents/skills as its "personal agent skills" source. It
  // is a real runtime dir, not a stray: linking the engine there is the only
  // way an OpenClaw session ever sees the harness. Note that a SYMLINK of this
  // whole directory to another runtime's tree is a different thing and a bad
  // one — it makes every skill reachable twice and runtimes that honour both
  // paths log "Skill conflict detected" (see doctor: duplicate exposure).
  // Per-skill links into ~/.nirvana/skills, like every other entry here, do not
  // have that problem.
  join(homedir(), ".agents/skills"),     // OpenClaw (personal agent skills)
];

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
