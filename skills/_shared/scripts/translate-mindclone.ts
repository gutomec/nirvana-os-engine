#!/usr/bin/env bun
/**
 * translate-mindclone.ts — translate a mind-clone DNA into a target locale
 * via the host agent runtime. Cached as `<slug>.<locale>.md` next to the
 * canonical file. Skips work when the cache is up-to-date (matched via
 * `source_hash` in the translated frontmatter).
 *
 * Usage:
 *   bun translate-mindclone.ts <category>/<slug> --to en
 *   bun translate-mindclone.ts --all --to en
 *   bun translate-mindclone.ts <category>/<slug> --to en --force
 *
 * Auth: relies on the host runtime (Claude Code, Codex, Gemini CLI, …).
 * No model or agent is specified — we use the host's defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { paths, parseArgs, EXIT } from "../lib/bun-helpers.ts";

const driver = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "host-agent-driver.ts"));

const { positional, flags } = parseArgs();
const TARGET = String(flags.to || "").trim();
const ALL = !!flags.all;
const FORCE = !!flags.force;
const DRY_RUN = !!flags["dry-run"];
const CONCURRENCY = Math.max(1, Math.min(16, parseInt(String(flags.concurrency || "1"), 10) || 1));
const PROGRESS_FILE = String(flags["progress-file"] || "").trim();

if (!TARGET || (!ALL && !positional[0])) {
  console.error("usage: translate-mindclone <category>/<slug> --to <locale>  [--force] [--dry-run]");
  console.error("       translate-mindclone --all --to <locale> [--concurrency N] [--progress-file <path>]");
  process.exit(EXIT.INVALID_ARGS);
}

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
if (!LOCALE_RE.test(TARGET)) {
  console.error(`invalid --to locale: '${TARGET}' (expected BCP-47 like "en", "pt-BR", "es-MX")`);
  process.exit(EXIT.INVALID_ARGS);
}

const DNA_LIBRARY = paths.DNA_LIBRARY || path.join(paths.BUSINESSES_LIBRARY, "dna");
if (!fs.existsSync(DNA_LIBRARY)) {
  console.error(`DNA library missing: ${DNA_LIBRARY}`);
  process.exit(EXIT.FAILURES);
}

interface Target { category: string; slug: string; canonical: string; translated: string; }

function collectTargets(): Target[] {
  if (ALL) {
    const out: Target[] = [];
    // Resolve symlinks (subdirs may be symlinked from a different volume).
    const catNames = fs.readdirSync(DNA_LIBRARY);
    for (const name of catNames) {
      const catPath = path.join(DNA_LIBRARY, name);
      let st: fs.Stats;
      try { st = fs.statSync(catPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      let entries: string[];
      try { entries = fs.readdirSync(catPath); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".md")) continue;
        if (/\.[a-z]{2}(-[A-Z]{2})?\.md$/.test(f)) continue;  // skip translations
        const slug = f.replace(/\.md$/, "");
        out.push({
          category: name, slug,
          canonical: path.join(catPath, `${slug}.md`),
          translated: path.join(catPath, `${slug}.${TARGET}.md`),
        });
      }
    }
    return out;
  }

  const ref = positional[0];
  if (!ref.includes("/")) {
    console.error("expected '<category>/<slug>'; e.g. '01-marketing-copy-vendas/alex-hormozi'");
    process.exit(EXIT.INVALID_ARGS);
  }
  const [category, slug] = ref.split("/", 2);
  return [{
    category, slug,
    canonical: path.join(DNA_LIBRARY, category, `${slug}.md`),
    translated: path.join(DNA_LIBRARY, category, `${slug}.${TARGET}.md`),
  }];
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function frontmatterOf(text: string): { frontmatter: string | null; body: string } {
  const m = text.match(/^---\n([\s\S]+?)\n---\n?/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

function readSourceHash(translated: string): string | null {
  if (!fs.existsSync(translated)) return null;
  const raw = fs.readFileSync(translated, "utf8");
  const { frontmatter } = frontmatterOf(raw);
  if (!frontmatter) return null;
  const m = frontmatter.match(/^\s*source_hash\s*:\s*["']?([a-f0-9]+)["']?\s*$/m);
  return m ? m[1] : null;
}

function buildPersona(): string {
  return [
    "You are a senior bilingual translator specialized in business, marketing, copywriting,",
    "and engineering domains. Your job: translate Portuguese (Brazil) mind-clone DNA",
    "documents into the target locale while preserving:",
    "  - Voice, tone, register, and rhetorical force of the original.",
    "  - First-person and third-person persona patterns exactly as written.",
    "  - YAML frontmatter structure (translate string values, never rename keys).",
    "  - Markdown structure: headings, lists, tables, code blocks, emphasis.",
    "  - Domain-specific jargon — keep canonical English terms (CRO, CAC, LTV,",
    "    Grand Slam Offer, etc.) as-is even when they have no Portuguese gloss.",
    "  - Quotes, citations, and proper nouns: do NOT translate names of people,",
    "    products, or registered trademarks.",
    "Output ONLY the translated document — no commentary, no preamble, no markdown",
    "code fences wrapping the whole thing.",
  ].join("\n");
}

function buildUserMessage(canonicalText: string, targetLocale: string, slug: string): string {
  return [
    `Translate the following mind-clone DNA from Portuguese (Brazil) to ${targetLocale}.`,
    `Slug: ${slug}`,
    "",
    "Preserve every section and the YAML frontmatter. Translate ONLY natural-language",
    "values; keep keys, codes, and proper nouns intact. Output the full translated",
    "document, frontmatter included.",
    "",
    "── BEGIN SOURCE ──",
    canonicalText,
    "── END SOURCE ──",
  ].join("\n");
}

function injectFrontmatterMeta(translated: string, sourceHash: string, targetLocale: string): string {
  const { frontmatter, body } = frontmatterOf(translated);
  const stamp = new Date().toISOString();
  if (frontmatter) {
    // Strip any prior translation_meta keys we control, then re-inject.
    let cleaned = frontmatter
      .replace(/^\s*source_hash\s*:.*$/gm, "")
      .replace(/^\s*source_locale\s*:.*$/gm, "")
      .replace(/^\s*target_locale\s*:.*$/gm, "")
      .replace(/^\s*translated_at\s*:.*$/gm, "")
      .replace(/\n{2,}/g, "\n")
      .trimEnd();
    cleaned += [
      ``,
      `source_hash: "${sourceHash}"`,
      `source_locale: "pt-BR"`,
      `target_locale: "${targetLocale}"`,
      `translated_at: "${stamp}"`,
    ].join("\n");
    return `---\n${cleaned}\n---\n${body}`;
  }
  // No frontmatter in translated output — synthesize one.
  return [
    "---",
    `source_hash: "${sourceHash}"`,
    `source_locale: "pt-BR"`,
    `target_locale: "${targetLocale}"`,
    `translated_at: "${stamp}"`,
    "---",
    "",
    body,
  ].join("\n");
}

async function translateOne(t: Target): Promise<{ slug: string; status: string; reason?: string }> {
  if (!fs.existsSync(t.canonical)) {
    return { slug: `${t.category}/${t.slug}`, status: "skipped", reason: "canonical missing" };
  }
  const canonical = fs.readFileSync(t.canonical, "utf8");
  const hash = sha256(canonical);
  const cachedHash = readSourceHash(t.translated);
  if (!FORCE && cachedHash === hash) {
    return { slug: `${t.category}/${t.slug}`, status: "cached" };
  }
  if (DRY_RUN) {
    return { slug: `${t.category}/${t.slug}`, status: "dry-run" };
  }
  const host = driver.detectHost?.();
  if (!host) {
    return { slug: `${t.category}/${t.slug}`, status: "no-host", reason: "no host runtime detected (claude/codex/gemini)" };
  }
  const r = await driver.callHostAgentAsync(buildPersona(), buildUserMessage(canonical, TARGET, t.slug), { timeoutMs: 240_000 });
  if ("error" in r) {
    return { slug: `${t.category}/${t.slug}`, status: "error", reason: r.error.slice(0, 200) };
  }
  const translatedText = r.text.trim();
  if (translatedText.length < 200) {
    return { slug: `${t.category}/${t.slug}`, status: "error", reason: `translation suspiciously short (${translatedText.length} chars)` };
  }
  const finalText = injectFrontmatterMeta(translatedText, hash, TARGET);
  fs.writeFileSync(t.translated, finalText, "utf8");
  return { slug: `${t.category}/${t.slug}`, status: "translated" };
}

function logProgress(line: string) {
  process.stderr.write(line);
  if (PROGRESS_FILE) {
    try { fs.appendFileSync(PROGRESS_FILE, line); } catch {}
  }
}

async function main() {
  const targets = collectTargets();
  const startedAt = Date.now();
  const summary = `[translate-mindclone] target=${TARGET} · ${targets.length} mind-clone(s) · concurrency=${CONCURRENCY}${FORCE ? " · FORCE" : ""}${DRY_RUN ? " · DRY-RUN" : ""}\n`;
  if (PROGRESS_FILE) {
    fs.writeFileSync(PROGRESS_FILE, `# translate-mindclone started ${new Date().toISOString()}\n${summary}`);
  }
  console.error(summary.trimEnd());

  let translated = 0, cached = 0, skipped = 0, errors = 0;
  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= targets.length) return;
      const t = targets[i];
      const r = await translateOne(t);
      completed++;
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const line = `[${String(completed).padStart(3)}/${targets.length}] ${t.category}/${t.slug.padEnd(42)} ${r.status}${r.reason ? ` — ${r.reason}` : ""} (${elapsedMin}m)\n`;
      logProgress(line);
      if (r.status === "translated") translated++;
      else if (r.status === "cached") cached++;
      else if (r.status === "dry-run" || r.status === "skipped") skipped++;
      else errors++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const totalMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  const tail = `\ntranslated: ${translated} · cached: ${cached} · skipped: ${skipped} · errors: ${errors} · elapsed: ${totalMin}m\n`;
  console.error(tail);
  if (PROGRESS_FILE) try { fs.appendFileSync(PROGRESS_FILE, tail); } catch {}
  process.exit(errors > 0 ? EXIT.FAILURES : EXIT.OK);
}

main().catch((e) => { console.error(e); process.exit(EXIT.FAILURES); });
