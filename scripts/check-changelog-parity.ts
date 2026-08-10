#!/usr/bin/env bun
// check-changelog-parity.ts — keeps the localized changelogs from drifting apart.
//
// Why this gate exists: the changelog HAD drifted, and nobody noticed for months.
// Entries 0.1.53–0.1.60 were written in English and everything newer only in
// PT-BR, so an international buyer could read the product's old history and not
// its recent one — exactly the part that decides whether they update. Drift of
// this kind is invisible in review (both files look fine on their own) and only
// shows up when someone who reads the other language goes looking.
//
// What it compares — STRUCTURE, never prose. A translation must say the same
// thing in another language, so the text cannot be diffed; what CAN be diffed is
// the shape, and a missing section always changes the shape:
//
//   1. both files exist and carry the locale header linking the variants
//   2. the sequence of `## ` version headings: same versions, same order, same
//      dates. A release present in one file and absent in the other is the exact
//      failure that motivated this gate.
//   3. per version, the number of `### ` sections
//   4. per version, the number of table rows — an exit-code table dropped in
//      translation is a real loss the section count alone would not catch
//
// The unreleased heading is matched POSITIONALLY, not by an allowlist of
// translations ("Unreleased" / "Não lançado" / "未发布" …): any `## ` heading that
// does not start with a semver occupies an unversioned slot, and the slots must
// line up. That way a new locale never has to be taught to this script.
//
// Usage:
//   bun scripts/check-changelog-parity.ts            # report
//   bun scripts/check-changelog-parity.ts --strict   # exit 1 on any divergence
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const PRIMARY = "CHANGELOG.md";

export interface Section { heading: string; tableRows: number; }
export interface Version { key: string; heading: string; date: string | null; sections: Section[]; }

/**
 * Parse a changelog into comparable structure. `key` is the semver when the
 * heading starts with one, else `unversioned#<n>` — which is what lets a
 * translated "Unreleased" match without this script knowing any language.
 */
export function parseChangelog(text: string): { hasLocaleHeader: boolean; versions: Version[] } {
  const lines = text.split("\n");
  const versions: Version[] = [];
  let unversioned = 0;
  let current: Version | null = null;
  let section: Section | null = null;
  let inFence = false;

  for (const line of lines) {
    // A `##` inside a fenced block is sample output, not a heading.
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;

    const h2 = /^##\s+(.*\S)\s*$/.exec(line);
    if (h2) {
      const heading = h2[1];
      const semver = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(heading);
      const date = /(\d{4}-\d{2}-\d{2})/.exec(heading);
      current = {
        key: semver ? semver[1] : `unversioned#${unversioned++}`,
        heading,
        date: date ? date[1] : null,
        sections: [],
      };
      versions.push(current);
      section = null;
      continue;
    }

    const h3 = /^###\s+(.*\S)\s*$/.exec(line);
    if (h3 && current) {
      section = { heading: h3[1], tableRows: 0 };
      current.sections.push(section);
      continue;
    }

    // Table rows belong to the section when there is one, otherwise to the
    // version's preamble — counted either way, via a synthetic preamble section.
    if (/^\s*\|/.test(line) && current) {
      if (!section) {
        section = { heading: "(preamble)", tableRows: 0 };
        current.sections.push(section);
      }
      section.tableRows++;
    }
  }

  return { hasLocaleHeader: /\*\*Read this in your language:\*\*/.test(text), versions };
}

/** Locale variants of the changelog: CHANGELOG.<locale>.md next to the primary. */
function localeFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(f => /^CHANGELOG\.[A-Za-z-]+\.md$/.test(f))
    .sort();
}

