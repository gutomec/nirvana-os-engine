// archive.ts — the whole delivery of a run, as one zip.
//
// The API could hand a client one file at a time and nothing else: `/artifacts`
// listed the paths, `/artifacts/{path}` returned one of them, and a run where
// four businesses and nine squads each delivered meant thirteen round trips the
// caller had to orchestrate from a listing it had to walk itself. `/result`
// helped only in the single-artifact case; the moment a run produced two files
// it degraded into the same listing. So the complete work of a run — the thing
// the client actually bought — had no representation in this API at all.
//
// Three properties this module exists to keep, none of them optional:
//
//   · It ships the WORK, never the instrumentation. Same `run-plumbing.ts` the
//     listing, the renderer, the verifier and `nrv export` read. A private
//     exclusion list is how the employee prompt, the mind-clone library and the
//     firm's permanent memory reached a client the last time.
//   · Text is REDACTED on the way in, exactly as `/artifacts/{path}` redacts it.
//     A zip that skipped that step would be a hole punched straight through the
//     secret-redaction work, and a bigger one, because it is a bundle the client
//     keeps rather than a response they read.
//   · It writes the zip ITSELF. `nrv export` shells out to `python3` (or `tar`),
//     which is fine for a developer machine and wrong for a server: a customer
//     VPS need not have either, and a download route that 500s because an
//     interpreter is missing is worse than no route. `node:zlib` is already
//     there — Bun ships it — so the format is written by hand here. ~90 lines,
//     no dependency, no subprocess, no temp file.
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { listArtifacts } from "./artifacts.ts";
import { redactForClient } from "./runs.ts";

/** CRC-32, the one the zip format wants. Table built once, on first use. */
let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what a local file header carries. */
function dosStamp(d: Date): { time: number; date: number } {
  // The format cannot express a year before 1980; clamp rather than write a
  // negative field that some extractors read as garbage.
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  data: Uint8Array;
  mtime?: Date;
}

/**
 * Zip64 is not implemented, so the classic ceilings apply: 65,535 entries and
 * 4 GiB. A run that exceeds either gets a refusal with the real number in it,
 * never a truncated archive that only fails when the client opens it.
 */
const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffff_ffff;

export function writeZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`archive_too_many_files: ${entries.length} entries, the zip format this server writes holds ${MAX_ENTRIES}`);
  }
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    // Deflate unless it makes the entry bigger, which happens on tiny or
    // already-compressed files (png, pdf, mp4). Storing those is both smaller
    // and faster to read back.
    const deflated = e.data.length ? deflateRawSync(e.data, { level: 6 }) : Buffer.alloc(0);
    const store = deflated.length >= e.data.length;
    const body = store ? Buffer.from(e.data) : deflated;
    const { time, date } = dosStamp(e.mtime ?? new Date());

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 filenames
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);       // no extra field
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38); // external attrs: a readable file
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    locals.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
    if (offset > MAX_BYTES) throw new Error("archive_too_large: over 4 GiB, which the zip format this server writes cannot address");
  }

  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBytes, end]);
}

/** Text goes out masked; binaries go out as they are. Same rule as `/artifacts/{path}`. */
const TEXTUAL = /\.(md|markdown|txt|json|ya?ml|html?|css|ts|js|jsx|tsx|py|rb|sh|csv|tsv|xml|svg|toml|ini|sql|log)$/i;

export interface ArchiveResult {
  zip: Uint8Array;
  files: { path: string; bytes: number }[];
  redactions: number;
}

/**
 * The complete delivery of one run, organized the way the org chart produced
 * it: a multi-business run keeps `businesses/<slug>/deliverables/…`, a squad
 * keeps its own folder, and everything sits under a single top directory named
 * for the run so extracting it never sprays files into the client's cwd.
 *
 * `MANIFEST.json` rides along, generated here rather than read off disk. It
 * answers the question a bundle of loose files cannot — what this is, which run
 * produced it, whether the gate passed — and it is the reason the archive of a
 * run that delivered nothing is still a valid zip with an honest explanation
 * inside, instead of a 404 for work that really did finish.
 */
export function buildRunArchive(opts: {
  outputsRoot: string;
  sessionDir: string;
  rootName: string;
  manifest: Record<string, unknown>;
  includeAudit?: boolean;
}): ArchiveResult {
  const entries: ZipEntry[] = [];
  const files: { path: string; bytes: number }[] = [];
  let redactions = 0;

  const add = (rel: string, abs: string) => {
    let raw: Buffer;
    let mtime: Date | undefined;
    try { raw = fs.readFileSync(abs); mtime = fs.statSync(abs).mtime; } catch { return; }
    let data: Uint8Array = raw;
    if (TEXTUAL.test(abs)) {
      const r = redactForClient(raw.toString("utf8"), opts.sessionDir);
      redactions += r.redactions;
      data = Buffer.from(r.text ?? "", "utf8");
    }
    entries.push({ name: `${opts.rootName}/${rel}`, data, mtime });
    files.push({ path: rel, bytes: data.length });
  };

  for (const a of listArtifacts(opts.outputsRoot)) {
    // listArtifacts already refuses plumbing and never leaves the root; the
    // join here is the same relative path it just handed back.
    add(a.path, path.join(opts.outputsRoot, ...a.path.split("/")));
  }

  // The audit trail is a deliberate ask, exactly as it is in `nrv export`: it
  // is the proof of what ran, and it is never in the bundle by default.
  if (opts.includeAudit) {
    for (const name of ["audit.jsonl", "HANDOFF.json"]) {
      const abs = path.join(opts.outputsRoot, name);
      if (fs.existsSync(abs)) add(`_audit/${name}`, abs);
    }
  }

  const manifest = { ...opts.manifest, files, redactions };
  entries.unshift({
    name: `${opts.rootName}/MANIFEST.json`,
    data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
  });

  return { zip: writeZip(entries), files, redactions };
}
