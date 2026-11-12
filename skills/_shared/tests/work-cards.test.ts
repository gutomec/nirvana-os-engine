// work-cards.test.ts — the squad card a solo worker reads: compiled from the
// manifest and the frontmatter only, one line per part with the file to open,
// v6 Markdown and v5 YAML workflows alike, and small next to the squad itself.
// Runs with: bun test skills/_shared/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { squadWorkCard, writeSquadCards } from "../lib/work-cards.ts";

let tmp: string;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};

function makeSquad(dir: string): void {
  write(path.join(dir, "squad.yaml"), [
    "name: demo-squad",
    'version: "1.2.0"',
    'description: "Builds landing pages that convert, from brief to deployed HTML."',
    "capabilities:",
    "  - id: marketing.landing.build",
    '    description: "Build a landing page from a brief."',
    "    invoke: { type: workflow, ref: workflows/build-landing }",
    "    produces: [landing-page]",
    "    acceptance:",
    "      - { id: hero_states_offer, description: x, blocking: true }",
    "      - { id: mobile_ok, description: y }",
  ].join("\n"));
  write(path.join(dir, "agents", "copywriter.md"), '---\nname: copywriter\ndescription: "Writes the copy. Use when a page needs words."\n---\n\nA very long persona body that the card must never carry.\n'.repeat(1));
  write(path.join(dir, "tasks", "write-hero.md"), '---\nname: write-hero\ndescription: "The hero section that states the offer"\n---\n# body\n');
  write(path.join(dir, "workflows", "build-landing.md"), [
    "---",
    "name: build-landing",
    'description: "From brief to page"',
    "steps:",
    "  - { id: write-hero, agent: copywriter, task: write-hero }",
    "  - { id: assemble, agent: builder, task: assemble, requires: [write-hero] }",
    "---",
    "## write-hero",
    "prose",
  ].join("\n"));
  write(path.join(dir, "workflows", "legacy.yaml"), "name: legacy\ndescription: v5 workflow\nsteps:\n  - { id: one, agent: copywriter }\n");
}

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cards-"))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("squadWorkCard", () => {
  test("no manifest, no card", () => {
    expect(squadWorkCard("nope", path.join(tmp, "nope"))).toBeNull();
  });

  test("capabilities, agents, tasks and workflows, each line pointing at its file", () => {
    const dir = path.join(tmp, "demo-squad");
    makeSquad(dir);
    const card = squadWorkCard("demo-squad", dir)!;
    expect(card).toContain("# Squad card: demo-squad v1.2.0");
    expect(card).toContain("`marketing.landing.build`: Build a landing page from a brief. Runs workflow `workflows/build-landing`. Produces: landing-page. Acceptance: hero_states_offer*, mobile_ok (* blocking).");
    expect(card).toContain("- `copywriter`: Writes the copy. Use when a page needs words. → `agents/copywriter.md`");
    expect(card).toContain("- `write-hero`: The hero section that states the offer → `tasks/write-hero.md`");
    expect(card).toContain("Steps: write-hero (copywriter) → assemble (builder) → `workflows/build-landing.md`");
    expect(card).toContain("- `legacy`: v5 workflow. Steps: one (copywriter) → `workflows/legacy.yaml`");
    expect(card).toContain("Do not dispatch the squad; you are running it.");
  });

  test("the card carries frontmatter, never the bodies", () => {
    const dir = path.join(tmp, "demo-squad");
    makeSquad(dir);
    write(path.join(dir, "agents", "builder.md"), `---\nname: builder\ndescription: "Assembles"\n---\n${"persona line\n".repeat(5000)}`);
    const card = squadWorkCard("demo-squad", dir)!;
    expect(card).not.toContain("persona line");
    expect(card).not.toContain("A very long persona body");
    expect(card.length).toBeLessThan(3000);
  });

  test("writeSquadCards writes one file per squad that has a manifest", () => {
    const dir = path.join(tmp, "lib", "demo-squad");
    makeSquad(dir);
    const out = writeSquadCards(path.join(tmp, "cards"), ["demo-squad", "missing", "demo-squad"], (s) => path.join(tmp, "lib", s));
    expect(Object.keys(out)).toEqual(["demo-squad"]);
    expect(fs.readFileSync(out["demo-squad"], "utf8")).toContain("# Squad card: demo-squad");
  });
});
