/**
 * install-manifest.ts — append-only log of installs and uninstalls.
 *
 * File: ~/.nirvana-installed.jsonl
 *
 * Each line is one event. Current state is derived by replay: an
 * install record creates an entry; an uninstall record marks it removed.
 *
 * Manifest is the single source-of-truth for `nrv installed`, `nrv uninstall`,
 * and update-detection (Tier 3).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = join(homedir(), ".nirvana-installed.jsonl");

export type AssetKind = "business" | "squad" | "mind-clone" | "pack";

export interface InstalledItem {
  kind: AssetKind;
  name: string;
  path: string;
  /** category/slug for mind-clone, plain slug otherwise */
  slug: string;
}

export interface InstallEvent {
  ts: string;
  action: "install" | "uninstall" | "update";
  install_id: string;
  kind: AssetKind;
  name: string;
  version: string;
  source: string;
  path: string;
  checksum: string;
  scope: "global" | "project";
  pack_install_id?: string;
  items?: InstalledItem[];
  prev_version?: string;
  prev_checksum?: string;
  backup_path?: string;
  reason?: string;
}

export interface CurrentInstallation extends InstallEvent {
  status: "active" | "uninstalled" | "replaced";
  history: InstallEvent[];
}

export class InstallManifest {
  private path: string;

  constructor(opts: { path?: string } = {}) {
    this.path = opts.path ?? DEFAULT_PATH;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  pathOf(): string {
    return this.path;
  }

  append(event: InstallEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  /**
   * Return the current state of every name ever installed: most-recent event
   * wins; if it's `uninstall`, status = "uninstalled".
   */
  list(filter?: { active_only?: boolean; kind?: AssetKind; scope?: "global" | "project"; projectRoot?: string }): CurrentInstallation[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const byName = new Map<string, CurrentInstallation>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as InstallEvent;
        const key = `${ev.kind}:${ev.name}:${ev.scope ?? "global"}`;
        const existing = byName.get(key);
        if (!existing) {
          if (ev.action === "uninstall") continue; // uninstall without install — skip
          byName.set(key, { ...ev, status: ev.action === "install" ? "active" : "replaced", history: [ev] });
        } else {
          existing.history.push(ev);
          if (ev.action === "uninstall") {
            existing.status = "uninstalled";
          } else if (ev.action === "install" || ev.action === "update") {
            // Newer install of same name overrides
            Object.assign(existing, ev);
            existing.status = "active";
          }
        }
      } catch {
        // skip malformed line
      }
    }
    let arr = [...byName.values()];
    if (filter?.active_only) arr = arr.filter((x) => x.status === "active");
    if (filter?.kind) arr = arr.filter((x) => x.kind === filter.kind);
    if (filter?.scope) arr = arr.filter((x) => x.scope === filter.scope);
    if (filter?.projectRoot) {
      // Discriminate installs by project: keep only entries whose recorded
      // path lives under the given projectRoot. Without this, scope:"project"
      // mixes installs from every project sharing the global manifest.
      const rootPrefix = resolve(filter.projectRoot) + sep;
      arr = arr.filter((x) => (resolve(x.path) + sep).startsWith(rootPrefix));
    }
    return arr.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /**
   * Find the active installation for a (kind, name). Returns null if not installed
   * or if last event was uninstall.
   */
  findActive(kind: AssetKind, name: string, scope: "global" | "project" = "global"): CurrentInstallation | null {
    return this.list({ active_only: true, kind, scope }).find((x) => x.name === name) ?? null;
  }
}
