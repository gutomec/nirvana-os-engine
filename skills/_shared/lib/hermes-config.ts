import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
type YamlDocument = any;
type PublishOptions = {
  afterTemporaryWrite?: (temporary: string) => void;
  beforePublish?: () => void;
  rename?: (from: string, to: string) => void;
};

function yaml(): { parseDocument: (source: string) => YamlDocument } {
  return requireCjs("yaml");
}

function yamlError(file: string, message: string): Error {
  return new Error(`refusing to modify invalid Hermes YAML at ${file}: ${message}`);
}

function parseYaml(raw: string, file: string): YamlDocument {
  const doc = yaml().parseDocument(raw);
  if (doc.errors.length) throw yamlError(file, doc.errors[0].message);
  return doc;
}

function mapping(value: unknown, file: string, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`refusing to replace ${key} in ${file}: expected a mapping`);
  return value as Record<string, unknown>;
}

function rootMapping(doc: YamlDocument, file: string): Record<string, unknown> {
  return mapping(doc.toJS(), file, "root");
}

function stringList(value: unknown, file: string, key: string): string[] {
  if (value === undefined) return [];
  const json = value && typeof (value as any).toJSON === "function" ? (value as any).toJSON() : value;
  if (!Array.isArray(json) || json.some((item) => typeof item !== "string")) {
    throw new Error(`refusing to replace ${key} in ${file}: expected a list of strings`);
  }
  return json;
}

function hookList(value: unknown, file: string, key: string): any[] {
  if (value === undefined) return [];
  const json = value && typeof (value as any).toJSON === "function" ? (value as any).toJSON() : value;
  if (!Array.isArray(json)) throw new Error(`refusing to replace ${key} in ${file}: expected a hook list`);
  return json;
}

function rendered(doc: YamlDocument, file: string): string {
  const candidate = doc.toString({ lineWidth: 0, indentSeq: false });
  parseYaml(candidate, file);
  return candidate;
}

export function readHermesYaml(raw: string, file: string): Record<string, unknown> {
  return rootMapping(parseYaml(raw, file), file);
}

/** Add only missing Hermes bridge directories, preserving any existing entries. */
export function patchHermesExternalDirs(raw: string, file: string, bridgeDir: string, projectSkillsVar: string): string | null {
  const doc = parseYaml(raw, file);
  const root = rootMapping(doc, file);
  mapping(root.skills, file, "skills");
  const current = stringList(doc.getIn(["skills", "external_dirs"]), file, "skills.external_dirs");
  const missing = [bridgeDir, projectSkillsVar].filter((entry) => !current.includes(entry));
  if (!missing.length) return null;
  doc.setIn(["skills", "external_dirs"], [...current, ...missing]);
  return rendered(doc, file);
}

/** Add a Nirvana Hermes audit hook only when that event has no existing Nirvana hook. */
export function patchHermesAuditHooks(raw: string, file: string, token: string, hooks: Array<[string, string]>): string | null {
  const doc = parseYaml(raw, file);
  const root = rootMapping(doc, file);
  mapping(root.hooks, file, "hooks");
  let changed = false;
  for (const [event, command] of hooks) {
    const current = hookList(doc.getIn(["hooks", event]), file, `hooks.${event}`);
    if (current.some((hook) => hook && typeof hook.command === "string" && hook.command.includes(token))) continue;
    doc.setIn(["hooks", event], [...current, { matcher: "terminal|file", command, timeout: 5 }]);
    changed = true;
  }
  return changed ? rendered(doc, file) : null;
}

/** Atomically publish a validated candidate after a conflict check and retained backup. */
export function publishHermesYaml(file: string, raw: string, candidate: string, options: PublishOptions = {}): void {
  parseYaml(candidate, file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = path.join(dir, `.${path.basename(file)}.nirvana-${nonce}.tmp`);
  const mode = fs.statSync(file).mode;
  try {
    fs.writeFileSync(temporary, candidate, { encoding: "utf8", flag: "wx" });
    fs.chmodSync(temporary, mode);
    options.afterTemporaryWrite?.(temporary);
    const prepared = fs.readFileSync(temporary, "utf8");
    if (prepared !== candidate) throw new Error(`refusing to replace ${file}: the candidate changed before validation`);
    parseYaml(prepared, file);
    options.beforePublish?.();
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== raw) {
      throw new Error(`refusing to replace ${file}: it changed while the candidate was prepared`);
    }
    fs.copyFileSync(file, `${file}.nirvana-backup.${nonce}`, fs.constants.COPYFILE_EXCL);
    if (fs.readFileSync(file, "utf8") !== raw) {
      throw new Error(`refusing to replace ${file}: it changed while the backup was prepared`);
    }
    (options.rename ?? fs.renameSync)(temporary, file);
    const published = fs.readFileSync(file, "utf8");
    if (published !== candidate) throw new Error(`YAML readback validation failed for ${file}`);
    parseYaml(published, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary); } catch { /* preserve the original error */ }
  }
}

/** Add missing allowlist pairs without rewriting malformed JSON or existing approvals. */
export function patchHermesAllowlist(raw: string, file: string, pairs: Array<[string, string]>, now: string): string | null {
  let data: any;
  try { data = JSON.parse(raw); }
  catch (error) { throw new Error(`refusing to modify invalid Hermes allowlist JSON at ${file}: ${(error as Error).message}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`refusing to replace ${file}: expected an object`);
  if (data.approvals !== undefined && !Array.isArray(data.approvals)) throw new Error(`refusing to replace approvals in ${file}: expected a list`);
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const additions = pairs.filter(([event, command]) => !approvals.some((entry: any) => entry && entry.event === event && entry.command === command));
  if (!additions.length) return null;
  return JSON.stringify({ ...data, approvals: [...approvals, ...additions.map(([event, command]) => ({ event, command, approved_at: now, script_mtime_at_approval: null }))] }, null, 2) + "\n";
}

export function publishHermesJson(file: string, raw: string | null, candidate: string, options: PublishOptions = {}): void {
  try { JSON.parse(candidate); } catch (error) { throw new Error(`refusing to publish invalid Hermes allowlist JSON at ${file}: ${(error as Error).message}`); }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const existed = raw !== null;
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = path.join(dir, `.${path.basename(file)}.nirvana-${nonce}.tmp`);
  try {
    fs.writeFileSync(temporary, candidate, { encoding: "utf8", flag: "wx" });
    fs.chmodSync(temporary, existed ? fs.statSync(file).mode : 0o600);
    options.afterTemporaryWrite?.(temporary);
    const prepared = fs.readFileSync(temporary, "utf8");
    if (prepared !== candidate) throw new Error(`refusing to replace ${file}: the candidate changed before validation`);
    JSON.parse(prepared);
    options.beforePublish?.();
    if (fs.existsSync(file) !== existed || (existed && fs.readFileSync(file, "utf8") !== raw)) throw new Error(`refusing to replace ${file}: it changed while the candidate was prepared`);
    if (existed) fs.copyFileSync(file, `${file}.nirvana-backup.${nonce}`, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(file) !== existed || (existed && fs.readFileSync(file, "utf8") !== raw)) throw new Error(`refusing to replace ${file}: it changed while the backup was prepared`);
    (options.rename ?? fs.renameSync)(temporary, file);
    const published = fs.readFileSync(file, "utf8");
    if (published !== candidate) throw new Error(`JSON readback validation failed for ${file}`);
    JSON.parse(published);
  } finally {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary); } catch { /* preserve the original error */ }
  }
}
