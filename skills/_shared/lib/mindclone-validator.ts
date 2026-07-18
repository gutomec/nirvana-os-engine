/**
 * mindclone-validator.ts — fail-fast validator for canonical Mind-Clone files.
 *
 * Source of truth: ~/.nirvana/skills/_shared/schemas/dna.schema.json
 * Template:        ~/.nirvana/skills/_shared/templates/MIND_CLONE_TEMPLATE.md
 *
 * What it validates:
 *   - Frontmatter: REQUIRED name + description (identity). model/tools/maxTurns are
 *     OPTIONAL (the FdG factory format omits them and they are not consumed at
 *     runtime) — flagged as warnings only when present-but-invalid.
 *   - Body structure: EITHER the numbered 10-section template (## 1. … ## 10.) OR
 *     the FdG named-section format (Identity / How You Think / Frameworks / …);
 *     at least 4 '## ' sections.
 *
 * What it does NOT validate (out of scope, kept as soft-warnings):
 *   - Semantic quality of section content
 *   - Cross-references / links resolvability
 *
 * Returns a {ok, errors[], warnings[]} struct — never throws.
 * Pure JS/Bun, OS-agnostic, no external deps beyond js-yaml.
 */

import * as fs from "node:fs";

let _yaml: any = null;
function loadYaml(): any {
  if (_yaml) return _yaml;
  try { _yaml = require("yaml"); return _yaml; } catch {}  // yaml v2 (padrão do engine); js-yaml removido (DoS GHSA-h67p-54hq-rp68)
  return null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  meta?: {
    name?: string;
    description?: string;
    model?: string;
    maxTurns?: number;
    tools?: string[];
    category?: string;
    fidelity?: string;
    updated?: string;
    body_sections?: number[];
    body_chars?: number;
  };
}

const KEBAB = /^[a-z][a-z0-9-]{1,63}$/;
const ALLOWED_MODELS = new Set(["haiku", "sonnet", "opus", "inherit"]);
const REQUIRED_SECTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Parse `---\nyaml\n---\nbody` into { meta, body }. Returns null on missing frontmatter. */
export function splitFrontmatter(text: string): { meta: any; body: string } | null {
  // Strip BOM
  const t = text.replace(/^﻿/, "");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const yaml = loadYaml();
  if (!yaml) return { meta: {}, body: m[2] };
  try {
    const meta = yaml.parse(m[1]) ?? {};
    return { meta, body: m[2] };
  } catch (e) {
    return null;
  }
}

/** Returns the list of `## N. …` heading numbers found in the body, in order. */
export function extractSectionNumbers(body: string): number[] {
  const out: number[] = [];
  const re = /^##\s+(\d+)\.\s+/gm;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(body)) !== null) {
    out.push(parseInt(mm[1], 10));
  }
  return out;
}

