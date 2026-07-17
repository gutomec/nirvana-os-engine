/**
 * rubric-selector.ts — given a dispatch's `produces[]` declaration, returns
 * the rubric(s) that should evaluate the output. Multiple rubrics can apply
 * (e.g. a "blog-post with custom image" deliverable triggers both
 * prose-shortform and image rubrics).
 *
 * Rubric files live in skills/harness/rubrics/<name>.md with YAML frontmatter
 * declaring `applies_to_produces[]`. This module reads them, builds an index,
 * and offers selection by produces slug.
 *
 * Phase 3 da nirvana-evolution.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const RUBRICS_DIR = join(import.meta.dir, "..", "rubrics");

export interface RubricMeta {
  name: string;
  display_name: string;
  file_path: string;
  // "inherit" = use the model configured in the user's runtime (the default).
  // The engine never prescribes a model; this field is telemetry-only.
  target_model: "haiku" | "sonnet" | "opus" | "inherit";
  pass_threshold: number;
  applies_to_produces: string[];
  description: string;
  body: string;
  version: string;
}

let _cache: RubricMeta[] | null = null;

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const yamlBody = m[1];
  const meta: Record<string, unknown> = {};
  let currentList: string | null = null;
  const acc: string[] = [];
  const lines = yamlBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^( *)/)?.[1].length ?? 0;
    if (indent > 0 && currentList) {
      const item = line.trim();
      if (item.startsWith("- ")) {
        const arr = meta[currentList] as string[];
        arr.push(item.slice(2).trim().replace(/^["']|["']$/g, ""));
        continue;
      }
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentList = null;
    const key = kv[1];
    const val = kv[2];
    if (val === "" || val === ">" || val === "|") {
      // multi-line: collect until indentation drops
      if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        // could be either list or block scalar; if next non-blank starts with "- ", it's a list
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (lines[j]?.trim().startsWith("- ")) {
          meta[key] = [];
          currentList = key;
          continue;
        }
        // block scalar — collect indented lines
        if (val === "|" || val === ">") {
          acc.length = 0;
          let k = i + 1;
          while (k < lines.length && (lines[k].length === 0 || /^\s/.test(lines[k]))) {
            acc.push(lines[k].replace(/^ {0,4}/, ""));
            k++;
          }
          meta[key] = acc.join(val === "|" ? "\n" : " ").trim();
          i = k - 1;
          continue;
        }
      }
      meta[key] = "";
      continue;
    }
    meta[key] = val.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

function loadAll(): RubricMeta[] {
  if (_cache) return _cache;
  if (!existsSync(RUBRICS_DIR)) return [];
  const files = readdirSync(RUBRICS_DIR).filter((f) => f.endsWith(".md"));
  const out: RubricMeta[] = [];
  for (const f of files) {
    const filePath = join(RUBRICS_DIR, f);
    const raw = readFileSync(filePath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    if (meta.type !== "harness_rubric") continue;
    const applies = Array.isArray(meta.applies_to_produces)
      ? (meta.applies_to_produces as string[])
      : [];
    out.push({
      name: String(meta.name ?? basename(f, ".md")),
      display_name: String(meta.display_name ?? meta.name ?? f),
      file_path: filePath,
      target_model: ((meta.target_model as string) ?? "inherit") as RubricMeta["target_model"],
      pass_threshold: Number(meta.pass_threshold ?? 70),
      applies_to_produces: applies,
      description: String(meta.description ?? ""),
      body,
      version: String(meta.version ?? "1.0.0"),
    });
  }
  _cache = out;
  return out;
}

export function listRubrics(): RubricMeta[] {
  return loadAll();
}

export function getRubric(name: string): RubricMeta | null {
  return loadAll().find((r) => r.name === name) ?? null;
}

/**
 * Pick rubric(s) for a given produces list. Returns:
 *   - Best matches: rubrics with explicit `applies_to_produces` entry hitting any produces slug
 *   - If none match: a single "fallback" entry (prose_shortform if produces look text-like,
 *     code if code-shaped, else mind-clone-voice if a clone was injected)
 *
 * Multiple rubrics can be returned (e.g. blog-post + image both apply to a
 * "blog-post-with-illustration" deliverable). Caller decides parallel or serial.
 */
export function selectRubricsForProduces(
  produces: string[],
  hints?: { had_mind_clone?: boolean; artifact_kind?: string },
): { rubrics: RubricMeta[]; fallback_used: boolean; reason: string } {
  const all = loadAll();
  if (produces.length === 0) {
    const fallback = all.find((r) => r.name === "prose_shortform");
    return {
      rubrics: fallback ? [fallback] : [],
      fallback_used: true,
      reason: "no produces declared; falling back to prose_shortform generic",
    };
  }
  const matched = new Map<string, RubricMeta>();
  for (const r of all) {
    for (const slug of produces) {
      if (r.applies_to_produces.includes(slug)) {
        matched.set(r.name, r);
        break;
      }
    }
  }
  if (matched.size > 0) {
    // If a mind-clone was injected, also include voice-fidelity rubric.
    if (hints?.had_mind_clone) {
      const voice = all.find((r) => r.name === "mind_clone_voice_fidelity");
      if (voice) matched.set(voice.name, voice);
    }
    return {
      rubrics: [...matched.values()],
      fallback_used: false,
      reason: `matched ${matched.size} rubric(s) on produces: ${[...matched.keys()].join(", ")}`,
    };
  }
  // No match — best-effort fallback.
  const codeLike = produces.some((p) => /code|script|module|migration|refactor|api/.test(p));
  const fbName = codeLike ? "code" : "prose_shortform";
  const fb = all.find((r) => r.name === fbName);
  return {
    rubrics: fb ? [fb] : [],
    fallback_used: true,
    reason: `no rubric declares applies_to_produces matching [${produces.join(",")}]; fell back to ${fbName}`,
  };
}

// Clear cache (useful in tests).
export function _invalidate(): void {
  _cache = null;
}

export const __internal__ = { parseFrontmatter };
