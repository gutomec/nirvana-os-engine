// changelog-parity.test.ts — the gate that keeps localized changelogs together.
//
// A gate that only ever reports "clean" is worthless, so every test here injects
// a specific drift and asserts the gate catches it. The first one reproduces the
// drift that actually happened: entries written only in the primary language,
// leaving international readers with the old history and not the recent one.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkParity, parseChangelog } from "../../../scripts/check-changelog-parity.ts";

const HEADER = "**Read this in your language:** [English](./CHANGELOG.md) · [Português](./CHANGELOG.pt-BR.md)";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-changelog-parity-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** Build a fixture repo with a primary and (optionally) a locale variant. */
function fixture(primary: string, translation?: string): string {
  const dir = path.join(TMP, `case-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), primary);
  if (translation !== undefined) fs.writeFileSync(path.join(dir, "CHANGELOG.pt-BR.md"), translation);
  return dir;
}

const EN = `# Changelog

${HEADER}

## Unreleased

### A fix

Body.

## 0.2.0 — 2026-08-07

### Exit codes

| exit | meaning |
|------|---------|
| 0 | delivered |
| 1 | failed |

### Routing

Body.
`;

const PT = `# Changelog

${HEADER}

## Não lançado

### Uma correção

Corpo.

## 0.2.0 — 2026-08-07

### Exit codes

| exit | significado |
|------|-------------|
| 0 | entregue |
| 1 | falhou |

### Roteamento

Corpo.
`;

describe("parity holds", () => {
  test("a faithful translation passes", () => {
    const r = checkParity(fixture(EN, PT));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.versions).toBe(2);
    expect(r.sections).toBe(3);
  });

  test("the unreleased heading matches by POSITION, so any language works", () => {
    // No allowlist of translated words: a Chinese locale must pass untaught.
    const zh = PT.replace("## Não lançado", "## 未发布");
    expect(checkParity(fixture(EN, zh)).problems).toEqual([]);
  });

  test("no locale variant at all is a valid state, not a failure", () => {
    const r = checkParity(fixture(EN));
    expect(r.variants).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("parity breaks", () => {
  test("THE regression: a whole version missing from the translation", () => {
    const missing = PT.replace(/## 0\.2\.0[\s\S]*$/, "");
    const r = checkParity(fixture(EN, missing));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("version 0.2.0 is in CHANGELOG.md but missing here");
  });

  test("a section written only in the primary", () => {
    const oneShort = PT.replace(/### Roteamento\n\nCorpo\.\n/, "");
    const r = checkParity(fixture(EN, oneShort));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("has 1 section(s), CHANGELOG.md has 2");
  });

  test("a section that exists only in the translation", () => {
    const oneExtra = PT + "\n### Extra\n\nCorpo.\n";
    expect(checkParity(fixture(EN, oneExtra)).ok).toBe(false);
  });

  test("a dropped table — the loss a section count alone would miss", () => {
    // Same headings, same section count; only the exit-code rows are gone.
    const noTable = PT.replace(/\|.*\n/g, "");
    const r = checkParity(fixture(EN, noTable));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("table row(s)");
  });

  test("a release dated differently in each file", () => {
    const wrongDate = PT.replace("2026-08-07", "2026-08-09");
    const r = checkParity(fixture(EN, wrongDate));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("dated 2026-08-09");
  });

  test("versions listed out of order", () => {
    const en2 = EN + "\n## 0.1.9 — 2026-07-01\n\n### Old\n\nBody.\n";
    // Same versions, wrong order: 0.1.9 before 0.2.0.
    const pt2 = PT.replace("## 0.2.0 — 2026-08-07", "## 0.1.9 — 2026-07-01\n\n### Antigo\n\nCorpo.\n\n## 0.2.0 — 2026-08-07");
    const r = checkParity(fixture(en2, pt2));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("different ORDER");
  });

  test("a missing locale header", () => {
    const r = checkParity(fixture(EN, PT.replace(HEADER, "")));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("locale header");
  });

  test("an absent primary is reported, not crashed on", () => {
    const dir = path.join(TMP, "no-primary");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CHANGELOG.pt-BR.md"), PT);
    const r = checkParity(dir);
    expect(r.variants).toBeNull();
    expect(r.problems[0]).toContain("not found");
  });
});

describe("parsing", () => {
  test("a `##` inside a fenced block is sample output, not a version", () => {
    const withFence = EN.replace("Body.", "Body.\n\n```\n## 9.9.9 — not a release\n```\n");
    expect(parseChangelog(withFence).versions.map(v => v.key)).toEqual(["unversioned#0", "0.2.0"]);
  });

  test("table rows before any section still count, via a preamble slot", () => {
    const preamble = `# Changelog\n\n${HEADER}\n\n## 0.1.0 — 2026-01-01\n\n| a | b |\n|---|---|\n`;
    const v = parseChangelog(preamble).versions[0];
    expect(v.sections[0].heading).toBe("(preamble)");
    expect(v.sections[0].tableRows).toBe(2);
  });
});