/** Validate a mind-clone .md file (entire raw text). Returns a structured result. */
export function validateMindClone(text: string, opts: { filePath?: string } = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const result: ValidationResult = { ok: false, errors, warnings, meta: {} };

  const fp = opts.filePath || "(in-memory)";
  const fm = splitFrontmatter(text);
  if (!fm) {
    errors.push({ code: "FRONTMATTER_MISSING", message: "no YAML frontmatter found (expected '---\\n…\\n---\\n')", path: fp });
    return result;
  }
  if (!loadYaml()) {
    warnings.push({ code: "YAML_LIB_MISSING", message: "js-yaml not installed; frontmatter validated as raw object only" });
  }

  const meta = fm.meta || {};
  result.meta = {
    name: meta.name,
    description: meta.description,
    model: meta.model,
    maxTurns: meta.maxTurns,
    tools: Array.isArray(meta.tools) ? meta.tools : undefined,
    category: meta.category,
    fidelity: meta.fidelity,
    updated: meta.updated ? String(meta.updated) : undefined,
  };

  // — Required fields —
  if (typeof meta.name !== "string" || !meta.name) {
    errors.push({ code: "NAME_MISSING", message: "frontmatter.name is required (kebab-case identifier)", path: fp });
  } else if (!KEBAB.test(meta.name)) {
    errors.push({ code: "NAME_PATTERN", message: `frontmatter.name '${meta.name}' must match ^[a-z][a-z0-9-]{1,63}$`, path: fp });
  }

  if (typeof meta.description !== "string" || !meta.description) {
    errors.push({ code: "DESCRIPTION_MISSING", message: "frontmatter.description is required", path: fp });
  } else if (meta.description.length < 40) {
    errors.push({ code: "DESCRIPTION_TOO_SHORT", message: `frontmatter.description must be ≥40 chars (got ${meta.description.length})`, path: fp });
  } else {
    // Soft check: format hint "Use quando … Invocar para: … NÃO usar para:"
    const hasInvocarPara = /Invocar para:/i.test(meta.description) || /Use for:/i.test(meta.description);
    const hasAntiPattern = /N(Ã|A)O usar para:/i.test(meta.description) || /Do NOT use for:/i.test(meta.description);
    if (!hasInvocarPara || !hasAntiPattern) {
      warnings.push({ code: "DESCRIPTION_FORMAT", message: "description should include 'Invocar para: …' and 'NÃO usar para: …' triggers/anti-patterns", path: fp });
    }
  }

  // model is OPTIONAL (not consumed at runtime; FdG factory format omits it).
  if (meta.model !== undefined && !ALLOWED_MODELS.has(meta.model)) {
    warnings.push({ code: "MODEL_INVALID", message: `frontmatter.model '${meta.model}', when set, should be one of: ${[...ALLOWED_MODELS].join(", ")}`, path: fp });
  }

  // maxTurns is OPTIONAL; only flag an out-of-range value when one is present.
  if (meta.maxTurns !== undefined && (typeof meta.maxTurns !== "number" || !Number.isInteger(meta.maxTurns) || meta.maxTurns < 1 || meta.maxTurns > 200)) {
    warnings.push({ code: "MAXTURNS_RANGE", message: `frontmatter.maxTurns, when set, should be an integer in [1, 200] (got ${meta.maxTurns})`, path: fp });
  }

  // tools is OPTIONAL (not consumed at runtime; FdG factory format omits it).
  if (meta.tools !== undefined && (!Array.isArray(meta.tools) || meta.tools.some((t: any) => typeof t !== "string" || !t))) {
    warnings.push({ code: "TOOLS_INVALID", message: "frontmatter.tools, when set, should be a non-empty array of tool-name strings", path: fp });
  }

  // — Optional fields —
  if (meta.category !== undefined) {
    if (typeof meta.category !== "string" || !/^[0-9]{2}-[a-z][a-z0-9-]+$/.test(meta.category)) {
      warnings.push({ code: "CATEGORY_PATTERN", message: `frontmatter.category '${meta.category}' should match ^[0-9]{2}-[a-z][a-z0-9-]+$`, path: fp });
    }
  }
  if (meta.fidelity !== undefined && !["high", "medium", "low"].includes(meta.fidelity)) {
    warnings.push({ code: "FIDELITY_INVALID", message: `frontmatter.fidelity '${meta.fidelity}' should be one of: high, medium, low`, path: fp });
  }

  // — Body sections — accept EITHER the numbered 10-section template (## 1. … ## 10.)
  // OR the FdG factory format (named ## sections: Identity / How You Think / …).
  const sections = extractSectionNumbers(fm.body);
  const h2Count = (fm.body.match(/^##\s+\S/gm) || []).length;
  result.meta!.body_sections = sections;
  result.meta!.body_chars = fm.body.length;

  const numberedComplete = REQUIRED_SECTIONS.every(n => sections.includes(n));
  if (!numberedComplete && h2Count < 4) {
    errors.push({
      code: "BODY_TOO_THIN",
      message: `mind-clone body must use the numbered 10-section template OR have at least 4 named '## ' sections (found ${h2Count})`,
      path: fp,
    });
  }
  // Warn on out-of-order or duplicate
  for (let i = 1; i < sections.length; i++) {
    if (sections[i] === sections[i - 1]) {
      warnings.push({ code: "SECTION_DUPLICATE", message: `section ## ${sections[i]}. appears more than once`, path: fp });
      break;
    }
  }

  // — Final verdict —
  result.ok = errors.length === 0;
  return result;
}

/** Convenience: validate a file by path. */
export function validateMindCloneFile(filePath: string): ValidationResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [{ code: "FILE_NOT_FOUND", message: `not found: ${filePath}`, path: filePath }], warnings: [] };
  }
  let text: string;
  try { text = fs.readFileSync(filePath, "utf8"); }
  catch (e: any) {
    return { ok: false, errors: [{ code: "READ_FAILED", message: e.message, path: filePath }], warnings: [] };
  }
  return validateMindClone(text, { filePath });
}
