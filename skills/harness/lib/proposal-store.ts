/**
 * proposal-store.ts — JSONL-based persistence for improver proposals.
 *
 * Phase 8 (meta-Nirvana) da nirvana-evolution.
 *
 * Append-only file at ~/.nirvana-improver/proposals.jsonl. Each line is one
 * proposal (or a status update for an existing proposal). The "current state"
 * of a proposal is obtained by replaying the log: last status-update wins.
 *
 * No SQLite hard dependency — keeps the module portable. Querying is O(N) on
 * disk size; fine for thousands of proposals.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { Proposal } from "./proposal-writer.ts";

const DEFAULT_ROOT = join(homedir(), ".nirvana-improver");

export type ProposalStatus = "pending" | "accepted" | "rejected" | "applied" | "expired";

interface LogLine {
  type: "create" | "status";
  id: string;
  ts: string;
  proposal?: Proposal;
  status?: ProposalStatus;
  note?: string;
}

export interface StoredProposal extends Proposal {
  status: ProposalStatus;
  status_history: { ts: string; status: ProposalStatus; note?: string }[];
}

export class ProposalStore {
  private root: string;
  constructor(opts: { root?: string } = {}) {
    this.root = opts.root ?? DEFAULT_ROOT;
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  private path(): string {
    return join(this.root, "proposals.jsonl");
  }

  add(proposal: Proposal): void {
    const line: LogLine = {
      type: "create",
      id: proposal.id,
      ts: new Date().toISOString(),
      proposal,
    };
    appendFileSync(this.path(), JSON.stringify(line) + "\n", "utf8");
  }

  setStatus(id: string, status: ProposalStatus, note?: string): void {
    const line: LogLine = {
      type: "status",
      id,
      ts: new Date().toISOString(),
      status,
      note,
    };
    appendFileSync(this.path(), JSON.stringify(line) + "\n", "utf8");
  }

  list(filter?: { status?: ProposalStatus[]; entity_type?: string }): StoredProposal[] {
    if (!existsSync(this.path())) return [];
    const raw = readFileSync(this.path(), "utf8");
    const byId = new Map<string, StoredProposal>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogLine;
        if (entry.type === "create" && entry.proposal) {
          byId.set(entry.id, {
            ...entry.proposal,
            status: "pending",
            status_history: [{ ts: entry.ts, status: "pending" }],
          });
        } else if (entry.type === "status" && entry.status) {
          const p = byId.get(entry.id);
          if (!p) continue;
          p.status = entry.status;
          p.status_history.push({ ts: entry.ts, status: entry.status, note: entry.note });
        }
      } catch {
        // skip malformed
      }
    }
    let arr = [...byId.values()];
    if (filter?.status && filter.status.length > 0) {
      arr = arr.filter((p) => filter.status!.includes(p.status));
    }
    if (filter?.entity_type) {
      arr = arr.filter((p) => p.entity_type === filter.entity_type);
    }
    return arr.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  }

  get(id: string): StoredProposal | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  rootPath(): string { return this.root; }
}
