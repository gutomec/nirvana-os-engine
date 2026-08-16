#!/usr/bin/env bun
/**
 * check-version-parity.ts — one version, told the same way everywhere.
 *
 * The engine states its version in two places and they are read by different
 * people. `package.json` is what the release tag and the changelog track.
 * `skills/VERSION` is a loose file copied verbatim into the installed skills
 * directory, and it is the FIRST thing `nrv --version` reads — the number a user
 * sees when they ask what they are running.
 *
 * They drifted on the 0.6.0 release: package.json moved, `skills/VERSION` did
 * not, and every user of 0.6.0 would have been told they were on 0.5.2. Nothing
 * failed, nothing warned; the number was simply wrong for everyone. It was found
 * by running `nrv --version` on the maintainer's own machine after the release
 * had already shipped.
 *
 * The version also has to match the newest entry in the changelog, because a
 * release whose changelog does not mention it is a release nobody can read about.
 *
 * Usage:
 *   bun scripts/check-version-parity.ts
 *   bun scripts/check-version-parity.ts --strict   # exit 1 on any divergence
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RED = "\x1b[31m", GRN = "\x1b[32m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const REPO = join(import.meta.dir, "..");
const strict = process.argv.includes("--strict");

const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const pkg = JSON.parse(read("package.json")).version as string;
const versionFile = read("skills/VERSION").trim();
/** The first `## X.Y.Z` heading in the changelog is the release being shipped. */
const changelog = read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m)?.[1] ?? "(none)";

const sources: Array<[string, string, string]> = [
  ["package.json", pkg, "what the tag and the release workflow track"],
  ["skills/VERSION", versionFile, "what `nrv --version` prints to the user"],
  ["CHANGELOG.md", changelog, "the newest entry a user can read"],
];

console.log(`\n${BOLD}VERSION PARITY${RST}`);
const distinct = new Set(sources.map(([, v]) => v));
for (const [where, value, why] of sources) {
  const bad = value !== pkg;
  console.log(`  ${bad ? `${RED}✗${RST}` : `${GRN}✓${RST}`} ${where.padEnd(16)} ${value.padEnd(10)} ${DIM}${why}${RST}`);
}
console.log();

if (distinct.size === 1) {
  console.log(`${GRN}  All three agree on ${pkg}.${RST}\n`);
  process.exitCode = 0;
} else {
  console.log(`${RED}  They disagree.${RST} ${DIM}A user who runs \`nrv --version\` reads skills/VERSION,`);
  console.log(`  not package.json — so a stale one tells every user the wrong number`);
  console.log(`  while every check stays green.${RST}\n`);
  process.exitCode = strict ? 1 : 0;
}
