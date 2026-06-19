#!/usr/bin/env bun
// ask.ts — interactive REPL with a Nirvana mind-clone.
//
// Loads the canonical DNA of a mind-clone and creates a prompt that the user
// can copy into Claude Code / Codex / Gemini, OR pipes through a runtime if
// stdin is a TTY.
//
// Two modes:
//   1. nrv ask <clone-slug>                 # interactive (prints DNA-loaded prompt + opens chat hint)
//   2. nrv ask <clone-slug> "<question>"    # one-shot (returns the persona's expected angle)
//
// The "interactive" version writes the DNA prompt to a file the user can pipe
// into any runtime. We don't actually shell out to claude-code etc. because
// each runtime has its own session model — but we make it 1 copy-paste away.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  lime: "\x1b[38;5;154m", red: "\x1b[31m", magenta: "\x1b[35m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const slug = positional[0];
const question = positional.slice(1).join(" ");
const writeFile = !process.argv.includes("--stdout");

if (!slug) {
  console.error("Uso: nrv ask <clone-slug> [question]");
  console.error("");
  console.error("  --stdout       Print prompt to stdout instead of writing file");
  console.error("");
  console.error("Exemplos:");
  console.error("  nrv ask naval-ravikant");
  console.error("  nrv ask rory-sutherland \"Critique this headline: ...\"");
  console.error("  nrv ask ray-dalio \"Should I bootstrap or raise?\"");
  console.error("");
  console.error("Para listar clones disponíveis: nrv list-clones");
  process.exit(2);
}

// Resolve the mind-clone in the library
const dnaLib = path.join(os.homedir(), "businesses/_library/dna");
if (!fs.existsSync(dnaLib)) {
  console.error(c("red", `ERRO: DNA library não encontrada em ${dnaLib}`));
  console.error("Rode `nrv install --bootstrap --starter` primeiro.");
  process.exit(1);
}

// Walk categories to find the slug
let cloneDir: string | null = null;
let category = "";
for (const cat of fs.readdirSync(dnaLib)) {
  const catPath = path.join(dnaLib, cat);
  if (!fs.statSync(catPath).isDirectory()) continue;
  for (const c of fs.readdirSync(catPath)) {
    if (c === slug) {
      cloneDir = path.join(catPath, c);
      category = cat;
      break;
    }
  }
  if (cloneDir) break;
}

if (!cloneDir) {
  console.error(c("red", `Clone '${slug}' não encontrado em ${dnaLib}`));
  console.error("Para listar: `nrv list-clones`");
  process.exit(1);
}

// Load the DNA (prefer LEGACY-SIMPLIFIED.md → AGENT.md → MANIFEST.yaml)
const candidates = [
  path.join(cloneDir, "LEGACY-SIMPLIFIED.md"),
  path.join(cloneDir, "agent/AGENT.md"),
  path.join(cloneDir, "MANIFEST.yaml"),
];
let dnaContent = "";
let dnaSource = "";
for (const cand of candidates) {
  if (fs.existsSync(cand)) {
    dnaContent = fs.readFileSync(cand, "utf8");
    dnaSource = cand;
    break;
  }
}
if (!dnaContent) {
  console.error(c("red", `Clone ${slug} sem LEGACY-SIMPLIFIED.md ou AGENT.md ou MANIFEST.yaml`));
  process.exit(1);
}

// Manifest (optional but useful for display)
let displayName = slug;
const manifestPath = path.join(cloneDir, "MANIFEST.yaml");
if (fs.existsSync(manifestPath)) {
  const m = fs.readFileSync(manifestPath, "utf8");
  const dn = m.match(/^\s*display_name:\s*["']?([^"'\n]+)/m);
  if (dn) displayName = dn[1].trim();
}

const promptHeader = `# Channeling: ${displayName}

You are now operating as **${displayName}** (${slug}), from the Nirvana mind-clone library
under category "${category}".

The full DNA below is your voice, frameworks, heuristics, vocabulary, and limitations.
Stay in character. If asked something outside your declared expertise, name it and decline
gracefully — don't fabricate.

---

## CANONICAL DNA (source: ${path.relative(os.homedir(), dnaSource)})

${dnaContent}

---

## CURRENT REQUEST

${question || "(no question provided yet — wait for the user's next message)"}

`;

if (question && !writeFile) {
  // one-shot mode to stdout
  console.log(promptHeader);
  process.exit(0);
}

// Interactive mode: write prompt to a temp file and tell the user how to use it
const tmpDir = path.join(os.tmpdir(), "nirvana-ask");
fs.mkdirSync(tmpDir, { recursive: true });
const promptFile = path.join(tmpDir, `${slug}-${Date.now()}.md`);
fs.writeFileSync(promptFile, promptHeader);

// Emit audit event
try {
  const today = new Date().toISOString().slice(0, 10);
  const globalDir = path.join(harnessLogsDir(), today);
  fs.mkdirSync(globalDir, { recursive: true });
  fs.appendFileSync(path.join(globalDir, "audit.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    event: "ask_invoked",
    clone_slug: slug,
    category,
    has_question: !!question,
    prompt_size: promptHeader.length,
  }) + "\n");
} catch {}

console.log("");
console.log(c("lime", "▶ ") + c("bold", `Channeling ${displayName}`));
console.log(c("dim", `  category: ${category} · source: ${path.relative(os.homedir(), dnaSource)}`));
console.log(c("dim", `  prompt: ${promptHeader.length.toLocaleString()} chars · written to ${promptFile}`));
console.log("");
console.log(c("cyan", "  Copie e cole no seu runtime:"));
console.log("");
console.log("    " + c("yellow", `cat ${promptFile} | pbcopy   # macOS`));
console.log("    " + c("yellow", `cat ${promptFile} | xclip    # Linux`));
console.log("    " + c("yellow", `claude < ${promptFile}        # claude-code stdin`));
console.log("    " + c("yellow", `codex exec "$(cat ${promptFile})"`));
console.log("");
if (!question) {
  console.log(c("cyan", "  Ou rode em modo one-shot:"));
  console.log("    " + c("yellow", `nrv ask ${slug} "sua pergunta aqui"`));
}
console.log("");

process.exit(0);
