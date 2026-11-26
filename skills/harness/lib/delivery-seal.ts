// delivery-seal.ts — what exactly was approved.
//
// A gate verdict is about the bytes it read. Once a file changes, the verdict
// says nothing about it, yet the run still reads "delivered". The seal closes
// that gap: when a delivery goes out, the pipeline records the SHA-256 of every
// deliverable in `_SEAL.json` beside the work. Anyone can ask later whether the
// folder still holds what was approved (`nrv seal check <project>`), and a run
// that continues from another one is told which of its inputs changed since
// they were approved.
//
// The seal is run state: never a deliverable, never gated, never exported as
// work. It also records the hashes of the files the brief named as inputs, so
// a delivery can be shown stale when what it was built from moved on.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SEAL_FILE = "_SEAL.json";

export interface SealEntry { path: string; sha256: string; bytes: number }

export interface DeliverySeal {
  version: 1;
  trace: string;
  sealed_at: string;
  /** The gate verdict the seal stands for. */
  gate: string;
  state: string;
  /** Deliverables, by path relative to the outputs root (POSIX separators). */
  files: SealEntry[];
  /** Files the run was built from, by absolute path. */
  inputs: SealEntry[];
}

export interface SealCheck {
  sealed: boolean;
  sealedAt: string | null;
  gate: string | null;
  intact: boolean;
  changed: string[];
  missing: string[];
  /** Deliverables present now that the seal does not know. */
  added: string[];
  /** Inputs that changed or disappeared since the seal. */
  staleInputs: string[];
}

function hashFile(file: string): { sha256: string; bytes: number } | null {
  try {
    const data = fs.readFileSync(file);
    return { sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length };
  } catch { return null; }
}

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join("/");

/** Record the approved deliverables. Returns the seal, or null when it could not be written. */
export function writeSeal(outputsRoot: string, o: { trace: string; gate: string; state: string; files: string[]; inputs?: string[] }): DeliverySeal | null {
  const entries = (list: string[], name: (f: string) => string): SealEntry[] =>
    [...new Set(list)].sort().flatMap((f) => { const h = hashFile(f); return h ? [{ path: name(f), ...h }] : []; });
  const seal: DeliverySeal = {
    version: 1, trace: o.trace, sealed_at: new Date().toISOString(), gate: o.gate, state: o.state,
    files: entries(o.files, (f) => rel(outputsRoot, f)),
    inputs: entries((o.inputs ?? []).map((f) => path.resolve(f)), (f) => f),
  };
  try {
    fs.writeFileSync(path.join(outputsRoot, SEAL_FILE), JSON.stringify(seal, null, 2) + "\n", "utf8");
    return seal;
  } catch { return null; }
}

export function readSeal(outputsRoot: string): DeliverySeal | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(outputsRoot, SEAL_FILE), "utf8"));
    return doc && doc.version === 1 && Array.isArray(doc.files) ? { ...doc, inputs: Array.isArray(doc.inputs) ? doc.inputs : [] } : null;
  } catch { return null; }
}

/** Compare the folder with its seal. `current` is the list of deliverables there now. */
export function checkSeal(outputsRoot: string, current: string[] = []): SealCheck {
  const seal = readSeal(outputsRoot);
  if (!seal) return { sealed: false, sealedAt: null, gate: null, intact: false, changed: [], missing: [], added: [], staleInputs: [] };
  const changed: string[] = [];
  const missing: string[] = [];
  for (const e of seal.files) {
    const h = hashFile(path.join(outputsRoot, ...e.path.split("/")));
    if (!h) missing.push(e.path);
    else if (h.sha256 !== e.sha256) changed.push(e.path);
  }
  const known = new Set(seal.files.map((e) => e.path));
  const added = current.map((f) => rel(outputsRoot, f)).filter((p) => !known.has(p)).sort();
  const staleInputs = seal.inputs.filter((e) => hashFile(e.path)?.sha256 !== e.sha256).map((e) => e.path);
  return {
    sealed: true, sealedAt: seal.sealed_at, gate: seal.gate,
    intact: !changed.length && !missing.length && !added.length,
    changed, missing, added, staleInputs,
  };
}

/** The files a brief names by absolute path that exist outside the outputs root:
 *  what the run was built from. Bounded, so a brief that lists a tree costs nothing. */
export function briefInputFiles(brief: string, outputsRoot: string, max = 50): string[] {
  const out = new Set<string>();
  const root = path.resolve(outputsRoot);
  for (const m of brief.matchAll(/(?:[A-Za-z]:\\|\/)[^\s"'`<>|)\]]+/g)) {
    const candidate = m[0].replace(/[.,;:]+$/, "");
    if (out.size >= max) break;
    try {
      const full = path.resolve(candidate);
      if (full === root || full.startsWith(root + path.sep)) continue;
      const st = fs.statSync(full);
      if (st.isFile() && st.size <= 20 * 1024 * 1024) out.add(full);
    } catch { /* not a file on this machine */ }
  }
  return [...out];
}

/** What moved since a delivery was approved, as lines for the worker that builds
 *  on it; [] when the folder has no seal or nothing moved. */
export function sealChangeLines(outputsRoot: string): string[] {
  const c = checkSeal(outputsRoot);
  if (!c.sealed || (!c.changed.length && !c.missing.length && !c.staleInputs.length)) return [];
  const list = (items: string[]) => items.slice(0, 20).join(", ") + (items.length > 20 ? ` and ${items.length - 20} more` : "");
  return [
    `Since this work was approved (${c.sealedAt}), the files below are no longer what the gate read. Read them again before you rely on anything you remember of them:`,
    ...(c.changed.length ? [`- edited after the approval: ${list(c.changed)}`] : []),
    ...(c.missing.length ? [`- removed after the approval: ${list(c.missing)}`] : []),
    ...(c.staleInputs.length ? [`- inputs the work was built from that changed since: ${list(c.staleInputs)}. Bring every part of the work that depends on them up to date, without being asked.`] : []),
  ];
}
