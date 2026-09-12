// skills-litter.ts — what inside a runtime skills directory is a leftover copy,
// and what is simply a skill whose name contains the word "backup".
//
// The doctor used to answer that with one substring: `/\.bak$|\.old$|backup/i`.
// The first two branches name a convention; the third names nothing. On a real
// installation it flagged `~/.claude/skills/backup-verificado` — a loaded skill
// with valid frontmatter, and the one that machine's own contract required
// before any format — and printed "Safe to delete" about it (issue #251).
//
// Two claims, two confidences:
//
//   copies  a conventional copy name (`*.bak`, `*.old`, `skills-backup-*`).
//           Safe to delete, and deliberately NOT filtered by "does it carry a
//           SKILL.md": a copy of a skill carries one too, which is precisely
//           why the runtime loads it next to the original. The live case that
//           built this check was `squads.pre-nirvana.*.bak`.
//   unsure  named like a backup but carrying no SKILL.md. The runtime scans it
//           as a skill and it is not one, so it is worth reporting — but what
//           it is, and whether it can go, the tool does not know.
//
// A directory whose name merely contains "backup" AND which carries a SKILL.md
// is a skill. It appears in neither list.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SkillsLitter {
  /** Conventional copies — safe to delete. */
  copies: string[];
  /** Named like a backup, not loadable as a skill — report, do not advise. */
  unsure: string[];
}

const COPY_NAME = /\.bak$|\.old$|^skills-backup-/i;

export function classifySkillsLitter(dirs: string[], home: string = os.homedir()): SkillsLitter {
  const copies: string[] = [];
  const unsure: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }   // dir absent — fine
    for (const entry of entries) {
      const shown = path.join(dir, entry).replace(home, "~");
      if (COPY_NAME.test(entry)) { copies.push(shown); continue; }
      if (!/backup/i.test(entry)) continue;
      if (!fs.existsSync(path.join(dir, entry, "SKILL.md"))) unsure.push(shown);
    }
  }
  return { copies, unsure };
}
