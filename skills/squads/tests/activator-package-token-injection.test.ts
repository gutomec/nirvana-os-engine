// activator-package-token-injection.test.ts — a package name is data, not a command.
//
// `dependencies.yaml` has two kinds of field, and the activator used to run
// both the same way. `system[].install.<platform>` IS a shell line by design:
// the squad author writes `brew install ffmpeg` there, and sudo or a heavy
// download stops at a consent gate before anything runs. `node:` and `python:`
// are package LISTS — the author writes names, the reader expects names — and
// they were joined into a shell string too. So a manifest carrying
//
//     node:
//       - "left-pad; touch /tmp/pwned"
//
// executed a second command during `nrv activate`, with the user's privileges
// and no gate in front of it. The pip branch wrapped each token in single
// quotes, which only moved the door: an apostrophe inside the token closes them.
//
// The node and python paths now run an argv array with no shell, so a token can
// only ever be one argument. These tests prove the failure mode is gone by
// looking at what the package manager was actually called with, and at whether
// the injected second command left its mark on disk.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");
const POSIX = process.platform !== "win32";
type ShellPlan = { ok: true; line: string } | { ok: false; char: string; token: string };
const { _windowsShellPlan, _fetchAndExecute } = createRequire(import.meta.url)(ACTIVATOR) as {
  _windowsShellPlan: (argv: string[]) => ShellPlan;
  _fetchAndExecute: (cmd: string) => { url: string | null; shell: string; form: string } | null;
};

interface Fixture { root: string; squadDir: string; binDir: string; }

/** A squad whose only content is the dependency manifest under test. */
function fixture(deps: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "activator-injection-"));
  const squadDir = join(root, "squads", "token-squad");
  const binDir = join(root, "bin");
  mkdirSync(squadDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(squadDir, "squad.yaml"), 'name: token-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: test\n');
  writeFileSync(join(squadDir, "dependencies.yaml"), deps);
  return { root, squadDir, binDir };
}

/**
 * A stand-in package manager that installs nothing and writes down exactly how
 * it was called. One TAB-separated line per invocation is what tells a shell
 * split (`install`, `left-pad`) apart from an argv pass (`install`,
 * `left-pad; touch …`) — the whole difference this fix is about.
 */
