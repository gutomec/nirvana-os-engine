// Who owns an entry in a runtime's skills directory — the one answer the
// installer, the uninstaller and the doctor all give (runtime-install.ts).
//
// The two cases that matter are the invisible ones: a DANGLING link of ours
// (target already deleted, existsSync says "nothing here") and a foreign entry
// that is the SAME skill placed by skills.sh (a real dir in .agents/skills plus
// relative symlinks elsewhere), which must never be parked as a backup.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyRuntimeEntry, foreignProvider, skillFrontmatterName } from "../lib/runtime-install.ts";
import { COPY_MARKER } from "../lib/runtime-dirs.ts";

const IS_WINDOWS = process.platform === "win32";
let root: string;
let canonical: string;   // stands in for ~/.nirvana/skills

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-own-")));
  canonical = path.join(root, "nirvana", "skills");
  fs.mkdirSync(path.join(canonical, "nirvana"), { recursive: true });
  fs.writeFileSync(path.join(canonical, "nirvana", "SKILL.md"), "---\nname: nirvana\n---\n");
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

test("nothing there is absent", () => {
  expect(classifyRuntimeEntry(path.join(root, "nope"), [canonical])).toBe("absent");
});

test("our symlink is ours, live or dangling", () => {
  if (IS_WINDOWS) return; // directory symlinks need admin on the CI runner
  const live = path.join(root, "rt-live", "nirvana");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.symlinkSync(path.join(canonical, "nirvana"), live);
  expect(classifyRuntimeEntry(live, [canonical])).toBe("ours");

  const dangling = path.join(root, "rt-dangling", "nirvana-os");
  fs.mkdirSync(path.dirname(dangling), { recursive: true });
  fs.symlinkSync(path.join(canonical, "nirvana-os"), dangling);   // target never existed
  expect(fs.existsSync(dangling)).toBe(false);                     // what existsSync sees
  expect(classifyRuntimeEntry(dangling, [canonical])).toBe("ours"); // what the installer must see
  expect(foreignProvider(dangling, "nirvana-os", canonical)).toBe(false);
});

test("a copy carrying the marker is ours; a plain foreign dir is not", () => {
  const copy = path.join(root, "rt-copy", "harness");
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, COPY_MARKER), "copy");
  expect(classifyRuntimeEntry(copy, [canonical])).toBe("ours");
  expect(foreignProvider(copy, "harness", canonical)).toBe(false);

  const foreign = path.join(root, "rt-foreign", "harness");
  fs.mkdirSync(foreign, { recursive: true });
  expect(classifyRuntimeEntry(foreign, [canonical])).toBe("foreign");
  expect(foreignProvider(foreign, "harness", canonical)).toBe(false); // no SKILL.md, no name
});

test("the skills.sh layout is a foreign provider: real dir, and relative links to it", () => {
  const agents = path.join(root, "home", ".agents", "skills", "nirvana");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "SKILL.md"), "---\nname: nirvana\n---\n");
  expect(classifyRuntimeEntry(agents, [canonical])).toBe("foreign");
  expect(foreignProvider(agents, "nirvana", canonical)).toBe(true);
  expect(foreignProvider(agents, "harness", canonical)).toBe(false);   // name must match

  if (IS_WINDOWS) return;
  const claude = path.join(root, "home", ".claude", "skills", "nirvana");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.symlinkSync(path.join("..", "..", ".agents", "skills", "nirvana"), claude);
  expect(classifyRuntimeEntry(claude, [canonical])).toBe("foreign");
  expect(foreignProvider(claude, "nirvana", canonical)).toBe(true);
  // ...but not when the legacy root it resolves under is declared ours.
  expect(classifyRuntimeEntry(claude, [canonical, path.join(root, "home", ".agents", "skills")])).toBe("ours");
});

test("a foreign dir with another declared name is not a provider of this one", () => {
  const other = path.join(root, "rt-other", "nirvana");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "SKILL.md"), "---\nname: something-else\n---\n");
  expect(foreignProvider(other, "nirvana", canonical)).toBe(false);
});

test("skillFrontmatterName reads the declared name, quotes stripped, and null otherwise", () => {
  const d = path.join(root, "fm");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), '---\nname: "quoted-name"\ndescription: x\n---\nbody\n');
  expect(skillFrontmatterName(d)).toBe("quoted-name");
  fs.writeFileSync(path.join(d, "SKILL.md"), "# no frontmatter\nname: not-this\n");
  expect(skillFrontmatterName(d)).toBeNull();
  expect(skillFrontmatterName(path.join(root, "absent"))).toBeNull();
});
