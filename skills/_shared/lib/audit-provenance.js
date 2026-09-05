// audit-provenance.js — the implementation, in CJS so a `.js` caller can
// require() it directly.
//
// `harness/lib/audit.js` is the canonical emitter and it is CommonJS. A `.js`
// requiring a `.ts` is the ESM boundary Windows enforces as a hard error, and
// this repo already carries the fix as a pattern: the logic lives in the CJS
// sibling, the `.ts` is the typed face. Same shape as log-paths.ts/.js.
//
// Why any of this exists: an audit line an agent typed used to be
// indistinguishable from one the engine emitted. See the .ts for the full
// account, including what this does not buy.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const STAMP_FIELD = "sig";

function auditKeyPath() {
  if (process.env.NIRVANA_AUDIT_KEY) return process.env.NIRVANA_AUDIT_KEY;
  const home = process.env.NIRVANA_HOME || os.homedir();
  return path.join(home, ".nirvana", "audit-key");
}

let cached = null;
let cachedFrom = "";

function auditKey() {
  const p = auditKeyPath();
  if (cached && cachedFrom === p) return cached;
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").trim();
      if (raw.length >= 32) { cached = Buffer.from(raw, "hex"); cachedFrom = p; return cached; }
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString("hex"), { mode: 0o600 });
    cached = key; cachedFrom = p;
    return cached;
  } catch { return null; }
}

function resetAuditKeyCache() { cached = null; cachedFrom = ""; }

/** Keys sorted: two emitters building the same event in a different order must
 *  not produce different MACs for identical content. */
function canonical(event) {
  const rest = { ...event };
  delete rest[STAMP_FIELD];
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function stamp(event) {
  const key = auditKey();
  if (!key) return event;
  const sig = crypto.createHmac("sha256", key).update(canonical(event)).digest("hex").slice(0, 32);
  return { ...event, [STAMP_FIELD]: sig };
}

function provenanceOf(event) {
  const sig = event && event[STAMP_FIELD];
  if (typeof sig !== "string" || !sig) return "unsigned";
  const key = auditKey();
  if (!key) return "unsigned";
  const expect = crypto.createHmac("sha256", key).update(canonical(event)).digest("hex").slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "engine" : "tampered";
}

function auditProvenanceSummary(file) {
  const out = { engine: 0, unsigned: 0, tampered: 0, total: 0 };
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return out; }
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    out.total++;
    out[provenanceOf(e)]++;
  }
  return out;
}

module.exports = { STAMP_FIELD, auditKeyPath, auditKey, resetAuditKeyCache, stamp, provenanceOf, auditProvenanceSummary };