function fakeManager(f: Fixture, name: string, log: string): void {
  const bin = join(f.binDir, name);
  writeFileSync(bin, [
    "#!/bin/sh",
    `printf 'CALL' >> ${JSON.stringify(log)}`,
    `for a in "$@"; do printf '\\t%s' "$a" >> ${JSON.stringify(log)}; done`,
    `printf '\\n' >> ${JSON.stringify(log)}`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
}

function calls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(l => l.startsWith("CALL"))
    .map(l => l.split("\t").slice(1));
}

function activate(f: Fixture, flags: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [ACTIVATOR, "activate", "token-squad", ...flags], {
    encoding: "utf8",
    env: {
      ...process.env,
      NIRVANA_SKILLS_DIR: join(REPO, "skills"),
      NIRVANA_RESOLVED_SQUAD_PATH: f.squadDir,
      NIRVANA_STATE_DIR: join(f.root, "state"),
      // Local node deps now install into the SHARED store under
      // ~/.nirvana. Point NIRVANA_HOME at the fixture so the assertion is
      // about argv and nothing touches the real store.
      NIRVANA_HOME: f.root,
      PATH: `${f.binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("a node package token cannot become a second command", () => {
  test.skipIf(!POSIX)("`;` inside a token stays inside the argument the installer receives", () => {
    const f = fixture("");
    const sentinel = join(f.root, "pwned");
    const log = join(f.root, "bun-calls.log");
    const token = `left-pad; touch ${sentinel}`;
    writeFileSync(join(f.squadDir, "dependencies.yaml"), `node:\n  - ${JSON.stringify(token)}\n`);
    // A LOCAL node dep is installed into the shared store with `bun add --cwd`,
    // so bun is the binary whose argv carries the token now. The property under
    // test is unchanged: one argument, no shell, no second command.
    fakeManager(f, "bun", log);
    try {
      const r = activate(f);
      expect(r.status).toBe(0);

      // The second command never ran: `touch` was never a command at all.
      expect(existsSync(sentinel)).toBe(false);

      // And the installer was called once, with the whole token as ONE
      // argument. Under a shell string this reads ["add", …, "left-pad"], with
      // `touch` executed separately by the shell.
      expect(calls(log)).toEqual([["add", "--cwd", join(f.root, ".nirvana"), token]]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a python package token cannot escape the quoting either", () => {
  test.skipIf(!POSIX)("an apostrophe inside a token does not open a shell", () => {
    const f = fixture("");
    const sentinel = join(f.root, "pwned-py");
    const log = join(f.root, "pip-calls.log");
    // No spaces on purpose: the pip branch strips whitespace from a token, so a
    // payload that needs spaces would be defused by accident rather than by the
    // fix. `>` redirection needs none. Under the old `'${token}'` wrapping this
    // closed the quote, ran the redirection, and created the file.
    const token = `left-pad';>${sentinel};echo'`;
    writeFileSync(join(f.squadDir, "dependencies.yaml"), `python:\n  - ${JSON.stringify(token)}\n`);
    fakeManager(f, "pip", log);
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);

      // `pip --version` is the probe that picks pip over pip3; the install is
      // the call that matters, and it carries the token whole.
      const seen = calls(log);
      expect(seen.at(-1)).toEqual(["install", "--user", token]);
      expect(seen.filter(c => c[0] === "install").length).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the plan says which fields are argv and which are a shell line", () => {
  // Runs everywhere, including Windows: --dry-run executes nothing, so this
  // asserts the shape of the decision rather than the effect of running it.
  test("node and python plan an argv; system[].install stays a shell string by design", () => {
    const nodeToken = "left-pad && echo pwned";
    const pyToken = "requests;echo";
    const f = fixture([
      "system:",
      "  - name: fake-tool-xyz",
      '    check: "command -v fake-tool-xyz"',
      "    install:",
      '      darwin: "brew install fake-tool-xyz"',
      '      linux: "apt-get install -y fake-tool-xyz"',
      '      win32: "choco install -y fake-tool-xyz"',
      "node:",
      `  - ${JSON.stringify(nodeToken)}`,
      "python:",
      "  manager: uv",
      "  packages:",
      `    - ${JSON.stringify(pyToken)}`,
      "",
    ].join("\n"));
    try {
      const r = activate(f, ["--dry-run"]);
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);

      expect(j.steps.node.argv).toEqual(["bun", "add", "--cwd", join(f.root, ".nirvana"), nodeToken]);
      expect(j.steps.python.argv).toEqual(["uv", "pip", "install", "--target", join(f.root, ".nirvana", "python"), pyToken]);

      // The system entry is the deliberate exception: the author wrote a shell
      // line, the consent gate reads it, and it keeps being one. A future
      // refactor that "fixes" this field too would break squads on purpose.
      const sys = j.steps.system[0];
      expect(sys.status).toBe("would_install");
      expect(typeof sys.cmd).toBe("string");
      expect(sys.argv).toBeUndefined();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a model url cannot become a second command either", () => {
  // The third field with the same shape: `repo`, `url`, `filename` and
  // `install_to` are data out of dependencies.yaml, and the download line used
  // to interpolate them into a shell string.
  test.skipIf(!POSIX)("`;` in a model url stays inside the argument curl receives", () => {
    const f = fixture("");
    const sentinel = join(f.root, "pwned-model");
    const log = join(f.root, "curl-calls.log");
    const url = `https://example.invalid/m.bin; touch ${sentinel}`;
    const installTo = join(f.root, "models");
    writeFileSync(join(f.squadDir, "dependencies.yaml"), [
      "models:",
      "  - name: fixture-model",
      "    source: url",
      `    url: ${JSON.stringify(url)}`,
      `    install_to: ${JSON.stringify(installTo)}`,
      "    filename: m.bin",
      "",
    ].join("\n"));
    fakeManager(f, "curl", log);
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(calls(log)).toEqual([["-L", "-o", join(installTo, "m.bin"), url]]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the Windows command line, built here instead of left to the runtime", () => {
  // The tokens below are real: they come from the dependencies.yaml files that
  // ship in the packs. libuv quotes an argument only when it holds a space, tab
  // or double quote (`quote_cmd_arg`, src/win/process.c), so the ones WITHOUT a
  // space are exactly the ones the runtime would hand to cmd.exe raw. The spawn
  // itself cannot be exercised from a POSIX runner; the line can.
  const plan = (token: string): ShellPlan => _windowsShellPlan(["npm", "install", token]);

  test("a caret range survives byte for byte", () => {
    // The correctness half of the bug, and it ships today: cmd.exe eats `^` as
    // its escape character, so an unquoted `@remotion/cli@^4.0.0` reached npm as
    // `@remotion/cli@4.0.0` — a different range, silently, with no error.
    const p = plan("@remotion/cli@^4.0.0");
    expect(p.ok).toBe(true);
    expect((p as { line: string }).line).toBe('npm "install" "@remotion/cli@^4.0.0"');
  });

  test("every metacharacter a real spec carries is quoted, not refused", () => {
    for (const token of [
      "@remotion/cli@^4.0.0",
      "remotion@^4.0.0",
      "typescript@^5.0.0",
      "requests >= 2.28",
      "pyyaml >= 6.0",
      "ccxt[async]",
      "instaloader>=4.10",
      "yt-dlp>=2024.0",
      "pandas>=2.0",
      "left-pad@1.x||2.x",
    ]) {
      const p = plan(token);
      expect(p.ok).toBe(true);
      expect((p as { line: string }).line).toBe(`npm "install" "${token}"`);
    }
  });

  test("a payload is quoted into data rather than run", () => {
    const p = plan("left-pad&calc");
    expect(p.ok).toBe(true);
    // Inside quotes cmd.exe reads `&` as a character, so npm gets one bad
    // package name and says so, instead of cmd getting a second command.
    expect((p as { line: string }).line).toBe('npm "install" "left-pad&calc"');
  });

  test("the four characters quoting cannot contain are named, one at a time", () => {
    for (const [token, char] of [
      ['left-pad"x', '"'],
      ["%PATH%", "%"],
      ["left-pad!x", "!"],
      ["left-pad\ncalc", "\n"],
    ] as const) {
      const p = plan(token);
      expect(p.ok).toBe(false);
      expect((p as { char: string }).char).toBe(char);
    }
  });

  test("only the shimmed manager takes that route", () => {
    // pip, uv, curl and huggingface-cli are real executables on Windows, so
    // their paths never build a command line at all. The difference is a
    // decision made before any spawn: only the node path passes `windowsShim`.
    const src = readFileSync(ACTIVATOR, "utf8");
    // The node path is the only one that spawns a `.cmd` shim, and after local
    // installs moved to the shared store it is the GLOBAL branch that still
    // does: `npm install -g <tool>` is the machine-level carve-out.
    expect(src).toContain("runArgv(argv, { windowsShim: true })");
    expect(src).toContain("runArgv(argv, { cwd: venv || undefined })");
    expect(src).toContain("runArgv(argv, { timeoutMs: 7200000 })");
    // And the local branch spawns bun directly, never through a shell.
    expect(src).toContain("DEPS.install(tokens)");
  });
});

describe("a repo url cannot become a second command either", () => {
  // `services[].repo` and `custom_nodes[].repo` are the last two data fields
  // that were still being interpolated into a shell line. `install_cmd`,
  // `start_cmd`, `health_check` and `post_install[]` are NOT: those are command
  // by design, written by the squad author, and they stay shell lines.
  test.skipIf(!POSIX)("both clone paths pass the repo as one argument", () => {
    const f = fixture("");
    const svcSentinel = join(f.root, "pwned-service");
    const nodeSentinel = join(f.root, "pwned-node");
    const log = join(f.root, "git-calls.log");
    const svcRepo = `https://example.invalid/s.git; touch ${svcSentinel}`;
    const nodeRepo = `https://example.invalid/n.git; touch ${nodeSentinel}`;
    const svcDir = join(f.root, "svc");
    const nodesDir = join(f.root, "nodes");
    writeFileSync(join(f.squadDir, "dependencies.yaml"), [
      "services:",
      "  - name: fixture-service",
      `    repo: ${JSON.stringify(svcRepo)}`,
      `    install_dir: ${JSON.stringify(svcDir)}`,
      "custom_nodes:",
      "  - name: fixture-node",
      `    repo: ${JSON.stringify(nodeRepo)}`,
      `    install_to: ${JSON.stringify(nodesDir)}`,
      "",
    ].join("\n"));
    fakeManager(f, "git", log);
    try {
      const r = activate(f);
      expect(r.status).toBe(0);
      expect(existsSync(svcSentinel)).toBe(false);
      expect(existsSync(nodeSentinel)).toBe(false);
      expect(calls(log)).toEqual([
        ["clone", svcRepo, svcDir],
        ["clone", nodeRepo, join(nodesDir, "fixture-node")],
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the consent gate covers fetch-and-execute, not just sudo", () => {
  // `system[].install.<platform>` is a shell line by design and stays one. What
  // changes is what gets to run without being seen: the gate matched `sudo` and
  // nothing else, so a remote script piped into a shell installed itself in
  // silence. These are the commands that ship in the packs today.
  test("the piped forms are recognized, with the url and the shell", () => {
    for (const [cmd, url, shell] of [
      ["curl -fsSL https://bun.sh/install | bash", "https://bun.sh/install", "bash"],
      ["curl -fsSL https://x.ai/cli/install.sh | bash", "https://x.ai/cli/install.sh", "bash"],
      ["curl -fsSL https://get.docker.com | sh", "https://get.docker.com", "sh"],
      ["curl -fsSL https://ollama.com/install.sh | sudo bash", "https://ollama.com/install.sh", "bash"],
      ["curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs", "https://deb.nodesource.com/setup_20.x", "bash"],
      ["wget -qO- https://example.invalid/i.sh | sh", "https://example.invalid/i.sh", "sh"],
      ["bash <(curl -fsSL https://example.invalid/i.sh)", "https://example.invalid/i.sh", "bash"],
      ['sh -c "$(curl -fsSL https://example.invalid/i.sh)"', "https://example.invalid/i.sh", "sh"],
      ['eval "$(curl -fsSL https://example.invalid/i.sh)"', "https://example.invalid/i.sh", "eval"],
      ['powershell -c "irm https://bun.sh/install.ps1 | iex"', "https://bun.sh/install.ps1", "iex"],
      ["Invoke-WebRequest https://example.invalid/i.ps1 | Invoke-Expression", "https://example.invalid/i.ps1", "Invoke-Expression"],
    ] as const) {
      expect(_fetchAndExecute(cmd)).toEqual({ url, shell, form: "direct" });
    }
  });

  test("a pipe with no scheme in the url is still a pipe", () => {
    // Shipped verbatim in the packs. There is nothing to name as the url, and
    // the message says "a remote address" rather than inventing one.
    expect(_fetchAndExecute('powershell -c "irm bun.sh/install.ps1 | iex"'))
      .toEqual({ url: null, shell: "iex", form: "direct" });
  });

  test("the two-step form is recognized too, and says it is a guess", () => {
    // Download an installer, then run it. No pipe, no substitution — the links
    // are `&&`. This is `ebook-maestro-nirvana`, verbatim, shipped today in
    // genesis-circle and publishing-knowledge, and it is the commonest shape of
    // the same risk. It also exercises the worst realistic case: a glob, a
    // `printf` with a redirection, embedded XML with quotes, and `$HOME`.
    const verapdf = `curl -fsSL https://software.verapdf.org/rel/verapdf-installer.zip -o /tmp/verapdf.zip && unzip -oq /tmp/verapdf.zip -d /tmp/verapdf && printf '<?xml version="1.0"?><AutomatedInstallation langpack="eng"><com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/><com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>$HOME/verapdf</installpath></com.izforge.izpack.panels.target.TargetPanel><com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select"><pack index="0" name="veraPDF GUI" selected="true"/><pack index="1" name="veraPDF Sample Corpus" selected="false"/><pack index="2" name="veraPDF Documentation" selected="false"/></com.izforge.izpack.panels.packs.PacksPanel><com.izforge.izpack.panels.install.InstallPanel id="install"/><com.izforge.izpack.panels.finish.FinishPanel id="finish"/></AutomatedInstallation>' > /tmp/verapdf/auto.xml && sh /tmp/verapdf/verapdf-greenfield-*/verapdf-install /tmp/verapdf/auto.xml && mkdir -p $HOME/.local/bin && ln -sf $HOME/verapdf/verapdf $HOME/.local/bin/verapdf`;
    expect(_fetchAndExecute(verapdf)).toEqual({
      url: "https://software.verapdf.org/rel/verapdf-installer.zip",
      shell: "sh",
      form: "two_stage",
    });
  });

  test("downloading is not executing, and an ordinary install is not either", () => {
    // A gate that fires on `brew install` is a gate everyone passes with
    // --confirm-heavy without reading it, which is worse than no gate. The two
    // `curl` ones are the trap in the adversarial pass: the word appears, and
    // nothing remote runs.
    for (const cmd of [
      "curl -L -o modelo.bin https://huggingface.co/org/model/resolve/main/model.bin",
      "curl -fsSL https://example.invalid/a.tgz | tar -xz -C /usr/local",
      "brew install curl",
      "sudo apt install -y curl",
      "brew install ffmpeg",
      "apt-get install -y ffmpeg",
      "sudo apt install -y ffmpeg",
      "winget install --id Gyan.FFmpeg -e",
      "git clone https://example.invalid/r.git",
      // The anchor doing its job: a path that ends in `sh` is not an invocation.
      "curl -fsSL https://example.invalid/a.zip -o /tmp/sh/a.zip",
    ]) {
      expect(_fetchAndExecute(cmd)).toBeNull();
    }
  });

  test("a piped installer stops at exit 2 and the reason names the url and the shell", () => {
    const f = fixture([
      "system:",
      "  - name: bun",
      '    check: "command -v definitely-not-installed-xyz"',
      "    install:",
      '      darwin: "curl -fsSL https://bun.sh/install | bash"',
      '      linux: "curl -fsSL https://bun.sh/install | bash"',
      `      win32: ${JSON.stringify('powershell -c "irm https://bun.sh/install.ps1 | iex"')}`,
      "",
    ].join("\n"));
    // Belt and braces: the command is the real one, and a stand-in `curl` in
    // front of it on PATH means that if the gate ever regresses, the test
    // fails without fetching anything. (Proven: run this against the ungated
    // activator and it reaches the network.)
    fakeManager(f, "curl", join(f.root, "curl-calls.log"));
    try {
      const r = activate(f);
      expect(r.status).toBe(2);
      const j = JSON.parse(r.stdout);
      expect(j.confirmations_required.length).toBe(1);
      const item = j.confirmations_required[0];
      expect(item.fetches).toContain("bun.sh");
      expect(item.executes_with).toMatch(/bash|iex/);
      expect(item.needs_sudo).toBe(false);
      // The command itself is in the message: it is what the buyer decides on.
      expect(item.reason).toContain("bun.sh");
      expect(item.reason).toContain("--confirm-heavy");
      expect(item.reason).toContain(item.cmd);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("the two-step form reaches the buyer as a two-step form, not as a pipe", () => {
    // What the buyer sees is the point of this change: the message has to say
    // which signal fired, because a fetch-then-run is a strong reading of the
    // command and a pipe is a reading of nothing.
    const install = "curl -fsSL https://example.invalid/i.zip -o /tmp/i.zip && unzip -oq /tmp/i.zip -d /tmp/i && sh /tmp/i/install";
    const f = fixture([
      "system:",
      "  - name: two-step",
      '    check: "command -v definitely-not-installed-xyz"',
      "    install:",
      `      darwin: ${JSON.stringify(install)}`,
      `      linux: ${JSON.stringify(install)}`,
      `      win32: ${JSON.stringify(install)}`,
      "",
    ].join("\n"));
    fakeManager(f, "curl", join(f.root, "curl-calls.log"));
    try {
      const r = activate(f);
      expect(r.status).toBe(2);
      const item = JSON.parse(r.stdout).confirmations_required[0];
      expect(item.execution_form).toBe("two_stage");
      expect(item.fetches).toBe("https://example.invalid/i.zip");
      expect(item.executes_with).toBe("sh");
      expect(item.reason).toContain("two steps rather than a pipe");
      expect(item.reason).toContain(install);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--confirm-heavy still lets it through, and an ordinary install never stops", () => {
    const f = fixture([
      "system:",
      "  - name: ffmpeg",
      '    check: "command -v definitely-not-installed-xyz"',
      "    install:",
      '      darwin: "brew install ffmpeg"',
      '      linux: "brew install ffmpeg"',
      '      win32: "brew install ffmpeg"',
      "",
    ].join("\n"));
    // A stand-in `brew` so the negative case can run the install instead of
    // asserting around it. Nothing is confirmed, so the command executes.
    fakeManager(f, "brew", join(f.root, "brew-calls.log"));
    try {
      const r = activate(f);
      const j = JSON.parse(r.stdout);
      expect(j.confirmations_required.length).toBe(0);
      expect(j.steps.system[0].status).not.toBe("confirmation_required");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});
