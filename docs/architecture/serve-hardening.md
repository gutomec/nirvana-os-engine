# Operação do `nrv serve` com segredos

**Status:** existente
**Idioma:** PT-BR

O `nrv serve` recebe briefs por HTTP e os executa como `nrv dispatch --auto --exec` em processo filho, dentro de um diretório de sessão que o próprio servidor cria. O agente despachado é um runtime completo (Claude Code, Codex, Gemini CLI…) com shell: ele lê o que o usuário do processo lê e vê o que o ambiente do processo carrega. A pergunta de operação é, portanto, uma só: **o que o usuário e o ambiente do servidor conseguem alcançar?** O que está fora desse alcance não chega ao agente por pedido nenhum no brief; o que está dentro é o que as camadas abaixo restringem.

O caso concreto que motivou esta página: o projeto em que o agente trabalha tem um `.env` que o agente não pode ler, e um brief pode pedir exatamente o conteúdo desse arquivo. Três camadas respondem, em ordem de força.

## 1. O arquivo não está ao alcance (a garantia)

Um segredo que o processo não consegue abrir não vaza. Isso é propriedade do sistema operacional, e o engine não tem como substituí-la.

- **Um uid para o `nrv serve`, outro para a aplicação.** O `.env` do projeto pertence ao usuário da aplicação, com modo `0600`. O `nrv serve` roda como `nirvana`, e o agente que ele despacha herda esse uid. `cat .env`, `python -c "open('.env')"`, um symlink esperto: tudo termina em `EACCES`.
- **A sessão não contém o `.env`.** O agente trabalha em `~/.nirvana/serve/sessions/<id>/`, um diretório que o servidor cria. O que entra ali é o que o operador põe (um checkout do projeto sem os arquivos de ambiente, um `git clone` que respeita o `.gitignore`). Nunca aponte uma sessão para o diretório vivo da aplicação.
- **Sem `sudo`, sem `docker.sock`, sem chaves SSH no home de `nirvana`.** Qualquer um desses é uma ponte para fora do uid.

Unidade systemd de exemplo (lida contra a documentação do systemd; não executada nesta máquina, que é macOS):

```ini
[Unit]
Description=Nirvana-OS control plane (nrv serve)
After=network-online.target
Wants=network-online.target

[Service]
User=nirvana
Group=nirvana
WorkingDirectory=/home/nirvana
Environment=PATH=/home/nirvana/.bun/bin:/home/nirvana/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NIRVANA_SERVE_CHILD_ENV=declared
# A credencial do runtime é lida pelo systemd (root). O arquivo é root:root 0600:
# o usuário nirvana nunca o abre, só recebe a variável.
EnvironmentFile=/etc/nirvana/serve.env
ExecStart=/home/nirvana/.local/bin/nrv serve --port 7777
Restart=on-failure

# Isolamento do sistema de arquivos
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=tmpfs
BindPaths=/home/nirvana
InaccessiblePaths=/srv/app/.env
```

`ProtectHome=tmpfs` esconde todos os homes e `BindPaths=` devolve só o de `nirvana`; `InaccessiblePaths=` cobre o `.env` da aplicação mesmo que a propriedade do arquivo esteja errada um dia. Em vez de `EnvironmentFile=`, o login por arquivo do runtime (`claude login` feito uma vez como `nirvana`) dispensa a variável no ambiente.

## 2. O ambiente do filho é uma lista, não uma cópia

Até a 0.13.13 todo filho recebia o `process.env` inteiro do servidor. Um agente com shell tinha `printenv`, e com ele cada credencial do operador que iniciou o serviço, precisasse ou não.

O `nrv serve` agora despacha com `execution.child_env = declared`: o filho recebe

- a base que o sistema e as ferramentas precisam (`PATH`, `HOME`, `LANG`, `TERM`, proxies, certificados…);
- o escopo do engine (`NIRVANA_*`, `HARNESS_*`);
- as credenciais do runtime que vai executar (`ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` para o Claude Code, `OPENAI_API_KEY` para o Codex, e assim por diante; sem runtime fixado, as de todos, porque a cascata escolhe depois);
- as `env_vars` que os squads instalados declaram em `dependencies.yaml`, lidas do registry;
- o que `NIRVANA_CHILD_ENV_EXTRA=NOME_A,NOME_B` acrescentar.

Tudo o mais fica ausente. O filho recebe `NIRVANA_CHILD_ENV=declared` e filtra os próprios filhos do mesmo jeito. `NIRVANA_SERVE_CHILD_ENV=inherit` restaura a forma antiga para o servidor; fora do `serve`, o padrão local continua `inherit` e `nrv config set execution.child_env declared` liga a lista em qualquer despacho.

O que essa camada não faz: esconder do agente a credencial do runtime que o executa. O processo precisa dela para existir. A mitigação é uma chave dedicada ao servidor, com teto de gasto no painel do provedor, e rotação.

## 3. Nada sai com um segredo (o portão de saída)

Mesmo com as duas camadas acima, um agente pode ecoar num arquivo o valor de uma variável que ele legitimamente recebeu. O portão de qualidade cobre esse caso, e o servidor cobre o que o portão não alcança.

- **Rubrica `secret-leak`** em todo artefato de texto (`.md`, `.txt`, `.json`, `.yaml`, `.html`, `.css`, código). Se o artefato contém o **valor** de um segredo que a máquina conhece (uma variável de nome credencial no ambiente do processo, uma linha de `.env` do projeto ou do engine), a rubrica falha, a entrega é retida e o veredito nomeia a **variável**, nunca o valor. Conteúdo que só **parece** credencial (bloco de chave privada, prefixo de token de fornecedor, despejo de linhas `CHAVE=valor`) passa com reserva, porque documentação e `.env.example` têm essa forma de propósito.
- **Redação na saída do `nrv serve`.** O envelope (`summary`, `reservations`), o stream de eventos e o download de artefatos de texto saem com valores conhecidos mascarados como `[redacted:NOME]` e formas de credencial como `[redacted:tipo]`. O cabeçalho `X-Nirvana-Redactions` diz quantas máscaras foram aplicadas a um artefato. Binários saem como estão.

O gate nunca é pulado: a rubrica roda no mesmo caminho das outras e o `gate_passed` continua sendo a prova de entrega.

## O que o `nrv init` faz no projeto

Para quem trabalha com o Claude Code no próprio projeto, sem `serve`, o `nrv init` grava em `<projeto>/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)"] } }
```

A gravação é uma mescla idempotente: o que o projeto já tinha em `permissions` fica, uma regra presente não é duplicada, e um `settings.json` inválido é deixado como está com um aviso. A regra vale sem confiança de pasta e é a primeira camada, não a garantia: o shell tem muitas formas de ler um arquivo, e a propriedade do arquivo continua sendo o que decide.

## Efeito na entrega

Nenhum, para o trabalho legítimo. Um agente que precisa de uma chave declarada a recebe; um agente que precisa da base do sistema a tem; um artefato que não carrega segredo passa como antes. O que muda é o resultado de um brief que pede o conteúdo de um `.env` fora de alcance: a resposta honesta é "não tenho acesso a esse arquivo", e o engine agora prova que essa resposta é a única possível.
