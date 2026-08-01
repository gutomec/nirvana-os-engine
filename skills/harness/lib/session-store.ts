// session-store.ts — reuso de sessão por entidade, dentro de um projeto.
//
// PROBLEMA: cada dispatch abre sessão fria. A mesma empresa chamada duas vezes
// no mesmo projeto reconstrói do zero o que já sabia — e um agente que recomeça
// frio não é o mesmo agente, é um novo com o mesmo prompt. Contexto perdido é
// qualidade perdida, e nenhum orçamento traz de volta o que o agente esqueceu.
//
// ESCOPO: a chave é (projeto, runtime, entidade). Os três importam:
//   - projeto  → a MESMA empresa em outro projeto começa fria, de propósito. É a
//                mesma isolação da memória: o que um projeto aprendeu costuma
//                ser errado para o próximo, e sessão compartilhada vaza viés
//                sem deixar rastro.
//   - runtime  → session id do claude-code não significa nada para o codex.
//                Reusar entre runtimes falha na melhor hipótese, e retoma a
//                conversa errada na pior.
//   - entidade → cada funcionário/squad tem a sua linha de raciocínio.
//
// O arquivo vive no diretório do projeto (`sessions.json`), que é o único lugar
// que o BP5 permite escrever durante um brief.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = "sessions.json";

export type EntityKind = "employee" | "squad" | "business";

interface Entry { session_id: string; runtime: string; updated_at: string; resumes: number }
type Store = Record<string, Entry>;

/** (runtime, kind, slug) → chave estável. Runtime na chave é obrigatório: ids
 *  de sessão não são portáveis entre CLIs. */
export function sessionKey(runtime: string, kind: EntityKind, slug: string): string {
  return `${runtime}:${kind}:${slug}`;
}

function storePath(projectDir: string): string {
  return path.join(projectDir, FILE);
}

function read(projectDir: string): Store {
  try {
    const raw = fs.readFileSync(storePath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    // Arquivo corrompido não pode derrubar um dispatch: trata como vazio e o
    // run segue frio, que é degradação, não falha.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Store;
  } catch { /* ausente ou ilegível → vazio */ }
  return {};
}

/** Sessão anterior desta entidade neste projeto, ou null para começar fria. */
export function getSession(projectDir: string, key: string): string | null {
  const e = read(projectDir)[key];
  return e && typeof e.session_id === "string" && e.session_id ? e.session_id : null;
}

/** Grava a sessão devolvida pelo run. No-op quando o runtime não devolve id
 *  (o gemini-cli, por exemplo) — nesse caso a entidade simplesmente segue
 *  começando fria, sem erro. */
export function putSession(projectDir: string, key: string, runtime: string, sessionId: string | null): void {
  if (!sessionId) return;
  const store = read(projectDir);
  const prev = store[key];
  store[key] = {
    session_id: sessionId,
    runtime,
    updated_at: new Date().toISOString(),
    resumes: (prev?.resumes ?? 0) + (prev ? 1 : 0),
  };
  try {
    // EEXIST tolerado: no Windows o Bun lança mesmo com recursive:true.
    try { fs.mkdirSync(projectDir, { recursive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
    fs.writeFileSync(storePath(projectDir), JSON.stringify(store, null, 2));
  } catch { /* não conseguir gravar não invalida o trabalho já feito */ }
}

/** Descarta a sessão de uma entidade — usado quando um resume falha, para que a
 *  próxima tentativa não repita o mesmo id inválido. */
export function dropSession(projectDir: string, key: string): void {
  const store = read(projectDir);
  if (!(key in store)) return;
  delete store[key];
  try { fs.writeFileSync(storePath(projectDir), JSON.stringify(store, null, 2)); } catch { /* idem */ }
}
