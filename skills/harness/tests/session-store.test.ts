import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionKey, getSession, putSession, dropSession } from "../lib/session-store.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-sess-")); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe("session-store — isolamento por chave", () => {
  test("a mesma entidade em runtimes diferentes NÃO compartilha sessão", () => {
    // Um session id do claude-code não significa nada para o codex: reusar
    // entre runtimes falha na melhor hipótese e retoma a conversa errada na pior.
    putSession(dir, sessionKey("claude-code", "squad", "brandcraft"), "claude-code", "sess-cc");
    expect(getSession(dir, sessionKey("codex", "squad", "brandcraft"))).toBeNull();
    expect(getSession(dir, sessionKey("claude-code", "squad", "brandcraft"))).toBe("sess-cc");
  });

  test("a mesma entidade em projetos diferentes NÃO compartilha sessão", () => {
    const outro = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-sess2-"));
    try {
      const k = sessionKey("claude-code", "employee", "cco");
      putSession(dir, k, "claude-code", "sess-a");
      // É a isolação que impede viés de um projeto vazar para o outro.
      expect(getSession(outro, k)).toBeNull();
    } finally { fs.rmSync(outro, { recursive: true, force: true }); }
  });

  test("funcionário e squad de mesmo nome não colidem", () => {
    putSession(dir, sessionKey("claude-code", "employee", "x"), "claude-code", "sess-emp");
    putSession(dir, sessionKey("claude-code", "squad", "x"), "claude-code", "sess-squad");
    expect(getSession(dir, sessionKey("claude-code", "employee", "x"))).toBe("sess-emp");
    expect(getSession(dir, sessionKey("claude-code", "squad", "x"))).toBe("sess-squad");
  });
});

describe("session-store — degradação nunca vira falha", () => {
  test("projeto sem arquivo devolve null (começa frio, sem erro)", () => {
    expect(getSession(dir, sessionKey("claude-code", "squad", "nunca-rodou"))).toBeNull();
  });

  test("arquivo corrompido não derruba o dispatch", () => {
    fs.writeFileSync(path.join(dir, "sessions.json"), "{ isto não é json");
    expect(getSession(dir, sessionKey("claude-code", "squad", "s"))).toBeNull();
    // e ainda deve conseguir gravar por cima
    putSession(dir, sessionKey("claude-code", "squad", "s"), "claude-code", "sess-novo");
    expect(getSession(dir, sessionKey("claude-code", "squad", "s"))).toBe("sess-novo");
  });

  test("JSON válido mas com forma errada (array) é tratado como vazio", () => {
    fs.writeFileSync(path.join(dir, "sessions.json"), "[1,2,3]");
    expect(getSession(dir, sessionKey("claude-code", "squad", "s"))).toBeNull();
  });

  test("runtime que não devolve session id não grava nada", () => {
    // gemini-cli não expõe id; a entidade simplesmente segue começando fria.
    putSession(dir, sessionKey("gemini-cli", "squad", "s"), "gemini-cli", null);
    expect(fs.existsSync(path.join(dir, "sessions.json"))).toBe(false);
  });
});

describe("session-store — ciclo de vida", () => {
  test("dropSession remove só a chave alvo", () => {
    const a = sessionKey("claude-code", "squad", "a");
    const b = sessionKey("claude-code", "squad", "b");
    putSession(dir, a, "claude-code", "sess-a");
    putSession(dir, b, "claude-code", "sess-b");
    dropSession(dir, a);
    expect(getSession(dir, a)).toBeNull();
    expect(getSession(dir, b)).toBe("sess-b");
  });

  test("dropSession de chave inexistente é no-op", () => {
    putSession(dir, sessionKey("claude-code", "squad", "b"), "claude-code", "sess-b");
    dropSession(dir, sessionKey("claude-code", "squad", "fantasma"));
    expect(getSession(dir, sessionKey("claude-code", "squad", "b"))).toBe("sess-b");
  });

  test("regravar atualiza o id e conta os resumes", () => {
    const k = sessionKey("claude-code", "employee", "cco");
    putSession(dir, k, "claude-code", "sess-1");
    putSession(dir, k, "claude-code", "sess-2");
    expect(getSession(dir, k)).toBe("sess-2");
    const store = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
    expect(store[k].resumes).toBe(1);
  });
});
