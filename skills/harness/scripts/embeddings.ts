#!/usr/bin/env bun
// embeddings.ts — gerencia o braço DENSO neural opcional do roteador híbrido.
//
// O produto base é zero-dep (BM25 + hash_tfidf). Este comando é o opt-in que
// instala o backend neural (@huggingface/transformers, ONNX, local, sem Python)
// e o ativa. Quando ativo, o roteador fast/autopilot funde BM25 + denso via RRF,
// recuperando especialistas que o BM25 perde por vocabulário (sinônimo/paráfrase).
//
// Uso: nrv embeddings <status|enable|disable|reindex>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { requestedBackend, neuralEmbedderAvailable } from "../lib/../../_shared/lib/embedder.ts";

const NIRVANA_HOME = process.env.NIRVANA_HOME || path.join(os.homedir(), ".nirvana");
const BACKEND_FILE = path.join(NIRVANA_HOME, "embedder-backend.txt");
const CACHE_DIR = path.join(NIRVANA_HOME, "cache");
const PKG = "@huggingface/transformers";

async function status() {
  const backend = requestedBackend() || "hash_tfidf (default)";
  console.log(`backend pedido:  ${backend}`);
  let installed = false;
  try { require.resolve(PKG); installed = true; } catch { /* not installed */ }
  console.log(`pacote neural:   ${installed ? PKG + " instalado" : "ausente (rode `nrv embeddings enable`)"}`);
  if (requestedBackend() === "transformers" || requestedBackend() === "neural") {
    process.stdout.write("modelo neural:   verificando…\r");
    const ok = await neuralEmbedderAvailable();
    console.log(`modelo neural:   ${ok ? "carrega OK (ativo)" : "indisponível → fallback hash_tfidf"}`);
  }
  let cached = 0;
  try { cached = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith("dense-")).length; } catch { /* none */ }
  console.log(`índice denso:    ${cached} arquivo(s) em cache`);
}

async function enable() {
  console.log(`Instalando ${PKG} (~150MB, uma vez) em ${NIRVANA_HOME}…`);
  const r = spawnSync("bun", ["add", PKG], { cwd: NIRVANA_HOME, stdio: "inherit" });
  if (r.status !== 0) { console.error("falha ao instalar o pacote neural."); process.exit(1); }
  fs.writeFileSync(BACKEND_FILE, "transformers\n", "utf8");
  console.log("Backend neural marcado como ativo. Carregando o modelo (baixa na 1ª vez)…");
  const ok = await neuralEmbedderAvailable();
  console.log(ok
    ? "✓ Backend neural ATIVO. O roteador fast agora funde BM25 + denso (RRF)."
    : "Instalado, mas o modelo ainda vai baixar no primeiro `nrv find`.");
}

function disable() {
  try { fs.rmSync(BACKEND_FILE); } catch { /* já ausente */ }
  console.log("Backend neural desativado — volta ao BM25 + hash_tfidf (zero-dep).");
}

function reindex() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith("dense-")) { fs.rmSync(path.join(CACHE_DIR, f)); n++; }
    }
  } catch { /* sem cache */ }
  console.log(`Cache de índice denso limpo (${n} arquivo(s)). Recomputa no próximo find.`);
}

const cmd = (process.argv[2] || "status").toLowerCase();
switch (cmd) {
  case "status": await status(); break;
  case "enable": case "on": await enable(); break;
  case "disable": case "off": disable(); break;
  case "reindex": case "reset": reindex(); break;
  default:
    console.error("uso: nrv embeddings <status|enable|disable|reindex>");
    process.exit(2);
}
