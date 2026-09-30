// squads-preferred-and-dna-config.test.ts — two fields that used to have no reader.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preferredSquads } from "../lib/employee-prompt.ts";
import { renderCloneCard } from "../../_shared/lib/clone-resolver.ts";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-fields-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("squads_preferred", () => {
  test("reads the business's preferred squads", () => {
    const biz = tmp();
    fs.writeFileSync(path.join(biz, "business.yaml"), "name: x\nsquads_preferred:\n  - brandcraft\n  - copy-lab\n");
    expect(preferredSquads(biz)).toEqual(["brandcraft", "copy-lab"]);
  });
  test("absent, malformed or missing means no preference", () => {
    const biz = tmp();
    fs.writeFileSync(path.join(biz, "business.yaml"), "name: x\n");
    expect(preferredSquads(biz)).toEqual([]);
    expect(preferredSquads(path.join(biz, "nope"))).toEqual([]);
    expect(preferredSquads(null)).toEqual([]);
  });
});

describe("DNA reference card", () => {
  test("points at the clone's DNA-CONFIG.yaml beside its persona files", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "agent"));
    const agent = path.join(dir, "agent", "AGENT.md");
    const config = path.join(dir, "agent", "DNA-CONFIG.yaml");
    fs.writeFileSync(agent, "# agent");
    fs.writeFileSync(config, "dna_config: {}");
    const card = renderCloneCard("x", { display_name: "X" }, dir, { agent, soul: null, dna_schema: null });
    expect(card).toContain(agent);
    expect(card).toContain(config);
  });
  test("a clone without one is unchanged", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "agent"));
    const agent = path.join(dir, "agent", "AGENT.md");
    fs.writeFileSync(agent, "# agent");
    expect(renderCloneCard("x", {}, dir, { agent, soul: null, dna_schema: null })).not.toContain("DNA-CONFIG");
  });
});