function compare(primary: ReturnType<typeof parseChangelog>, other: ReturnType<typeof parseChangelog>, name: string, problems: string[]): void {
  if (!other.hasLocaleHeader) {
    problems.push(`${name}: missing the locale header ("**Read this in your language:** …")`);
  }

  const pKeys = primary.versions.map(v => v.key);
  const oKeys = other.versions.map(v => v.key);

  const missing = pKeys.filter(k => !oKeys.includes(k));
  const extra = oKeys.filter(k => !pKeys.includes(k));
  for (const k of missing) problems.push(`${name}: version ${k} is in ${PRIMARY} but missing here`);
  for (const k of extra) problems.push(`${name}: version ${k} is here but missing from ${PRIMARY}`);

  if (!missing.length && !extra.length && pKeys.join("|") !== oKeys.join("|")) {
    problems.push(`${name}: versions are in a different ORDER than ${PRIMARY}\n    ${PRIMARY}: ${pKeys.join(", ")}\n    ${name}: ${oKeys.join(", ")}`);
  }

  for (const pv of primary.versions) {
    const ov = other.versions.find(v => v.key === pv.key);
    if (!ov) continue;   // already reported as missing

    if (pv.date !== ov.date) {
      problems.push(`${name}: version ${pv.key} is dated ${ov.date ?? "(none)"} but ${PRIMARY} says ${pv.date ?? "(none)"}`);
    }
    if (pv.sections.length !== ov.sections.length) {
      problems.push(
        `${name}: version ${pv.key} has ${ov.sections.length} section(s), ${PRIMARY} has ${pv.sections.length}` +
        `\n    ${PRIMARY}: ${pv.sections.map(s => s.heading).join(" · ") || "(none)"}` +
        `\n    ${name}: ${ov.sections.map(s => s.heading).join(" · ") || "(none)"}`,
      );
      continue;   // section-by-section comparison is meaningless once counts differ
    }
    for (let i = 0; i < pv.sections.length; i++) {
      const p = pv.sections[i], o = ov.sections[i];
      if (p.tableRows !== o.tableRows) {
        problems.push(
          `${name}: version ${pv.key}, section ${i + 1} ("${o.heading}") has ${o.tableRows} table row(s), ` +
          `${PRIMARY} has ${p.tableRows} in "${p.heading}"`,
        );
      }
    }
  }
}

export interface ParityReport {
  ok: boolean;
  /** null when the primary is absent, [] when there is nothing to compare. */
  variants: string[] | null;
  versions: number;
  sections: number;
  problems: string[];
}

/** The whole check, as a function, so tests can run it over a fixture directory. */
export function checkParity(dir: string = ROOT): ParityReport {
  const problems: string[] = [];
  const primaryPath = join(dir, PRIMARY);
  if (!existsSync(primaryPath)) {
    return { ok: false, variants: null, versions: 0, sections: 0, problems: [`${PRIMARY} not found in ${dir}`] };
  }
  const primary = parseChangelog(readFileSync(primaryPath, "utf8"));
  if (!primary.hasLocaleHeader) problems.push(`${PRIMARY}: missing the locale header ("**Read this in your language:** …")`);

  const variants = localeFiles(dir);
  for (const f of variants) compare(primary, parseChangelog(readFileSync(join(dir, f), "utf8")), f, problems);

  return {
    // No translation yet is a valid state: the gate guards drift, it does not
    // demand locales that were never promised.
    ok: problems.length === 0,
    variants,
    versions: primary.versions.length,
    sections: primary.versions.reduce((n, v) => n + v.sections.length, 0),
    problems,
  };
}

if (import.meta.main) {
  const report = checkParity();
  if (report.variants === null) {
    console.error(`CHANGELOG PARITY: ${report.problems[0]}`);
    process.exit(STRICT ? 1 : 0);
  }
  if (!report.variants.length) {
    console.log("CHANGELOG PARITY: no locale variants found — nothing to compare.");
    process.exit(0);
  }

  const problems = report.problems;
  console.log(`CHANGELOG PARITY (${PRIMARY} vs ${report.variants.join(", ")})`);
  console.log(`  versions ........ ${report.versions}`);
  console.log(`  sections ........ ${report.sections}`);

  if (!problems.length) {
    console.log("  (clean — every locale matches the primary in versions, dates, sections and tables)");
    process.exit(0);
  }
  console.log(`  divergences ..... ${problems.length}`);
  console.log();
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log();
  console.log("  A translation must carry every section of the primary. Add the missing");
  console.log("  content to the locale file (translated, not copied in English).");
  process.exit(STRICT ? 1 : 0);
}
