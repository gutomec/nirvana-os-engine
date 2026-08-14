#!/usr/bin/env bun
/**
 * nrv license — OFFLINE license verifier + opt-in activation.
 *
 * Verifies the per-buyer PROVENANCE.json (Ed25519 signature) against the PUBLIC
 * key embedded below. It is SOFT by design: it never blocks use of the system —
 * it only reports the copy's provenance. Activation (`nrv license activate`)
 * binds this machine to the license (seat soft-gate on the server) and unlocks
 * updates/support; offline use always stays unrestricted.
 *
 * Commands:
 *   nrv license            → shows the provenance + signature status
 *   nrv license verify     → same (exit 3 only if the signature is tampered)
 *   nrv license check      → status + online heartbeat (warning-only, never blocks)
 *   nrv license activate [--label "<nome>"]  → binds this machine (online)
 */
import { createPublicKey, createHash, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { join, dirname, resolve } from "node:path";

// Nirvana's PUBLIC key (Ed25519 pair; the PRIVATE one lives only on the production VPS).
// Safe to embed: it only serves to VERIFY signatures, never to sign.
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
    // The signed payload must match the displayed fields (anti cover-swap).
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
      return 0; // soft: never hard-fails
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

// Online heartbeat — best-effort, WARNING-only. Confirms with the server that the
// license is still active (catches chargebacks/revocations/unlicensed copies).
// It NEVER blocks: network down, offline or inactive, use stays unrestricted.
async function check(): Promise<number> {
  const v = verifyProvenance();
  printStatus(v);
  const key = (v.data?.license_key as string) || "";
  if (v.status === "absent" || !key) return 0; // free edition / no license — nothing to check
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
    /* offline / network unavailable — silent, soft */
  }
  return 0; // soft by design — never hard-fails
}

/**
 * Install a PROVENANCE.json into the license store.
 *
 * Until now the ONLY way to get a license in place was `bun setup.ts` — the
 * whole pack installer — because that is where the copy lives. A buyer whose
 * license never landed (setup run from a folder without the file, or run as a
 * different user, or never run at all) had to re-run an installer to copy one
 * small file. Windows buyer on 2026-08-14 hit exactly that.
 *
 * Given no path, it looks where a downloaded pack actually sits. Verification
 * comes after the copy and never blocks it: a file that fails signature checking
 * is still the file the buyer paid for, and telling them it is unsigned is more
 * useful than refusing to move it.
 */
async function install(explicit?: string): Promise<number> {
  const searched: string[] = [];
  const candidates: string[] = [];
  if (explicit) {
    // A folder is as good as a file — buyers paste the pack directory.
    candidates.push(explicit, join(explicit, "PROVENANCE.json"));
  } else {
    const home = homedir();
    for (const dir of [process.cwd(), join(home, "Downloads"), join(home, "Desktop"), home]) {
      candidates.push(join(dir, "PROVENANCE.json"));
      // One level down: ~/Downloads/nirvana-os-<pack>/PROVENANCE.json
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          // Skip the store itself: it matches /nirvana/ and would make the
          // command "find" what it is trying to install, then copy it onto
          // itself and report success on a no-op.
          if (!e.isDirectory() || join(dir, e.name) === LICENSE_DIR) continue;
          if (/nirvana|pack/i.test(e.name)) candidates.push(join(dir, e.name, "PROVENANCE.json"));
        }
      } catch { /* unreadable dir — skip */ }
    }
  }

  let src: string | null = null;
  for (const c of candidates) {
    searched.push(c);
    try { if (existsSync(c) && statSync(c).isFile()) { src = c; break; } } catch { /* keep looking */ }
  }

  if (!src) {
    console.log(`\n${YEL}Não encontrei um PROVENANCE.json.${RST}`);
    console.log(`${DIM}Procurei em:${RST}`);
    for (const c of searched.slice(0, 8)) console.log(`${DIM}  ${c}${RST}`);
    if (searched.length > 8) console.log(`${DIM}  … e mais ${searched.length - 8}${RST}`);
    console.log(`\n${DIM}Ele vem dentro do zip da compra, ao lado do setup.ts. Aponte direto:${RST}`);
    console.log(`${DIM}  nrv license install <caminho-do-PROVENANCE.json>${RST}`);
    console.log(`${DIM}  nrv license install <pasta-do-pack>${RST}\n`);
    return 1;
  }

  // "Already installed" has two shapes, and only one of them is about paths.
  //
  //  - Same FILE: realpath, not resolve — on macOS /tmp is a symlink to
  //    /private/tmp, so two spellings of one file compare unequal and the copy
  //    would run on itself.
  //  - Same CONTENT: the pack folder is still on disk after the first install,
  //    so a second run finds the original again. Re-copying it is harmless, but
  //    reporting "installed" for a no-op tells the buyer something happened
  //    when nothing did.
  const same = (() => {
    try {
      if (realpathSync(src) === realpathSync(STORE_PROV)) return true;
      return existsSync(STORE_PROV) && readFileSync(src, "utf8") === readFileSync(STORE_PROV, "utf8");
    } catch { return false; }
  })();
  if (same) {
    console.log(`${DIM}Já instalado em ${STORE_PROV}.${RST}`);
    return 0;
  }

  try {
    mkdirSync(LICENSE_DIR, { recursive: true });
    copyFileSync(src, STORE_PROV);
    const notice = join(dirname(src), "LICENSE.txt");
    if (existsSync(notice)) copyFileSync(notice, join(LICENSE_DIR, "LICENSE.txt"));
  } catch (e: any) {
    console.error(`\n${RED}Não consegui escrever em ${STORE_PROV}: ${e?.message ?? e}${RST}`);
    console.error(`${DIM}Rode com o mesmo usuário que vai usar o sistema (um terminal elevado tem outro perfil).${RST}\n`);
    return 1;
  }

  console.log(`${GRN}✓${RST} licença instalada: ${src} → ${STORE_PROV}`);
  // Report what it is, without gatekeeping: an unsigned copy is still theirs.
  printStatus(verifyProvenance());
  console.log(`${DIM}Agora "nrv update <pack>" encontra a licença.${RST}`);
  return 0;
}

const sub = process.argv[2] || "status";
if (sub === "install") {
  const arg = process.argv[3];
  process.exit(await install(arg && !arg.startsWith("-") ? arg : undefined));
} else if (sub === "check") {
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
  console.log('uso: nrv license [status|verify|check|install [<caminho>]|activate [--label "<nome>"]]');
  process.exit(2);
}
