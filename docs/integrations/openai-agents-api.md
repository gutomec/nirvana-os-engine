# Nirvana-OS na OpenAI Agents API

**Status:** parcialmente verificado. Medido nesta máquina em 19/09/2026 contra a
Agents API em beta, com `codex-cli 0.153.4` e engine 0.13.18.

A Agents API declara compatibilidade com o padrão Agent Skills, e a `nirvana` é
uma skill desse padrão. Então a pergunta não é se ela cabe, é o que de fato foi
observado funcionando ponta a ponta. Esta página separa as duas coisas e nomeia
o que ainda bloqueia.

## O que foi verificado

| Item | Resultado |
|---|---|
| Endpoint de criação de sessão | `POST https://api.openai.com/v1/agents/sessions` com o header `OpenAI-Beta: agents=v1` → **201**. Os SDKs expõem o mesmo como `client.beta.agents.sessions.create`. |
| Sessão self-hosted aceita | `environment.type: "self_hosted"` com `workspace_directory` e `capability_directories` absolutos → aceito, com `environment.id` e `environment.remote_url` devolvidos. |
| Diretório de capability aceito | `["/Users/<user>/nirvana-spike/capabilities"]`, contendo só `nirvana/`, volta intacto no corpo da sessão. |
| Tamanho da skill contra os tetos | 5 arquivos e 44 KB. Os tetos publicados são 500 arquivos por versão de skill e 25 MB descompactados. Folga de duas ordens de grandeza. |
| Limite de diretórios | 32 por sessão. A `nirvana` é **uma** entrada, então um diretório basta. |
| `agents/openai.yaml` | Embarca na skill desde a 0.13.10 e é instalado junto. Carrega `interface.display_name`, `short_description`, `default_prompt` e `policy.allow_implicit_invocation`. |

## O que ainda NÃO foi verificado

Nada abaixo foi observado. Não é "deve funcionar": é não medido.

| Item | Por que não |
|---|---|
| Descoberta da skill pelo harness | O executor nunca conectou (ver o bloqueio). Sem ambiente conectado o agente não começa. |
| Um turno de discovery (`nrv list-businesses`) | idem |
| Um despacho com cadeia em `audit.jsonl` | idem |
| Cold-start só com a skill fina | idem |
| Se o Codex lê `agents/openai.yaml` sem aviso | idem |
| Se a descoberta é recursiva abaixo do diretório registrado | A doc mostra um nível (`<capability_dir>/<skill>/SKILL.md`); mais fundo não foi testado. |

## O bloqueio, com precisão

O executor exige uma **chave de ambiente separada**, e ela não sai por API.

```
$ codex exec-server --remote "<remote_url>" --environment-id "<env_id>"
Error: environment registry authentication error:
       environment registry authentication failed (403 Forbidden):
       missing required scope api.agents.environments.connect
```

A chave de aplicação (`OPENAI_API_KEY`) não tem esse escopo e não pode ganhá-lo:
ela cria a sessão (201) e lista sessões (200), mas registrar um ambiente é outro
escopo. O caminho alternativo que o CLI documenta também está fechado nesta
máquina:

```
$ codex exec-server … --use-agent-identity-auth     # lê CODEX_ACCESS_TOKEN
Error: Agent Identity authentication is unavailable
```

E não há endpoint para emitir a chave: `/v1/agents/environment_keys` responde
404, `/v1/organization/projects` exige `api.management.read`.

**O passo que falta é de navegador.** Em
`platform.openai.com/agents?tab=environments&environment_view=keys`, criar uma
chave de ambiente na mesma organização, projeto e conta que é dona da sessão,
com todas as outras permissões em **None**. Depois:

```bash
export CODEX_API_KEY="<a chave de ambiente>"
codex exec-server --remote "<remote_url>" --environment-id "<env_id>"
```

A doc é explícita sobre a separação: a chave de ambiente fica DENTRO do sandbox
e só serve para conectar ambientes; a `OPENAI_API_KEY` da aplicação fica fora.
Código gerado pelo agente consegue ler a chave de ambiente, e é por isso que ela
não pode autorizar mais nada.

## Como montar, quando a chave existir

Um diretório de capability contendo **apenas** a `nirvana`. Apontar para uma raiz
de skills compartilhada mistura a medição com tudo o que mora lá.

```bash
SPIKE=~/nirvana-spike
mkdir -p "$SPIKE/workspace" "$SPIKE/capabilities"
cp -R ~/.nirvana/skills/nirvana "$SPIKE/capabilities/nirvana"
nrv init "$SPIKE/workspace"
```

Nunca registrar `~/.nirvana/skills` como diretório de capability: a raiz contém
`node_modules` apontando para a loja de dependências compartilhada, e o loader de
skills do Codex percorre symlinks e desiste ao cruzar 20.000 entradas.

```json
{
  "agent": { "model": "gpt-6-astra", "instructions": "…" },
  "environment": {
    "type": "self_hosted",
    "workspace_directory": "/Users/<user>/nirvana-spike/workspace",
    "capability_directories": ["/Users/<user>/nirvana-spike/capabilities"]
  }
}
```

Requisitos do campo, pela doc: caminhos absolutos, únicos, sem `.` nem `..`,
apontando para diretórios que já existem no ambiente, no máximo 32 por sessão.

Rede de saída necessária: `https://api.openai.com` para registrar o ambiente e
`wss://codex-cloud-environments.chatgpt.com` para comandos e resultados. Todas as
conexões partem de dentro.

Para o agente enxergar o `nrv`, o executor precisa herdar o PATH:

```bash
codex exec-server --remote … --environment-id … \
  -c shell_environment_policy.inherit=all
```

Mandar trabalho é um evento na sessão, não um endpoint próprio:

```
POST /v1/agents/sessions/{session_id}/events
{ "events": [ { "type": "agent.session.input.message",
                "input": [ { "role": "user",
                             "content": [ { "type": "input_text", "text": "…" } ] } ] } ] }
```

O stream da sessão reporta `agent.session.environment.pending`, `.connected` e
`.failed`. O agente só começa quando o ambiente está conectado **e** existe
entrada do usuário.

## Uma correção ao plano original

O roteiro escrito em setembro mandava afirmar a descoberta de quatro skills
(`nirvana`, `harness`, `squads`, `businesses`). Isso deixou de valer na 0.13.10:
`RUNTIME_ENTRIES = ["nirvana"]`, e `harness`, `squads`, `businesses` e `_shared`
são internos do engine em `~/.nirvana/skills`, nunca expostos a um runtime. O
critério certo é **uma** skill descoberta, e a partir dela o caminho absoluto
para o harness.

## O que a skill faz quando o engine não está lá

A `nirvana` não carrega o engine. Num ambiente novo ela roda o próprio
`scripts/bootstrap.sh` (ou `.ps1`), que garante o Bun em espaço de usuário, baixa
o tarball da release e chama o instalador oficial. `--dry-run` imprime a lista de
mudanças sem tocar em nada. Num sandbox sem rede de saída para `bun.sh` e para o
GitHub, isso não acontece, e aí a skill responde discovery e nada mais — o que é
o comportamento certo, não uma falha.
