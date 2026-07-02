#!/usr/bin/env bun
/**
 * nrv license — verificador de licença OFFLINE + ativação opt-in.
 *
 * Verifica o PROVENANCE.json por-comprador (assinatura Ed25519) contra a chave
 * PÚBLICA embutida abaixo. É SOFT por design: nunca bloqueia o uso do sistema —
 * só informa a procedência da cópia. A ativação (`nrv license activate`) vincula
 * esta máquina à licença (soft-gate de seats no servidor) e destrava
 * updates/suporte; o uso offline permanece sempre liberado.
 *
 * Comandos:
 *   nrv license            → mostra a procedência + status da assinatura
 *   nrv license verify     → idem (exit 3 só se a assinatura for adulterada)
 *   nrv license check      → status + heartbeat online (warning-only, nunca bloqueia)
 *   nrv license activate [--label "<nome>"]  → vincula esta máquina (online)
 */
import { createPublicKey, createHash, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { join } from "node:path";

// Chave PÚBLICA do Nirvana (par Ed25519; a PRIVADA vive só na VPS de produção).
// Seguro embutir: serve apenas para VERIFICAR assinaturas, jamais para assinar.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAG1dxalg75kA0W8orZ1gdJQB8MlJiQLcxucuYASpQVZM=
-----END PUBLIC KEY-----
`;

const ACTIVATE_URL =
  process.env.NIRVANA_ACTIVATE_URL || "https://squads.sh/api/nirvana/activate";
const VALIDATE_URL =
  process.env.NIRVANA_VALIDATE_URL || "https://squads.sh/api/nirvana/validate";
const LICENSE_DIR = join(homedir(), ".nirvana-license");
const STORE_PROV = join(LICENSE_DIR, "PROVENANCE.json");
const STORE_ACT = join(LICENSE_DIR, "activation.json");

const RED = "\x1b[1;38;2;230;57;53m";
const DIM = "\x1b[2m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const RST = "\x1b[0m";

const PROV_FIELDS = [
  "product", "edition", "version", "license_key",
  "watermark_id", "buyer_email", "buyer_name", "issued_at",
];

function findProvenance(): string | null {
  const candidates = [
    process.env.NIRVANA_PROVENANCE,
    STORE_PROV,
    join(process.cwd(), "PROVENANCE.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

type VStatus = "valid" | "invalid" | "unsigned" | "absent";
interface VResult { status: VStatus; data?: Record<string, unknown>; path?: string }

function verifyProvenance(): VResult {
  const p = findProvenance();
  if (!p) return { status: "absent" };
  let prov: Record<string, unknown>;
  try {
    prov = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { status: "absent", path: p };
  }
  const sig = prov.signature;
  if (typeof sig !== "string" || !sig.includes(".")) {
    return { status: "unsigned", data: prov, path: p };
  }
  try {
    const [body, sigB64] = sig.split(".");
    const pub = createPublicKey(PUBLIC_KEY_PEM);
    const ok = edVerify(null, Buffer.from(body, "utf8"), pub, Buffer.from(sigB64, "base64url"));
    if (!ok) return { status: "invalid", data: prov, path: p };
    // O payload assinado tem que bater com os campos exibidos (anti-troca de capa).
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    for (const f of PROV_FIELDS) {
      if (JSON.stringify(payload[f]) !== JSON.stringify(prov[f])) {
        return { status: "invalid", data: prov, path: p };
      }
    }
    return { status: "valid", data: prov, path: p };
  } catch {
    return { status: "invalid", data: prov, path: p };
  }
}

function machineId(): string {
  return createHash("sha256")
    .update(`${hostname()}|${platform()}|${arch()}|${homedir()}`)
    .digest("hex")
    .slice(0, 32);
}

function printStatus(v: VResult): void {
  console.log(`\n${RED}Nirvana-OS — Licença${RST}`);
  if (v.status === "absent") {
    console.log(`  ${DIM}Sem PROVENANCE.json — cópia sem procedência (uso liberado).${RST}`);
    console.log(`  ${DIM}Tem o pacote Genesis Circle? Rode "bun setup.ts" de dentro da pasta descompactada.${RST}\n`);
    return;
  }
  const d = (v.data || {}) as Record<string, string>;
  const who = d.buyer_name || d.buyer_email || "—";
  console.log(`  Licenciado para: ${who}${d.buyer_email ? ` <${d.buyer_email}>` : ""}`);
  console.log(`  Chave:           ${d.license_key || "—"}`);
  console.log(`  Cópia (id):      ${d.watermark_id || "—"}`);
  console.log(`  Edição/versão:   ${d.edition || "—"} ${d.version || ""}`.trimEnd());
  if (d.issued_at) console.log(`  Emitida em:      ${d.issued_at}`);
  const sig =
    v.status === "valid" ? `${GRN}VÁLIDA${RST}` :
    v.status === "unsigned" ? `${YEL}não assinada${RST}` :
    `${YEL}INVÁLIDA (não confere com a chave oficial)${RST}`;
  console.log(`  Assinatura:      ${sig}`);
  if (existsSync(STORE_ACT)) {
    try {
      const a = JSON.parse(readFileSync(STORE_ACT, "utf8"));
      const mid = typeof a.machine_id === "string" ? a.machine_id.slice(0, 8) : "?";
      console.log(`  Ativação:        ativada (máquina ${mid}…)`);
    } catch {
      console.log(`  Ativação:        não ativada  ${DIM}(nrv license activate)${RST}`);
    }
  } else {
    console.log(`  Ativação:        não ativada  ${DIM}(nrv license activate — destrava updates/suporte; offline segue livre)${RST}`);
  }
  console.log("");
}

async function activate(label?: string): Promise<number> {
  const v = verifyProvenance();
  const key = (v.data?.license_key as string) || "";
  if (v.status === "absent" || !key) {
    console.log(`\n${YEL}Sem PROVENANCE.json com chave de licença — nada a ativar.${RST}`);
    console.log(`${DIM}Rode "bun setup.ts" de dentro da pasta do pacote Genesis Circle.${RST}\n`);
    return 1;
  }
  if (v.status === "invalid") {
    console.log(`\n${YEL}Assinatura do PROVENANCE inválida — ativação abortada.${RST}\n`);
    return 1;
  }
  const mid = machineId();
  const payload = { license_key: key, machine_id: mid, machine_label: label || hostname() };
  try {
    const res = await fetch(ACTIVATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error as string) || `HTTP ${res.status}`;
      console.log(`\n${YEL}Ativação não concluída: ${msg}.${RST} ${DIM}(uso offline segue liberado)${RST}\n`);
      return 0; // soft: nunca falha duro
    }
    mkdirSync(LICENSE_DIR, { recursive: true });
    writeFileSync(
      STORE_ACT,
      JSON.stringify({ ...json, machine_id: mid, activated_at: new Date().toISOString() }, null, 2) + "\n",
    );
    console.log(`\n${GRN}Máquina ativada.${RST} Licença ${key} vinculada (label: ${payload.machine_label}).`);
    console.log(`${DIM}Token salvo em ${STORE_ACT}. Uso offline permanece liberado.${RST}\n`);
    return 0;
  } catch (e) {
    console.log(`\n${YEL}Sem conexão para ativar agora${RST} ${DIM}(${(e as Error).message}). Rode "nrv license activate" depois.${RST}\n`);
    return 0;
  }
}

// Heartbeat online — best-effort, WARNING-only. Confirma com o servidor que a
// licença ainda está ativa (pega estornos/revogações/cópias não licenciadas).
// NUNCA bloqueia: rede caída, offline ou inativa, o uso segue liberado.
async function check(): Promise<number> {
  const v = verifyProvenance();
  printStatus(v);
  const key = (v.data?.license_key as string) || "";
  if (v.status === "absent" || !key) return 0; // edição free / sem licença — nada a checar
  if (v.status === "invalid") {
    console.log(`  ${YEL}⚠ Assinatura inválida — esta cópia não corresponde a uma licença oficial.${RST}\n`);
  }
  try {
    const res = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key, machine_id: machineId() }),
    });
    const json: Record<string, unknown> = await res.json().catch(() => ({}));
    if (json.ok === true) {
      console.log(`  ${GRN}✓ Licença ativa no servidor.${RST}\n`);
    } else {
      const st = (json.status as string) || `HTTP ${res.status}`;
      console.log(`  ${YEL}⚠ Esta licença não está ativa no servidor (${st}).${RST}`);
      console.log(`  ${DIM}Se você comprou, contate o suporte: cópias não licenciadas não recebem updates nem suporte.${RST}`);
      console.log(`  ${DIM}O uso offline NÃO é bloqueado.${RST}\n`);
    }
  } catch {
    /* offline / rede indisponível — silencioso, soft */
  }
  return 0; // soft por design — nunca falha duro
}

const sub = process.argv[2] || "status";
if (sub === "check") {
  process.exit(await check());
} else if (sub === "activate") {
  const li = process.argv.indexOf("--label");
  const label = li >= 0 ? process.argv[li + 1] : undefined;
  process.exit(await activate(label));
} else if (["status", "verify", "show", "whoami", ""].includes(sub)) {
  const v = verifyProvenance();
  printStatus(v);
  process.exit(v.status === "invalid" ? 3 : 0);
} else {
  console.log('uso: nrv license [status|verify|check|activate [--label "<nome>"]]');
  process.exit(2);
}
