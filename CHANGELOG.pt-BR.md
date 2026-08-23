# Changelog

**Read this in your language:** [English](./CHANGELOG.md) · [Português](./CHANGELOG.pt-BR.md)

Todas as mudanças relevantes do engine Nirvana-OS. As versões correspondem às
releases no GitHub (`nirvana-os-engine`); cada release publica o tarball completo
do engine que o `npx @nirvana-os/cli` e as instalações de pack consomem.

## 0.7.11 — 2026-08-23

### O engine mandava os runtimes vigiarem, nunca trabalharem

Uma sessão do agy produziu duas falhas silenciosas, e as duas eram do
engine, não do modelo.

Ela respondeu um brief de produção inline. A skill estava linkada e os hooks
instalados, mas tudo que o engine liga naquele runtime é vigilância: dois
hooks de ferramenta emitindo auditoria, e um SessionStart que gravava
`session_started` e saía. A frase que manda um agente carregar o harness
mora dentro do `SKILL.md` — inalcançável para quem ainda não o carregou. O
hook de SessionStart agora fala: injeta o contrato de invocação por
`additionalContext`, em toda sessão de gemini e antigravity, sem escrever em
nenhum arquivo do usuário.

A mesma sessão leu a saída do `nrv doctor`, encontrou um imperativo com um
comando real dentro, e rodou o strip de watermark contra a BIBLIOTECA VIVA —
59 marcadores de atribuição por-comprador apagados de `~/squads` e
`~/businesses`, que não se regeneram a partir dos arquivos. Texto de
diagnóstico é lido por agentes, e um imperativo num diagnóstico é uma ordem:
a dica agora descreve o reparo, nomeia a árvore de build como alvo correto e
a biblioteca como a que nunca se toca, e o contrato injetado diz com todas as
letras que comando destrutivo impresso por diagnóstico é descrição, não
ordem. O script de strip no repo dos packs recusa a biblioteca viva sozinho.

E host não identificado deixou de significar um fornecedor.
`detectCurrentHost() ?? "claude-code"` levava em silêncio todo runtime que
não exporta marcador de sessão para a cota de outro, desfazendo uma cadeia de
precedência que estava correta. Falha de detecção agora é anunciada no
stderr, auditada como `x_host_runtime_undetected`, e resolvida por
`NIRVANA_DEFAULT_RUNTIME` ou pelo primeiro runtime realmente instalado —
nunca por um nome chumbado.

Um teste da mesma área lia a máquina do desenvolvedor: o caso "um HOME sem
~/.claude nunca ganha um" herdava o PATH real, então passava no CI só porque
não existe binário `claude` no runner, e contradizia a regra dos dois sinais
em qualquer máquina onde o runtime está de fato instalado. Agora ele fixa o
PATH nos utilitários do sistema e afirma sobre a fixture.

## 0.7.10 — 2026-08-23

### `nrv activate` — a porta que nunca teve maçaneta do lado de fora

Squads declaram o que precisam em `dependencies.yaml`: ffmpeg, epubcheck,
bibliotecas Python, download de modelos. Instalar isso só era alcançável
como caminho de script cru, invisível ao `nrv --help`, um squad por
invocação. Pedido para "ativar todos os squads e instalar as dependências",
um agente rodou o help, não achou nada, fez grep no filesystem para
localizar o script, e começou a percorrer 107 squads na mão. Ele não estava
perdido — procurava uma porta sem maçaneta do lado de fora.

`nrv activate <slug>` é essa maçaneta, e `nrv activate --all` é o lote que o
caso do tamanho da biblioteca sempre exigiu: um squad por vez, sem parar na
primeira falha, com um resumo que separa pronto de precisa-confirmar de
falhou e um exit code que agrega o contrato por squad. `--only-declared`
pula squads que não precisam de ativação; `--dry-run` mostra o plano. E
porque a ativação é advisória — nada bloqueia um dispatch, então uma
ferramenta ausente mata a execução no meio, depois do dispatch já pago — o
`nrv doctor` agora avisa quando uma ferramenta declarada não está na PATH,
nomeando a ferramenta, quantos squads a querem e o comando que resolve.

## 0.7.9 — 2026-08-22

### De onde vem a inteligência não é onde os arquivos nascem

O primeiro corte do `nrv serve` criava toda sessão com
`NIRVANA_SCOPE=project`, confundindo duas decisões que precisam ficar
separadas: a BIBLIOTECA da sessão (para quais empresas, squads e clones um
brief pode rotear) e os ARQUIVOS dela (logs, outputs, estado de run). A
biblioteca jamais pode nascer com escopo de projeto — uma sessão que começa
cega manda todo brief para o generalista.

Uma sessão global (o padrão) agora inicializa com `merge`: a biblioteca do
operador resolve, entradas do projeto vencem em conflito, e os artefatos
continuam nascendo dentro da sessão. Sessões isoladas mantêm a fonte
só-do-projeto que um host multi-tenant precisa. Em ambos os casos o servidor
fixa `HARNESS_LOGS_DIR` e `NIRVANA_PROJECT_ROOT` na sessão, então apontar
`NIRVANA_SERVE_SESSIONS_ROOT` para um volume montado coloca outputs, logs e
estado de todos os chamadores nesse volume.

## 0.7.8 — 2026-08-22

### O gate finalmente cobre PDF

PDF é um dos formatos de entrega mais comuns e o gate automático nunca o
via: `.pdf` não era gateável, então uma entrega só-PDF saía INDETERMINATE —
a primeira execução de campo a notar precisou gatear à mão com qpdf e emitir
`x_quality_gate_tooling_gap`. A nova rubrica `pdf-valid` fecha a metade
estrutural: header, trailer `%%EOF`, piso de stub, e contagem de páginas via
qpdf ou pdfinfo quando presentes — caindo para um passe declarado-como-não-
verificado em PDFs com object streams comprimidos, em vez de reprovar pela
regex ingênua que os lê como zero páginas. Verificada ao vivo contra o
próprio entregável da execução de campo (2 páginas, 4 MB), com e sem
ferramentas na PATH.

### `nrv serve` — o protocolo sobre HTTP

A API é a quarta projeção do protocolo (grafo, glance, CLI, HTTP) e um plano
de controle por construção: uma sessão É um diretório de projeto, um brief
vira um `nrv dispatch --auto --exec` filho, e toda resposta lê o que o
engine já escreveu — run ledger, log de auditoria, árvore de outputs.
Nenhum segundo executor, nunca.

`nrv serve keygen` cria chaves cujo orçamento e cota diária são atributos DA
CHAVE, jamais entrada do cliente; o servidor sobe em 127.0.0.1 salvo ordem
contrária, recusa rodar como root, e devolve artefatos apenas de dentro do
outputs root do run (traversal, codificado ou não, é recusado). O envelope
carrega o veredito do gate e promove `_SUMMARY.md` e `_QA-RESERVATIONS.md` a
campos, então uma entrega aceita com ressalvas chega honesta. `/events`
transmite o log de auditoria do projeto por SSE. Reiniciar o servidor não
orfana mais trabalho: cada run persiste ao lado dos artefatos e é
reidratado na consulta.

Uma sessão declara para qual biblioteca seus briefs podem rotear: `global`
(o padrão) enxerga as empresas, squads e clones do operador — sem isso todo
brief cai no generalista, como a primeira execução ao vivo mostrou — e
`isolated` mantém o escopo só-do-projeto que um host multi-tenant precisa.
O `/v1/health` também reporta consumo de seats, porque hoje uma frota de
workers de API consome um seat de licença por host. Guia completo:
`references/06-api.md`.

## 0.7.7 — 2026-08-22

### Sessões headless morrem com o turno — o protocolo agora diz isso

Verificado em campo numa VPS: um maestro headless (`claude -p`) lançou a fase
1 como subagente em background, escreveu "vou aguardar a notificação",
encerrou o turno — e o processo saiu, orfanando o filho. As imagens ficaram,
a fase do PDF nunca começou. Sessão interativa nunca mostra isso, e é
exatamente por isso que sobrevive até um cron ou systemd quebrar. A diretiva
autônoma injetada em toda execução headless agora carrega a regra de vida da
sessão (delegue sincronamente ou execute a fase você mesmo; encerrar o turno
com trabalho em voo é abandono, não paciência), e o protocolo do harness
delimita o contrato de dispatch em background às sessões interativas,
roteando contextos headless para o caminho scriptado síncrono.

## 0.7.6 — 2026-08-21

### A ativação de squad para de mentir duas vezes

Verificado em campo numa VPS: o `activate-squad.ts` assumia que o JSON do
activator tinha sido transmitido ao vivo, mas o helper de exec só transmite
com NIRVANA_VERBOSE=1 — toda execução normal capturava o JSON e não imprimia
nada, então quem chamava lia um stdout vazio. A saída capturada agora é
reproduzida. E o contrato de exit code sempre prometeu "2 = confirmações
necessárias (instalações pesadas / sudo)" sem que nada detectasse sudo: uma
execução sem privilégio de um comando de instalação com sudo agora vira item
confirmation_required (exit 2, consentido via --confirm-heavy), e execução
como root remove o prefixo sudo (containers mínimos não têm o binário sudo).
Dois testes fixam ambos.

## 0.7.5 — 2026-08-21

### O gate aprende que "todo" é português

A regex de placeholder da heurística de correção carregava /i, então o
marcador TODO casava com a palavra portuguesa "todo" — qualquer prosa PT-BR
densa pontuava como cheia de placeholders, e o check de estrutura ignorava
pseudo-headings em negrito e listas, punindo briefs que proíbem headings.
Relato de campo de uma VPS: gate_failed → x_correctness_override auditado →
gate_passed. Os marcadores agora são casados como as convenções maiúsculas
que são (as formas com colchete [INSERT/[FILL seguem case-insensitive),
pseudo-headings e listas contam como estrutura, e seis testes novos fixam o
comportamento com fixtures PT-BR reais.

## 0.7.4 — 2026-08-21

### Correções de instalação: as falhas silenciosas que compradores realmente sofrem

Duas classes de "instalei e nada funciona, sem nenhum erro" foram fechadas.

No Windows, o idioma `where bun >nul 2>nul` dos wrappers `.cmd` só é seguro
dentro do cmd.exe; interpretado pelo PowerShell, pelo shell do Bun ou por
caminhos adjacentes ao OneDrive, ele materializa um arquivo literal, quase
indeletável, chamado `nul`. Os 17 wrappers e os dois geradores de launcher
agora usam `where /q` (sem nenhum redirecionamento), um gate de fonte impede
o idioma de voltar, e o `nrv doctor` detecta máquinas já mordidas e imprime o
comando de remoção.

A linkagem de runtimes agora sonda dois sinais — diretório home OU binário na
PATH — em vez do diretório sozinho, que pulava em silêncio runtimes recém
instalados via npm cujo diretório só nasce no primeiro uso (OpenClaw: binário
presente, `~/.agents` ausente, link nunca criado). O instalador agora cria o
diretório, reporta cada runtime como linkado ou pulado COM o motivo, e
imprime os fatos de invocação do OpenClaw que o runtime não ensina (sem
contrato de projeto; invocar com `/harness`). O `nrv doctor` ganha uma linha
`skills link:` por runtime detectado.

### O loop de QA agora termina em entrega

Um agente que reprovava no gate de qualidade podia revisar, reprovar e
revisar para sempre. O teto de tentativas agora é 15 por padrão
(`NIRVANA_MAX_GATE_RETRIES`, configurável via `.env` do projeto), e ao
atingi-lo a última tentativa é aceita COM RESSALVAS: um `_QA-RESERVATIONS.md`
fica ao lado dos artefatos explicando exatamente o que o gate ainda aponta —
e que o próprio julgamento do QA pode ser o lado errado — enquanto a
auditoria registra `x_delivered_with_reservations`.
`NIRVANA_GATE_EXHAUSTED=withhold` restaura a retenção estrita fail-closed. O
teto de completude continua acima da aceitação, e o sweep não assistido do
supervisor permanece estrito.

## 0.7.3 — 2026-08-20

### O engine aprende o que se relaciona com o quê

Um grafo de dependências tipado das próprias entidades — derivado do modelo
de grafo do PR #41 de @marciobisognin, com crédito — entra no engine como
álgebra pura (`skills/_shared/lib/dependency-graph.ts`): quais arestas são
legais (uma empresa possui employees, um employee incorpora um mind-clone),
quais grafos são ciclos, e em que ordem as coisas precisam existir. O grafo é
sempre reconstruído das declarações em prosa; nada persistido vira segunda
fonte de verdade.

Três consumidores chegam com ele. O instalador agora deposita o conteúdo em
ordem de dependência (squads → mind-clones → businesses; a ordem legada
instalava businesses primeiro) e nomeia cada dependência ausente —
`dependency missing: mind-clone 'x' required by <business>/<employee>` — em
vez de degradar em silêncio. `nrv graph closure --business <slug>` responde
exatamente "o que a execução desta business precisa", com clones ausentes
sinalizados (a resolução que achava 5 dos 17 clones do tracking-360 por grep
agora devolve 17 de 17 por declaração). E um compilador de grafo-de-plano
emite o manifest multi-target padrão, então um plano desenhado executa pelo
mesmo loop de dispatch, gates e cadeia de auditoria de qualquer outra
execução — nunca por um segundo executor.

## 0.7.2 — 2026-08-19

### O cargo fica de pé sozinho, e o sistema finalmente enxerga isso

O modelo de clone por tarefa (0.7.0) tornou "nenhum clone" um desfecho
legítimo de qualquer despacho — o que faz do corpo do employee o método
inteiro do cargo. Até agora nada lia um byte dele: o loader analisa só o
frontmatter, o audit conferia que o frontmatter existe, e o portão de vínculos
lê dois campos. Um rótulo de cargo com 2 linhas pontuava igual a um manual de
operação com 260 em todos os portões do sistema.

A régua nova — seções mais conteúdo de decisão, nunca contagem de linhas — foi
calibrada contra os 574 employees da biblioteca de autoria: 488 arquivos ricos
passam com zero alarmes falsos, e dos 86 curtos só 28 são rasos de verdade; os
outros 58 carregam método real em poucas linhas e passam. Três consumidores a
aplicam: um portão-ratchet (assento que o registro nunca viu entra suficiente
ou não entra; a dívida registrada só encolhe), o portão de admissão dos packs,
e um critério novo no audit de empresas que nomeia os assentos rasos e aponta
o reparo.

### Os próprios templates do engine produziam assento raso por construção

Os 16 scaffolds de employee declaravam `role: CEO` — o antagonist, os
directors e os advisors carregavam o corpo do CEO solo copiado, então uma
agência recém-inicializada era cinco cópias do mesmo assento. Cada template
agora carrega o método do próprio cargo: o antagonista com critérios numerados
de rejeição e regra de veredito explícito (o antigo "silêncio após crítica
aprova" foi invertido — silêncio bloqueia), o CEO de conselho sintetizando
dissenso em vez de tirar média, o CEO de holding que aloca e nunca executa,
CEOs de unidade com contratos de interface. A frase do Business Protocol que
autorizava corpo raso ("o corpo do employee é curto; o arquivo de DNA fornece
o substrato") foi emendada: no modelo por tarefa o assento não pode assumir o
clone, então corpo curto só é legítimo quando passa na régua — e a criação de
empresas ganha o portão de script blocante para isso, ao lado do de roteamento
que já existia.

## 0.7.1 — 2026-08-19

### Adotar o Nirvana pergunta antes de mudar um projeto existente

`nrv init` num projeto que já tinha AGENTS.md anexava o contrato de invocação
a ele e criava CLAUDE.md e GEMINI.md com o mesmo conteúdo — todo agente do
repositório passava silenciosamente a tratar o Nirvana como orquestrador
padrão. É o default certo para projeto novo e uma mudança silenciosa
significativa para um projeto já configurado (relato de campo, 18/08/2026).

O modo agora é escolha do dono: `--orchestrators=always` mantém o
comportamento histórico; `--orchestrators=on-demand` adiciona uma única nota
marcada — o Nirvana existe, age só quando pedido explicitamente — e não toca
em mais nada. Num terminal, com arquivos de instrução preexistentes e sem
flag, o init pergunta e recomenda on-demand. Execução não-interativa sem flag
mantém "always": CI e scripts não mudam.

### O .env prometido agora existe, e o sumiço dele foi explicado

Toda instalação saía sem o `project-skeleton/.env`, enquanto o tarball do
engine carrega uma allowlist esperando exatamente esse caminho. A causa era o
.gitignore do próprio repositório: os padrões `.env` e `.nirvana/` engoliam os
templates em silêncio — eles existiam na máquina do autor e nunca chegaram ao
repositório. Regras de negação agora os fixam como arquivos de produto; um
fallback gerado mantém a promessa em instalações que ainda não têm o template;
e o `--scope=project|merge`, que quebrava no arquivo ausente com um stack de
ENOENT cru, falha com erro nomeado. O `project-skeleton/.nirvana/README.md`
foi restaurado do mesmo jeito.

### O log para de gritar lobo no Windows

Todos os níveis de log escreviam em stderr, e o PowerShell pinta stderr de
vermelho — um `nrv init` saudável aparecia como uma parede de "erros"
vermelhos, linhas [ok] incluídas. Progresso (info/ok) agora vai para stdout;
avisos são stderr em amarelo; falhas são stderr em vermelho. Corrigido no
logger compartilhado, então todo comando herda. Os dois anexos de contrato
também pararam de dividir uma mensagem só: o log agora diz se quem entrou foi
o contrato de invocação ou o de escrita.

### O doctor reporta todos os runtimes que o engine despacha

O `nrv doctor` sondava 3 dos 9 runtimes de agente que o driver de dispatch
suporta, a partir de uma cópia privada da lista — grok, pi, agy, kimi, qwen e
opencode nunca apareciam, mesmo instalados. A lista agora é exportada pelo
próprio driver (`listRuntimes()`) e o doctor a percorre: uma linha por
runtime, WARN quando ausente, mais um resumo `runtime: dispatch` que é PASS
com pelo menos um runtime no PATH — e FAIL com zero numa máquina de usuário,
onde o dispatch genuinamente não roda (um runner de CI sem interface reporta o
mesmo fato como aviso).

### O portão de packs publicados lê a página que o comprador lê

O `check-published-packs` comparava o bucket com o arquivo de catálogo no
disco — e aprovou um dia em que o deploy da loja nunca chegou, deixando a
página anunciando a composição anterior em seis idiomas. Agora ele também
busca a página viva do produto e exige que ela carregue a versão e as
contagens do catálogo.

## 0.7.0 — 2026-08-18

### O clone é escolhido para a tarefa, não para o cargo

Um mind-clone é conhecimento, não ator. Duas partes do despacho fingiam o
contrário, e as duas mudam aqui.

A cadeia do employee tinha um passo DESIGNADO: `assigned_mind_clones` era
injetado sem nenhum teste de adequação, antes de o ranking da tarefa rodar. Um
cargo de diretor de cinema amarrado a um diretor recebia esse diretor para toda
tarefa, enquanto o diretor de que a tarefa precisava aparecia só como sugestão
abaixo, com o orçamento de injeção já gasto. A cadeia agora tem três degraus —
clone que o usuário nomeia vence de imediato; senão a biblioteca é ranqueada
contra a tarefa e só entra quem passa do gate de cobertura; senão o agente
decide, e "nenhum" é resposta legítima que vem com um dever: o cargo executa
com o próprio método. Só 74 de 574 employees carregavam vínculo estático — os
outros 87% já viviam nesse mundo. A curadoria do cargo sobrevive como prosa na
persona, onde o agente a lê como contexto em vez de recebê-la por cima do
ranking.

A escolha agora fica registrada. Todo run de employee emite um evento
`x_clone_choice` — os slugs escolhidos ou uma lista vazia, com uma linha de
porquê — para o sistema aprender qual DNA de fato ganha qual tarefa, em vez de
só registrar o que foi injetado.

E a linha final de identidade para de mentir: "channeling the mind-clones
above" só aparece quando há clones acima. Sem nada canalizado, o prompt agora
diz isso — a mesma classe de defeito que o 0.6.2 corrigiu uma seção acima.

### `delegates_to` foi aposentado

Clone não delega. O campo congelava "quem era o vizinho certo" contra uma
biblioteca específica e quebrava em todo subconjunto: medido nos dezesseis
packs, 805 ponteiros de handoff embarcaram apontando para clones que o pack não
carrega — 128 de 223 no flagship — enquanto nenhum caminho de código consumia o
campo. A indicação vive onde o contrato sempre a colocou: na prosa do `not_for`
("o que ele não faz, e quem faz"). Nome em prosa degrada para a busca viva por
tarefa, que responde contra a biblioteca que o usuário de fato tem. Contratos,
template de clone, pipeline de criação e o gerador de enriquecimento param de
escrever o campo; as 2.174 listas existentes em disco são ignoradas, não
apagadas — nenhuma edição em massa, nenhuma perda de dado.

### Um despacho, um escopo

`findCloneForTask` e `resolveClonePersona` resolviam o registry de clones pelo
diretório de trabalho do processo, enquanto o mesmo despacho resolvia o
business pelo diretório do projeto — um despacho lendo dois escopos. Numa
máquina cujo checkout do engine carregava um registry derivado, um fixture de
employee recebia clones que nunca escreveu; no CI, sem biblioteca, os mesmos
testes passavam. O projeto do despacho agora ancora a cadeia de clones inteira,
nos dois despachantes (employee-prompt e squad-exec).

## 0.6.2 — 2026-08-16

### O prompt dizia ao agente que não havia clone útil, e listava um a 0.93

Uma empresa embasa o employee num mind-clone. Quando nenhum está declarado, a
busca ranqueia a biblioteca e o agente escolhe — é o desenho, e é o mesmo padrão
agêntico que o roteador usa. O prompt dizia o contrário em três lugares ao mesmo
tempo: o cabeçalho anunciava `DEFAULT — no useful clone`, o corpo mandava operar
sem clone, e três linhas abaixo listava os candidatos sob o título **Other**.

Renderizado contra a biblioteca real, uma empresa de compliance perguntada sobre
um programa de LGPD recebe `bruno-bioni` — a referência brasileira em LGPD
aplicada — a 0.93, logo abaixo da frase dizendo que não existe clone útil. Um
agente que acredita naquela frase nunca abre a lista. Quarenta e três de sessenta
empresas não declaram clone, então era essa a redação que a maioria delas usava.

O sistema ranqueia; o agente decide. Trabalhar sem clone segue sendo desfecho
legítimo, mas é aquele a que se chega quando nenhum serve, não o de onde se parte.

### Um employee ligado a um clone ausente não avisa nada

A ligação é um nome no frontmatter do employee, resolvido contra a biblioteca de
clones. Nada conferia se ele resolve, e a falha é silenciosa por construção: o
employee roda sem a persona para a qual foi escrito e entrega prosa plausível que
parece de qualquer um.

Num pack, isso chega ao comprador. Descoberto ao adicionar uma empresa ao pack
principal — dezessete employees nomeando dezessete clones, cinco deles no pack. O
`check-clone-bindings.ts` agora lê as duas formas de referência, roda contra a
biblioteca viva ou contra o conteúdo de um pack, e gateia tanto o `check:all`
quanto o build. Medido depois: 171 ligações na biblioteca, 116 no principal,
todas resolvendo.

## 0.6.1 — 2026-08-16

### A versão que o usuário lê era a anterior

O `nrv --version` prefere o `skills/VERSION`, um arquivo solto copiado tal e qual
para o diretório de skills instalado; o `package.json` é só o fallback. A release
0.6.0 moveu o `package.json` e o changelog e deixou esse arquivo para trás, então
todo mundo que instalou o 0.6.0 foi informado de que estava no 0.5.2. Nada falhou
e nada avisou — o número estava simplesmente errado para todos os usuários, e só
apareceu porque alguém rodou `nrv --version` na própria máquina depois de
publicar.

O `check-version-parity.ts` compara os três lugares onde o engine declara a
versão e roda dentro do `check:all`, para que uma release não os coloque fora de
sincronia de novo.

## 0.6.0 — 2026-08-15

### Três coisas que falhavam em silêncio, e os portões que agora as pegam

Um id de capability pode ter vários provedores de propósito: nove squads podem
definir uma linguagem visual, e o roteador deve escolher aquele cujo ângulo cabe
no brief. Ele escolhe por BM25 sobre a descrição, as keywords e os
example_briefs de cada provedor. Então, quando dois provedores carregam texto
byte a byte igual, não sobra nada com que escolher — os dois pontuam igual e um
`HIGH` confiante é cara ou coroa.

Duas injeções em massa tinham feito exatamente isso. `media.video.compose` entrou
em dez squads com o texto copiado, e em nove deles sem keyword nenhuma e sem
example_brief nenhum: justamente os dois campos que o índice pesa ×3 e ×2. Três
capabilities `frontend.*` entraram em sete a nove squads do mesmo jeito. Vinte de
setenta instâncias eram indistinguíveis.

Cada provedor agora descreve o próprio ângulo. Um cinemagraph do Veo não é um
corte de podcast nem um tour de imóvel; um dashboard denso de dados não é um site
de scroll cinematográfico. Medido em briefs mantidos fora do índice, escritos do
jeito que uma pessoa de fato digita — palavras que não aparecem em manifesto
nenhum — o roteamento foi de 3/7 para 6/7 acertando o squad com confiança alta, e
o sétimo devolve `AMBIGUOUS` em vez de chutar. Na biblioteca inteira, a avaliação
de regressão se mantém em 98,2% de top-1 sobre 3.366 casos.

O `check-capability-clones.ts` mantém isso, e ele reporta o *texto* idêntico,
nunca o *id* compartilhado. Compartilhar id é o desenho; um portão que acusasse
os 22 ids legitimamente compartilhados seria desligado na primeira semana.

### O doctor parou de escrever o laudo dentro do produto

O `SQUAD-DOCTOR-REPORT.md` era escrito dentro do diretório do squad, então 25
deles estavam nas bibliotecas de conteúdo e outros 18 dentro de artefatos de pack
já construídos — um diagnóstico sobre a máquina do vendedor, entregue ao
comprador, no idioma errado. Como ele carrega um timestamp novo a cada execução,
também fazia duas cópias do mesmo squad discordarem para sempre. Agora ele
escreve em `.nirvana/state/squads/<slug>/`.

### Dois vazamentos de empacotamento, achados inspecionando um build de verdade

`.runs` não estava na lista compartilhada de estado de execução. O `.runs` de um
squad guarda 64 arquivos e 36 MB de render antigo, e estava viajando dentro de
quatro packs. O nome existia em três listas privadas de exclusão e faltava
justamente na única que quatro consumidores leem.

E o builder do pack excluía estado de execução pela lista achatada, cujo primeiro
segmento para uma empresa é `memory` — vindo de `memory/projects`. Ele apagava a
pasta `memory/` inteira, então todo pack entregava suas empresas sem o
`memory/permanent.md`: o arquivo que o protocolo de empresas documenta como o
conhecimento de longo prazo que todo employee lê como contexto autoritativo.
Quarenta e seis empresas, em silêncio. O `isRunStatePath` agora recebe um `kind`
e casa cada entrada como uma sequência contígua de segmentos de caminho.

### Um preflight para briefs de despacho

O `check-brief.ts` lê um brief e confere cada caminho, cada script e cada slug
antes que um agente gaste uma hora seguindo aquilo. Dois briefs saíram nesta
semana citando um script que morava em outro branch e um diretório de squad com
um nome que ele nunca teve; os dois agentes improvisaram e reportaram sucesso
contra o alvo errado. Ele lê caminhos POSIX e Windows, fica calado no que estiver
marcado como `(new)`, e só julga nomes com hífen — três das treze entidades de
uma palavra só são `documentation`, `testing` e `monitoring`.

## 0.5.2 — 2026-08-14

### Idioma, medido onde ele de fato custa

O roteador agêntico é o padrão e lê o digest de roteamento, então ele roteia um
brief em qualquer idioma contra uma entidade declarada em qualquer outro. O modo
`fast` é BM25: ele casa tokens, e um brief e uma entidade escritos em idiomas
diferentes não compartilham nenhum. Medido em 20 pares de paráfrase mantidos fora
do índice — uma intenção escrita duas vezes, com palavras que não aparecem em
manifesto nenhum — a paridade entre idiomas no modo fast é de 25%.

O `fast` agora imprime esse custo quando ele existe: a composição do corpus, o
que isso significa para um casamento léxico, e que `--mode=agentic` não se importa
com o idioma em que você escreve. Uma biblioteca de um idioma só nunca vê o aviso.

O `nrv doctor` reporta a composição do corpus como progresso, não como erro, com
a contagem de entidades que faltam traduzir. Um corpus misto não está quebrado;
está no meio do caminho para um idioma só, e agora há um número para isso.

O `measure-language-parity.ts` é o instrumento por trás dos dois. `--parity`
roteia os pares de paráfrase; `--safety` mostra a paridade ao lado dos negativos
que precisam continuar se abstendo, porque uma mudança pode subir um quebrando o
outro.

Um braço denso multilíngue foi construído, varrido em todos os pisos de cosseno e
removido: a paridade nunca passou dos mesmos 25%. O embedding funciona isolado —
um brief em português contra um documento em inglês dá cosseno 0,697 contra −0,05
de um irrelevante — mas quatro squads reivindicam legitimamente trabalho com
livros em idiomas diferentes, e nenhum recuperador faz dois idiomas concordarem
sobre qual dos quatro escolher. Isso é trabalho de conteúdo, não de motor.

## 0.5.1 — 2026-08-14

### Quatro defeitos que estavam vivos em toda instalação

**A ponte entre idiomas era código morto para todo comprador.** O
`.keyword-aliases.json` era escrito ao lado do digest de roteamento e lido ao
lado do registry de squads. Esses são o mesmo diretório em escopo de projeto e
dois diferentes em escopo global — registry em `~/`, digest em `~/.nirvana/` — e
global é o que toda instalação usa. O arquivo caía onde nada olhava, e um brief
em português contra um squad declarado em inglês nunca recebia o reforço de
cobertura. A ausência é normal por construção, então degradava em silêncio desde
que existe. Agora há uma constante só, `KEYWORD_ALIASES_PATH`, lida pelos dois
lados.

**O `nrv doctor` não sabia que licença existe.** Zero menções em 570 linhas. Na
máquina que originou toda essa investigação ele imprimia "All systems nominal":
conteúdo do pack instalado, nenhuma licença no disco, `nrv update` já quebrado.
Agora ele reporta a licença e a assinatura dela, se cada componente que o
manifesto do pack declara está de fato no disco, e se os grupos de alias estão
onde o roteador lê — cada um com o comando que resolve.

**O `nrv update` passava por cima da licença que acabara de baixar.** O zip
per-buyer carrega o `PROVENANCE.json`, então um update já tem em mãos o que
precisa para reparar um store de licença ausente ou vencido. Best-effort, depois
do overlay: a essa altura o conteúdo já está correto, e uma falha de escrituração
não deve desfazer isso.

**O detector de contaminação conhecia cinco extensões; o marcador conhece seis.**
Faltava `.markdown`, então um arquivo `.markdown` marcado podia voltar via
`nrv update` invisível para a checagem que existe justamente para pegar isso. Ele
também pulava `dist/` — numa máquina que autora packs, o único diretório onde
packs são construídos.

## 0.5.0 — 2026-08-14

### Os registries nunca eram construídos no caminho do comprador

A única chamada de `nrv index` do instalador do engine ficava no fim do
`offerStarterPack()`, abaixo do `return` que o `--no-starter` dispara — e
`--no-starter` é exatamente o que os dois pontos de entrada passam, o
`npx @nirvana-os/cli` e o `setup.ts` do pack. Uma instalação só-engine terminava
sem registry nenhum no disco, e o roteamento ficava degradado desde o primeiro
minuto, sem nada dizendo isso. Comprador de pack escapava por acidente, porque o
overlay de conteúdo indexa por conta própria.

O CI nunca pegou porque o job de smoke roda `nrv index` à mão antes do doctor, e
o doctor aprova um registry que existe sobre uma biblioteca vazia. A indexação
agora vive na própria função, chamada do `main()`, e o `--no-index` e o `--dry`
continuam suprimindo.

### Um comprador no Windows com setup falhando era informado de que deu certo

O `setup.ps1` chamava o instalador e devolvia o que o PowerShell bem entendesse —
não havia `exit $LASTEXITCODE`. Uma instalação falha saía com 0, na plataforma
exata de onde vieram os dois relatos de licença. O `setup.sh` ganha isso de graça
do `exec`; no PowerShell precisa estar escrito.

### O pack pago era invisível para o `nrv installed`

O overlay de conteúdo gravava `~/.nirvana/packs/<slug>.json`. O `nrv installed`
relê o `~/.nirvana-installed.jsonl`. Duas trilhas que nunca se falaram, então uma
instalação paga bem-sucedida respondia "No installations recorded" — o que se lê
como "nada está instalado". O `AssetKind` já tinha `"pack"`; só faltava o
escritor. O registro é best-effort, porque a essa altura o conteúdo já está
correto, mas avisa quando não consegue.

### Estado de execução estava sendo entregue dentro do produto

Não é bug do engine, mas é no engine que a correção mora. `.squad-state/`,
`projects/` e `outputs/` são o que um squad escreve quando roda — o trabalho do
autor, com os caminhos absolutos dele dentro. Três lugares do engine sabiam
disso, cada um com sua cópia da lista; o builder do pack não tinha cópia nenhuma,
então copiava tudo para dentro do artefato. O `base/web-design.zip` na prateleira
carregava 14 dessas entradas. A lista agora vive em
`skills/_shared/lib/run-state.ts` e todos os consumidores leem dela.

### A saída é em inglês

O comprador que reportou o bug da licença recebeu um erro em português. Cerca de
200 linhas voltadas ao usuário, em 41 arquivos, estão em inglês agora — todo o
caminho de install, licença e update, mais o `dispatch --help` e o resto da
superfície do `nrv`. Traduzir só as inequívocas deixaria comandos inteiros meio a
meio, então cada arquivo tocado ficou coerente.

O `check-english-source` pulava strings de propósito. Agora ele as lê, com um
pragma `i18n-user-facing` para os dois briefs de exemplo que são genuinamente
dados no idioma do usuário.

### O caminho do comprador tem um teste que o executa

O `buyer-path.test.ts` instala o engine num HOME temporário, constrói um pack com
o builder real, injeta o `PROVENANCE.json` do jeito que a loja injeta no
download, roda o `bun setup.ts` e então olha o disco. Reverter a correção de
licença da 0.4.0 faz ele reprovar em três afirmações. Até aqui, a única cobertura
do instalador do pack eram greps sobre o código-fonte, e o CI nunca o havia
executado.

O CI também passou a rodar a suíte inteira. Ele rodava um diretório, o que
deixava 15 arquivos de fora — incluindo o único teste de comportamento do
instalador do engine. Rodá-los revelou seis falhas no Windows contra um produto
que se comportava exatamente como projetado: lá ele copia em vez de linkar,
porque symlink exige admin. Os testes agora afirmam o contrato real de cada
plataforma.

Cinco suítes roteiam briefs pela biblioteca de conteúdo instalada e pulam quando
ela não existe. O Bun imprime um teste pulado sem reprovar, então no log do CI
eles eram indistinguíveis de aprovados — e um carregou uma expectativa vencida
por quatro dias enquanto todo run saía verde. Agora anunciam o skip e os números
que o decidiram.

### `check:packs`

Baixa cada base publicada e compara o `setup.*` dela byte a byte com o do engine.
Também checa marcadores de watermark, marcadores per-buyer, vazamento de engine e
a composição contra o que a vitrine anuncia. Fica fora do `check:all` porque
precisa de rede e de uma credencial do bucket. Na primeira execução encontrou
quinze packs com um instalador de dois dias atrás.

## 0.4.0 — 2026-08-14

### O instalador do pack nunca instalou a licença

Investigar o `nrv update genesis-circle` de um comprador levou a algo pior do que
um comprador. O instalador que vai dentro de todo pack de conteúdo abria o
`PROVENANCE.json` para ler a versão do pack e fechava. Nunca copiava o arquivo
para `~/.nirvana-license/`, que é o único lugar onde o `nrv update` procura fora
do diretório atual.

A instalação terminava com "✓ Pack instalado" e nenhuma licença no disco. O
update funcionava para quem por acaso rodasse de dentro da pasta descompactada, e
falhava para todo o resto — dias depois, sem nada que ligasse a falha à
instalação que a causou. Foi por isso que o relato veio do Windows: não há nada
de Windows nisso, é só onde alguém finalmente rodou o comando de outra pasta.

A cópia agora acontece, e avisa quando não consegue. Um erro de permissão imprime
o caminho onde falhou, diz que o pack continua funcionando e que só o update
autenticado não, e entrega o comando único que resolve. Uma cópia sem procedência
também passa a dizer isso, em vez de seguir calada. Os testes garantem que o
passo existe e que o `catch` dele nunca fica vazio, porque um `catch` vazio é
exatamente o formato que esse bug tinha.

### Só dava para instalar a licença reinstalando o pack

Um comprador no Windows rodou `nrv update genesis-circle` e recebeu "Sem
PROVENANCE com license_key". A mensagem nomeou os dois caminhos consultados —
essa parte funcionou — e então mandou rodar de novo o `bun setup.ts`, o
instalador inteiro do pack, para copiar um arquivo pequeno. Era o único caminho:
a cópia mora dentro do setup.ts e em nenhum outro lugar.

O `nrv license install` é o comando que faltava. Sem argumento, ele procura onde
um pack baixado de fato está: diretório atual, Downloads, Desktop, home, e um
nível dentro de qualquer subpasta cujo nome mencione nirvana ou pack. Com
argumento, aceita arquivo ou pasta, porque pasta é o que as pessoas colam. O
`LICENSE.txt` vai junto quando está ao lado.

A verificação roda depois da cópia e nunca a impede. Uma procedência que falha na
assinatura ainda é o arquivo que o comprador pagou, e dizer que está sem
assinatura é mais útil que recusar movê-la.

## 0.3.9 — 2026-08-14

### A guarda contra vazamento passou a seguir o engine em vez de lembrar dele

Remover os artefatos de run commitados deixou um gate que citava três caminhos de
memória — `outputs/`, `.nirvana/`, `.harness-logs/`. Uma lista dessas envelhece no
dia em que alguém muda onde um run escreve, e o vazamento que ela deixaria passar
é idêntico ao que ela pegou.

O conjunto protegido agora é perguntado aos próprios resolvedores do engine
(`outputsDir`, `harnessLogsDir`), com aqueles três como piso caso a resolução
falhe. Mover um diretório de saída não o desprotege em silêncio: um teste deriva
os mesmos caminhos e reprova até o `.gitignore` acompanhar. Outro confere que o
`git add` simples é recusado sem `--force`, porque a guarda mais barata é a que
impede o erro de ser cometido.

### Artefatos de run foram commitados dentro do engine

O `outputs/` nunca esteve no gitignore, então nove arquivos de um run de dispatch
chegaram ao repositório público na #4: um brief, um HANDOFF, os entregáveis de
uma empresa, um relatório gerado. Nada secreto — sem credenciais, sem conteúdo
pago, sem watermark — mas o rastro de *usar* o engine não é o engine, e não
pertence a um repositório que outras pessoas leem para entender o produto.

Agora o `outputs/` está ignorado, os nove foram destrackeados (seguem em disco,
por serem a procedência do CLA publicado), e o `check-engine-purity` reprova
qualquer arquivo rastreado sob `outputs/`, `.nirvana/` ou `.harness-logs/`. Ele
lê o índice do git em vez do disco, então o run local de quem desenvolve fica em
paz e só o commitado reprova.

Eles permanecem no histórico: o conteúdo não é sensível, e reescrever o histórico
de um repositório público para apagar ruído custa mais que o ruído.

## 0.3.8 — 2026-08-13

### O cockpit ainda era anunciado pelo instalador de hooks

O `nrv glance` saiu da tela final do instalador do engine, mas o instalador de
hooks encerra a partir de outro arquivo e continuava apontando para ele. O
cockpit está inacabado; uma instalação não deveria mandar um usuário novo para a
superfície mais fraca. A guarda agora confere todo `console.log` dos dois
instaladores, então menção em comentário segue permitida e menção impressa não.

### Um 5xx matava runs que o cabeçalho prometia retentar

O `quota-detector` documenta desde sempre que um 5xx classifica como
`transient` — recuperável, retenta o mesmo runtime. Nenhuma regra jamais
implementou isso. Todo 5xx caía em `error`, que a cascata trata como fatal: emite
`runtime_error` e desiste, enquanto `transient` dorme e retenta.

Achado por um incidente real: um **529 Overloaded** da Anthropic matou um
dispatch que teria funcionado segundos depois. O orquestrador agêntico se
recuperou raciocinando sobre o erro em prosa — conferiu que nada tinha sido
escrito, fechou o run como `failed` com o motivo, e redespachou do zero. O
caminho scriptado não tinha com o que raciocinar.

Agora 5xx classifica como transitório em todo runtime, e de forma conservadora:
um "529" solto pode ser número de linha, então código de status só conta perto de
contexto de status, enquanto a palavra "overloaded" é aceita sozinha porque
nenhum provedor a usa para outra coisa. As tabelas por runtime mantêm a primeira
palavra — um 503 que um provedor use para dizer "seu plano acabou" continua
`quota_exhausted`, porque isso pede cooldown e handoff, não retentativa contra a
mesma parede.

### Uma skill exclusiva do Hermes era oferecida a todo runtime

Instalar o OpenClaw e rodar `openclaw skills list` mostrou o `nirvana-os-hermes`
como pronto. Ele não está na raiz de skills: o OpenClaw varre seis níveis e o
encontrou sob `_shared/adapters/hermes/`, que o instalador linka em todo runtime.
A descrição dele pede que os outros runtimes o ignorem — prosa não impõe nada.
Agora ele tem gate no binário `hermes`, então some onde o Hermes não existe.

O gate não consegue expressar "qual runtime eu sou" — o OpenClaw só oferece gate
por binário, config e SO — então numa máquina com Hermes instalado e OpenClaw
rodando as duas variantes ainda aparecem, e o que resta é a descrição.

A skill `nirvana-os` também vinha sem gate nenhum, visível em máquinas incapazes
de rodar uma linha dela. Agora exige `bun`, como as outras três.

### OpenClaw

O Nirvana passa a instalar em `~/.agents/skills`, a raiz de skills pessoais que o
OpenClaw lê, e as três skills carregam um gate `metadata.openclaw` exigindo
`bun` — sem ele, a skill apareceria numa máquina incapaz de rodar um único de
seus scripts.

Dois fatos daquele runtime mudam como o sistema se comporta lá, e o adapter
(`_shared/adapters/openclaw.md`) documenta os dois. Ele **não tem subagente
in-process**: o trabalho é delegado com `bash background:true` para um CLI filho,
acompanhado por `process poll`, e o filho anuncia a própria conclusão. É
exatamente o que o `nrv dispatch --exec` já faz, então ali o caminho scriptado é
o dispatch, não um fallback. E ele **não lê arquivo de instrução de projeto** —
não há equivalente a CLAUDE.md ou AGENTS.md — então a ativação depende
inteiramente da descrição da skill, e quem cobre um worker que morre antes de
anunciar é o supervisor do run-ledger.

A linha de compatibilidade da skill afirmava que um runtime cujo spawn é
fire-and-forget "não consegue rodar a cascata". Isso deixou de ser verdade quando
o dispatch passou a ser coletado por notificação, e nunca foi verdade para um
runtime que oferece um handle consultável no lugar.

### Três coisas sobre notificações, aprendidas errando

Um dispatch de teste notificou com o `<result>` corrompido e nada no disco. Lido
como definitivo, aquilo é entrega falhada. Minutos depois o mesmo dispatch
notificou de novo — relatório limpo, arquivo escrito. O trabalho estava chegando
o tempo todo.

Então o protocolo passou a dizer o que uma notificação significa. Ela dispara
toda vez que o alvo para sem filho em background vivo, ou seja, **um dispatch
pode notificar mais de uma vez**: um `<result>` truncado, corrompido ou que
contradiz o disco se lê como *ainda não terminou*, nunca como falhou. **O
`<result>` é relatório, não prova** — o harness pode neutralizar saída que se
pareça com instruções, e um relatório pode ser só otimista; o que prova entrega é
a Phase 6 lendo o disco. E **um bloqueio relatado honestamente é o sistema
funcionando**: registre, feche o run como falho com o motivo, e não redespache o
mesmo brief esperando outra parede.

### Travar a sessão era o preço errado para receber os resultados

Mais cedo hoje o protocolo passou a despachar de forma síncrona
(`run_in_background: false`), porque um run real mostrou 13 dispatches devolvendo
"Async agent launched successfully" e nenhum trabalho. Essa leitura estava meio
certa: o recibo de fato não é o resultado, mas o resultado nunca esteve faltando.
Ele chega na `<task-notification>` que o runtime entrega quando o alvo termina,
com `<result>` e o relatório completo. Vinte e quatro delas chegaram naquele mesmo
run e nenhuma foi aproveitada.

Obrigar o dispatch síncrono devolvia o trabalho no resultado da ferramenta — ao
custo de travar a sessão pela duração inteira. Uma stack de deploy de 45 minutos
deixou o dono sem conseguir dizer uma palavra: uma pergunta digitada no meio ficou
enfileirada, sem ser lida, atrás de um trabalho que não era sobre ela.

Então o dispatch voltou a ser em background, que é o padrão e não trava. O que
ficou foi a regra que sempre faltou: o recibo não é o resultado, o resultado vem
da notificação, e uma notificação percebida e não tratada é a mesma falha que um
recibo confundido com trabalho. Varrer o disco segue proibido, e dispatch segue
sem timeout — alvo morto num prazo arbitrário é trabalho jogado fora.

## 0.3.7 — 2026-08-13

### Adotar o Nirvana num projeto que já existia não ligava nada

O `nrv init` escreve o contrato como AGENTS.md + CLAUDE.md + GEMINI.md para que
toda família de runtime ache um. Para um arquivo que já existia, ele mantinha as
regras do usuário e acrescentava só o contrato de *escrita* — o que deixava o
caso mais comum de todos sem o contrato de *invocação*, a parte que manda o
runtime orquestrar. O AGENTS.md recebia, e o Claude Code não lê AGENTS.md. Quem
tinha um CLAUDE.md prévio rodava o init, via "ok", e seguia recebendo respostas
inline: sem dispatch, sem gate, sem auditoria.

Os dois blocos agora são acrescentados sob marcadores próprios, com as regras do
usuário intactas acima e a segunda rodada não mudando nada.

### O orquestrador conserta o projeto em vez de reportar

Ninguém opera este sistema digitando `nrv`. As pessoas conversam com o Claude
Code, Codex, agy ou Hermes, e é essa CLI que roda os comandos. Então projeto sem
inicializar não é erro de usuário para reportar — é um conserto de uma linha que
o orquestrador executa, porque é ele quem está com o shell na mão. A Phase 0
virou preflight: sem arquivo de contrato, roda `nrv init .`, avisa numa linha,
segue. Só pergunta antes quando o diretório é repositório de outra pessoa, onde
três arquivos novos apareceriam no diff dela.

### O teste de heartbeat falhava por afirmar o contrário do desenho

O `driver — heartbeat sidecar` reprovava cerca de uma rodada de CI em três, no
macOS e no Windows, e travou três pull requests seguidas. Ele conferia se o
último heartbeat parecia velho no instante em que o teste olhava — mas o sidecar
renova o lease a QUALQUER saída nova, e o JSON de resultado do filho é saída
nova. Se o heartbeat parecia velho dependia de onde um poll de 250ms caía em
relação a essa escrita.

Renovar na escrita final é comportamento correto, então a asserção é que estava
errada, não o tempo. Uma tentativa anterior de consertar fazendo o filho falso
sair mais cedo só estreitou a janela: os bytes já estão no arquivo de captura
nesse ponto.

A propriedade que ela queria — o sidecar parou de renovar durante a parada — é
provada direto pelo evento `x_ledger_stall_observed`, emitido uma vez com o gap
medido. Contra 2,2s de silêncio e um teto de 1,2s, o sidecar tem cerca de oito
polls para notar. Não sobra corrida.

### A instalação ensinava o primeiro passo errado

O instalador do engine terminava com uma lista de quatro comandos, o `nrv init`
por último e o `nrv glance` acima dele. O do pack era pior: "abra qualquer CLI de
IA e simplesmente converse" — que é exatamente o caminho inline, ensinado ao
comprador na primeira execução, no diretório em que ele estivesse parado.

O `nrv init` escreve o contrato (AGENTS.md / CLAUDE.md / GEMINI.md, um por
família de runtime) que manda a CLI orquestrar pelo Nirvana-OS. Sem ele, um brief
é respondido inline por um agente só: sem dispatch para as empresas e squads que
o usuário instalou, sem quality gate e sem auditoria. Nada dá erro — ele só
recebe um produto pior, sem como saber por quê.

Os dois instaladores agora começam pelo `nrv init`, mostram a forma para
diretório novo e para pasta existente, e dizem a consequência nessas palavras. O
`nrv glance` saiu dos dois: o cockpit está inacabado, e a primeira tela não
deveria apontar para a superfície mais fraca.

## 0.3.6 — 2026-08-13

### Projeto sem inicializar degradava em silêncio

O `nrv init` escreve AGENTS.md + CLAUDE.md + GEMINI.md para que todo adapter ache
um, e o que o runtime lê carrega a instrução de invocar o Nirvana
"independentemente da ativação da skill". Um projeto sem nenhum deles ainda
orquestra depois que a skill ativa — a skill carrega o protocolo, e a instrução
de dispatch agora carrega as regras de construção e de escrita — mas nada manda o
runtime buscar a skill, então um brief pode ser respondido inline, sem dispatch,
sem gate e sem trilha de auditoria.

O `nrv doctor` agora aponta isso, conferindo os três nomes de arquivo em vez do
de um runtime só, e apenas quando o diretório de trabalho de fato parece um
projeto.

### As regras de construção só chegavam a projetos Claude Code

As quatro regras que impedem um agente de construir demais — pensar antes, o
mínimo que resolve, mudanças cirúrgicas, pronto verificável — viviam só no
contrato de projeto que o `nrv init` escreve. Dois jeitos independentes de
perdê-las: a maioria dos projetos nunca roda `nrv init`, e o arquivo que cada
runtime lê é diferente entre os oito adapters (`AGENTS.md` para
antigravity/codex/grok/kimi/pi, `CLAUDE.md` para o claude-code, `GEMINI.md` para
o gemini-cli). O que depende de arquivo de projeto é frágil duas vezes.

Agora elas viajam no que sempre existe: a instrução de dispatch para quem
constrói, a própria skill para o orquestrador. Um teste percorre todos os
adapters e reprova se algum declarar um arquivo de contrato que o `nrv init` não
escreve, para que nenhum runtime fique sem contrato em silêncio.

### A prosa era julgada por uma regra que nunca recebeu

O contrato de escrita vive no `CLAUDE.md`/`AGENTS.md` do projeto, escrito lá pelo
`nrv init` — que a maioria dos projetos nunca roda. O quality gate julga todo
`.md` e `.txt` por ele mesmo assim, então um subagente podia ser reprovado por
uma regra que ninguém lhe deu. Visto ao vivo: um relatório voltou com 38
travessões contra um teto de 12 e teve que ser reescrito depois de pronto.

O teto de travessões é o que mais escapa, porque é quantitativo e ninguém conta
enquanto escreve. Então o contrato agora viaja dentro da própria instrução de
dispatch, junto com o comando que o verifica — e a entidade roda essa checagem
antes de devolver o trabalho, não depois do gate reprovar. Pegar ali custa uma
releitura; pegar no gate custa reescrever um documento pronto.

### O gate esperava o irmão mais lento

A Phase 6 começava com "antes de declarar pronto, rode DUAS checagens". Para um
alvo só, isso lê bem; para uma onda, significa que nada é conferido até tudo
voltar. Medido num run real: um alvo voltou às 04:51:15, o irmão às 05:05:27, e
os dois foram julgados num laço só às 05:06 — a saída do primeiro ficou quatorze
minutos sem conferência.

O relógio é a parte pequena. Uma falha descoberta tarde não pode mais ser
corrigida em paralelo: uma revisão que poderia ter rodado junto com os irmãos
ainda trabalhando vira mais uma rodada em série. O gate agora está ancorado no
alvo devolvendo o trabalho, por alvo, antes do próximo dispatch sair.

## 0.3.5 — 2026-08-13

### O trabalho despachado nunca voltava

Os exemplos de dispatch do protocolo nunca passavam `run_in_background: false`, e
a ferramenta de subagente usa background por padrão. Então todo dispatch
devolvia "Async agent launched successfully" — um recibo de lançamento — e o
orquestrador, que o protocolo manda esperar o retorno, não tinha o que esperar.

Medido num run real de 13 alvos: 13 dispatches, 13 recibos, zero resultados. O
que o orquestrador fez no lugar foi vasculhar o diretório de saída com `find` e
`ls` para adivinhar quais alvos tinham terminado, cutucá-los com mensagens de
acompanhamento, rodar o quality gate nos arquivos que por acaso notou, e fechar
runs do ledger com base numa listagem de diretório. Nove horas de relógio, boa
parte delas em varredura.

Tudo o que vem depois de um dispatch presumia um resultado que nunca chegava: uma
empresa lê o handoff para escolher o próximo employee, uma fase de workflow
consome a saída da fase anterior, e o gate deveria julgar o que o alvo relatou.
Os três estavam lendo o chão.

O dispatch agora é síncrono nos três pilares, o paralelismo passou a ser definido
pelo que ele é de fato (uma mensagem com várias chamadas, que o runtime roda
concorrentemente e devolve juntas), o background está nomeado como a exceção que
custa o retorno, e varrer o disco para inferir conclusão está proibido nas
palavras que a falha produziu. O `check:dispatch` reprova o build em qualquer
exemplo de dispatch que dispare e esqueça — o gate achou mais três no adapter de
runtime que esta entrada de changelog teria deixado passar.

## 0.3.4 — 2026-08-12

### O engine agora é desenvolvido em aberto

Este repositório deixou de ser um espelho de force-push e virou o lugar onde o
engine é desenvolvido. A história é permanente a partir do `63e4f4c`: pull
requests entram aqui, releases são taggeadas aqui, e o CI constrói o tarball da
release a partir da árvore pública — os mesmos gates de vazamento e watermark,
agora rodando onde todos podem ver. O `main` rejeita force-push para todos,
admins inclusive.

A maquinaria de contribuição chegou com a virada: CONTRIBUTING.md, SECURITY.md
(prompt injection e forja da cadeia de auditoria explicitamente no escopo),
CODEOWNERS, um bot de CLA, e a matriz de testes cross-OS rodando em pull
requests de forks — sem secrets, por construção.

### O CLA é uma licença, não uma cessão

A Sustainable Use License sempre exigiu que contribuições viessem com um CLA; o
acordo publicado transferia a titularidade de cada contribuição ao dono do
projeto. Agora ele segue o modelo Apache ICLA: o contribuidor mantém a
titularidade e concede licença perpétua, mundial, irrevogável, gratuita e
sublicenciável, incluindo o direito explícito de relicenciar sob termos
comerciais — a liberdade de que o projeto precisa, sem tomar o trabalho de
ninguém. A licença de patente com defensive termination é nova; os direitos
morais seguem inalienáveis pela lei brasileira. A troca aconteceu com o CLA
ainda sem nenhuma assinatura, então nenhum contribuidor ficou sob os termos
antigos.

### Backups de update não se acumulam mais

O `nrv update` fazia backup da árvore de skills a cada rodada e nunca apagava
nada: uma máquina que atualizou onze vezes carregava onze cópias completas
(~50MB) que nada jamais leria de novo. O update agora mantém exatamente um
backup — o que acabou de fazer — e apaga os demais, só depois de o instalador
ter concluído com sucesso, para que um update que falhe nunca perca a cópia que
ainda poderia salvá-lo.

O `nrv doctor` também ganhou um check de lixo: uma entrada `*.bak` dentro de um
diretório de skills de runtime é carregada como se fosse uma skill (uma cópia
pré-migração foi encontrada ao vivo, ao lado da verdadeira), e mais de um
`skills-backup-*` significa que o prune não está rodando. Os dois casos agora
viram aviso em vez de acumular em silêncio.

## 0.3.3 — 2026-08-10

### O trabalho despachado por um agente podia terminar em silêncio

A garantia de nunca-travar tinha um buraco, e o buraco ficava exatamente onde a
maior parte do trabalho acontece. O `nrv dispatch --exec` abre uma linha no
run-ledger, bate o heartbeat enquanto o runtime filho trabalha, e o supervisor
varre leases vencidos a cada dois minutos, então um run scriptado que morre é
retomado e alguém é avisado. Um agente orquestrando o mesmo brief dentro da
própria sessão não abria nada. Ele emitia os eventos de auditoria, despachava os
squads, rodava o gate, e deixava o ledger vazio, então o supervisor não tinha o
que encontrar e ninguém ficava sabendo que o trabalho tinha acabado.

Um projeto mostrou o formato inteiro do problema: 11 `brief_received`, 5
`dispatch_squad`, 8 `gate_passed`, zero linhas no ledger, zero avisos. O agente
tinha seguido o protocolo fielmente. O errado era o protocolo, numa única frase
que limitava a promessa a "todo dispatch scriptado" e três orações depois
garantia "nunca esquecido", sem ressalva nenhuma.

A cobertura agora é efeito colateral de despachar, não algo que o agente precisa
lembrar. O `brief-squad.ts` e o `brief-business.ts` são passos de preparação que
o orquestrador tem que rodar de qualquer jeito; eles passaram a abrir o run no
ledger do mesmo modo como já emitiam o `dispatch_squad`, e imprimem o id do run
junto com o comando que o fecha. O `nrv run-track` é a porta para o resto: `open`
para um dispatch de `agent-x`, que não tem script de preparação; `beat` para
renovar o lease ao longo de um trecho demorado de raciocínio; `close` para
registrar `delivered`, `withheld` ou `failed`. Fechar dispara uma notificação no
desktop, que é a parte que o dono realmente queria, porque ele não fica olhando o
terminal que está fazendo o trabalho.

O supervisor aprendeu que um run agêntico não é um run scriptado. Não existe
sessão para retomar nem prompt para relançar, e o único pid ao alcance é o da
sessão do próprio usuário, não o de um filho nosso, então o ledger não registra
pid nenhum de propósito e a varredura nunca sinaliza esse processo. Em vez disso
ele lê atividade em disco como prova de vida: um run que continua escrevendo
ganha extensão de lease, e um run que emudeceu vai direto para o salvamento, onde
os artefatos em disco passam uma vez pela verificação e pelo quality gate, de
modo que o humano é avisado do que foi encontrado e se passou. Runs longos também
dão sinal a cada trinta minutos (`NIRVANA_PROGRESS_PING_SEC=0` silencia isso).

A notificação de desktop alcançava uma plataforma antes disto e agora alcança
três: macOS pelo osascript, Linux pelo notify-send, Windows por um balão de
PowerShell que não precisa de nada instalado.

## 0.3.2 — 2026-08-10

### O Windows não conseguia sequer iniciar um CLI de agente

O CreateProcess só acrescenta `.exe` automaticamente, nunca `.cmd` — e todo CLI
de agente instalado por npm É um `.cmd`. O driver disparava o nome puro, então a
invocação morria enquanto o `where` informava alegremente que o runtime estava
disponível: a sonda dizia sim, a execução dizia não, e um comprador no Windows
não conseguia despachar nada. O instalador havia aprendido essa regra há muito
tempo e a deixou escrita num comentário; o driver de agentes nunca a recebeu.

O `resolveExecutable()` agora encaminha `.cmd`/`.bat` por um shell (único jeito
de iniciar um) e dispara um `.exe` de verdade direto, com o `quoteForCmd()`
protegendo argumentos que um shell comeria — um arquivo de prompt temporário cai
sob o perfil do usuário, e muitos deles têm espaço no caminho. O `whichSync`
passou a procurar `.cmd`/`.bat` também; ele só tentava `.exe`, então dizia "não
instalado" para um runtime que estava ali. Aplicado nos três pontos que iniciam
um CLI, um deles o gargalo por onde passam os dezesseis adapters. No POSIX tudo
isso é identidade: mesmo comando, mesmos args, sem shell.

O arnês de testes tinha silenciosamente saído da arquitetura do próprio engine.
Os CLIs falsos eram scripts `#!/bin/bash` e `#!/bin/sh`, que o Windows não
resolve nem pelo nome nem pelo shebang, então 38 testes falhavam lá sem dizer
nada sobre o produto. Cada falso agora é um corpo Bun/TypeScript com um lançador
de uma linha por sistema; no Windows eles viram `.cmd`, a mesma forma que o npm
dá a um CLI real, então o novo tratamento do driver é exercitado em vez de
presumido.

Três defeitos de portabilidade apareceram embaixo: testes juntavam entradas de
PATH com `:`, que no Windows não separa nada; quatro fixtures relocavam o `HOME`
enquanto o `os.homedir()` lá segue o `USERPROFILE`; e o `doctor-system` lia
`os.homedir()` direto enquanto o resto do engine honra o `NIRVANA_HOME` primeiro,
então com essa variável definida ele diagnosticava um home diferente do que o
engine usava e reportava tudo em ordem.

A matriz completa está verde pela primeira vez: Windows, macOS, Ubuntu e os
gates de contrato, com o `nrv doctor` no Windows em 30 checagens, 0 falhas, e o
bootstrap do tarball via npx passando lá.

## 0.3.1 — 2026-08-09

### Uma sonda de runtime que respondia sobre o PATH errado

O `runtimeAvailable()` decide se um CLI existe antes de a cascata tentá-lo, e
disparava a sonda `which` sem passar `env`. No Bun isso significa o ambiente
capturado no INÍCIO DO PROCESSO, não o `process.env` atual — enquanto a
invocação real dispara com `env: {...process.env}`. Sonda e invocação podiam
divergir: um runtime acrescentado ao PATH durante a corrida aparecia como
indisponível sendo perfeitamente invocável, e a cascata pulava uma plataforma
que funciona.

Encontrado pelo próprio CI da release. A suíte de failover passava numa máquina
que por acaso tem os binários `gemini` e `agy` instalados e falhava no Linux,
que não tem nenhum dos dois — ou seja, os shims que ela acreditava exercitar
nunca eram alcançados. As duas sondas (`runtimeAvailable` e `whichSync`) passam
`env` explicitamente agora, e um teste de regressão exige que a sonda enxergue
uma mutação de PATH, usando um nome de binário que dificilmente existe.

## 0.3.0 — 2026-08-09

### BREAKING: credencial quebrada não custa mais a corrida inteira

Uma matriz ao vivo (o mesmo brief nas seis plataformas instaladas) pegou o
Google encerrando o tier individual do `gemini-cli`: o CLI autentica e em
seguida recusa, com `IneligibleTierError` apontando para o Antigravity. Cinco
plataformas entregaram; a sexta morreu — e expôs três defeitos nossos atrás do
problema externo.

**O `IneligibleTierError` não casava com nenhum padrão do classificador.** O
regex de autenticação exigia `authentication failed`, e o texto real diz
`Error authenticating:`. O veredito virava `error` genérico, e erro genérico
não rotaciona: a corrida acabou com um runtime saudável na entrada seguinte da
cascata. Agora o encerramento de tier é reconhecido (e a dica aponta o `agy`,
não "refaça o login" — de tier aposentado ninguém se re-autentica).

**`auth_failed` passou a rotacionar.** Antes a política era parar e devolver o
erro ao chamador, com o argumento de que credencial inválida é problema do
usuário. O argumento continua válido para o diagnóstico, não para o trabalho:
agora o runtime entra em cooldown curto (15 min) e a cascata segue para a
próxima entrada, como já fazia com cota. O evento `runtime_auth_failed` continua
no audit com a dica — seguir em frente não esconde a credencial quebrada. O
cooldown é por runtime, não por entrada, porque outro modelo no mesmo CLI usa a
mesma credencial e falharia igual.

**O roteador escolhe o runtime por tentativa.** O `routeOnce` fechava sobre uma
escolha única, então o "tenta de novo" da escada batia no mesmo CLI morto: o
roteador falhava duas vezes e o brief caía em agent-x sem especialista — perda
de qualidade de roteamento causada por uma indisponibilidade alheia. Agora, uma
falha de transporte cujo motivo é o próprio runtime marca cooldown, e a
tentativa seguinte roteia por uma plataforma viva.

### `nrv install --dry` não instala mais de verdade

O `--dry` era honrado só pela sincronia do starter pack e pela config do
hermes. As outras quatro fases ignoravam a flag: um "preview" copiava a árvore
de skills por cima da instalada, reinstalava as dependências, religava todos os
runtimes, reescrevia os hooks e ainda anexava a sentinela de smoke no audit.
Quem rodasse para inspecionar uma atualização antes de decidir já a tinha
tomado. Agora as quatro fases têm guarda e imprimem o que fariam; o instalador
de hooks roda no próprio modo `--check`. Verificado no sistema real: árvore,
settings e audit intactos depois de um `--dry`.

### O `nrv` avisa quando existe engine mais novo

O `nrv update` sempre funcionou, mas nada nunca dizia que havia atualização.
Quem nunca digitasse o comando ficava na versão instalada para sempre — inclusive
atravessando correções que decidem se uma corrida entrega ou morre. O changelog
chegava em quem foi procurar; no resto, não chegava.

Uma linha no stderr, antes do comando, só quando existe release mais nova de
verdade. A restrição que desenhou tudo: todo subcomando termina em `exec`, então
não existe "depois do comando" para enganchar, e o aviso não pode custar latência
ao CLI. Por isso ele lê um arquivo de cache de três linhas com builtins do shell,
sem nenhum subprocesso, enquanto a atualização pela rede roda destacada e
beneficia a invocação SEGUINTE. O timestamp mora dentro do arquivo em vez do
mtime, que o `stat` lê diferente no macOS e no Linux e que rsync e restauração
reescrevem. O modo de falha é o silêncio: sem rede, com rate limit, com cache
corrompido, com diretório sem permissão — cada caso resulta em nenhuma mensagem,
nunca num comando quebrado. Para desligar, `NIRVANA_NO_UPDATE_CHECK=1`; `CI` é
respeitado automaticamente. O `nrv update-check --status` mostra o estado.

### O primeiro `nrv index` de uma instalação nova não falha mais

O engine é publicado sem conteúdo por design, então uma instalação nova tem zero
empresas, squads e clones. O construtor do digest tratava "zero entradas" e "não
consegui ler o registry" como a mesma condição e saía 1 com "run `nrv index`
first" — conselho para o comando que o usuário acabara de rodar. O `nrv doctor`
então reportava três falhas críticas numa máquina onde nada estava errado.

Agora só registry ilegível é falha; vazio recebe um digest vazio válido e uma
linha dizendo isso. Medido numa instalação nova a partir do tarball da release:
o `nrv index` fecha 4/4 ok, e o doctor cai de 3 críticos para 2 avisos (nenhum
runtime configurado, nada despachado ainda — os dois verdadeiros).

### O gate de paridade da CLI para de inventar comandos

O `check-cli-parity.ts` varria o `bin/nrv` inteiro atrás de linhas indentadas em
2 espaços contendo `)`, então um comentário com parêntese ou um `case` dentro de
uma função auxiliar contava como subcomando. Acrescentar o aviso de versão fez o
build da release falhar com oito comandos que não existem. A varredura agora é
ancorada no bloco de dispatch `case "$cmd" in … esac` da coluna zero, onde os
comandos de fato moram, e o arquivo pode ganhar funções sem o gate alucinar.

### O erro que aparece é a causa, não o primeiro aviso do CLI

A falha registrada no ledger e mostrada ao usuário era
`"YOLO mode is enabled. All tool calls will be automatically approved."` — um
aviso benigno que o CLI imprime antes de tudo. A causa real ficava soterrada
sob doze linhas de `Skill conflict detected` e um stack trace.

Os onze pontos onde um adapter montava a mensagem de erro (nove runtimes mais
os dois envelopes de baixo nível) cortavam os primeiros 500 bytes do stderr.
Agora extraem a linha que carrega a causa, onde quer que ela esteja: o ruído
conhecido é descartado, as linhas com sinal ganham da posição. Isso importa
além da estética — nos envelopes de baixo nível o `error` é o único texto que o
classificador enxerga, e ruído suficiente empurrava a causa para fora da janela.

### `nrv doctor` aponta skills visíveis por dois caminhos

Runtimes que leem tanto o diretório de convenção (`~/.agents/skills`) quanto o
próprio (`~/.gemini/skills`, …) carregam o mesmo SKILL.md duas vezes e logam
`Skill conflict detected` para cada skill. Nada quebra — os dois caminhos
resolvem para o mesmo arquivo — mas o aviso parece problema de verdade. O
doctor agora compara por realpath (um diretório alcançável por dois nomes não
é dois diretórios), diz quais diretórios duplicam e lembra que
`~/.agents/skills` não é criado por este engine.

### `bun test` na raiz não acusa mais falha de pack

`dist/` guarda packs construídos cujos templates de squad trazem os próprios
testes, com as próprias dependências — instaladas no projeto do comprador, não
aqui. Varrer esse diretório fazia um `bun test` nu reportar 55 falhas
fantasmas. O `bunfig.toml` agora escopa a varredura no engine: 624 testes, 0
falhas.

### BREAKING: `nrv revise` entrega pelo pipeline, e os exit codes mudam

O `revise.ts` tinha uma cópia própria do verify e do gate: piso de 200 bytes,
gate só em `.md`/`.txt`/`.json`, e uma variável `allPass` que começava em `true`
antes de um laço que podia rodar zero vezes. Uma revisão que produzia só
`.html`, PDF ou imagem não era julgada por nada e ainda assim emitia
`delivered` com `gate:"pass"` e saía 0. Um gate reprovado de verdade também
emitia `delivered` (com `gate:"fail"`) antes de sair 1. Era o mesmo fail-open
que a Fase 4 fechou no dispatch, vivo justamente na rota que a mensagem de
entrega RETIDA indica ao usuário.

Agora `nrv revise` chama o mesmo `runDelivery()` do dispatch e do supervisor:
verify (com `verify-deliverable.ts` quando há manifesto), gate sobre TODOS os
artefatos avaliáveis e decisão entregue | retido | indeterminado.

| exit | significado |
|------|-------------|
| 0 | revisado e ENTREGUE — gate passou |
| 1 | falhou — erro do runtime, ou nenhum entregável verificável |
| 2 | entrega RETIDA — gate reprovou depois do orçamento de revisões |
| 3 | INDETERMINADO — nenhum artefato que o gate saiba julgar |
| 4 | argumentos inválidos (era 2, que virou o código da retenção) |

O orçamento de revisão do `nrv revise` é o do config (`quality_gate.max_revisions`),
porque essa iteração é do humano. Quando quem chama é o supervisor
(`NRV_IN_SWEEP=1`), o orçamento cai a zero: a varredura roda sob launchd a cada
120s sem ninguém olhando, e gastar LLM em laço de revisão ali é dinheiro sem
dono. O veredito volta para o supervisor, que retém e escala.

### O supervisor julga o que o redespacho produziu

Depois de um redespacho bem-sucedido, o supervisor rodava verify e gate
próprios e devolvia `delivered` com "gate indeterminate" sempre que o run tinha
produzido só `.html`, PDF, imagem ou código. Entregue sem uma rubrica sequer ter
rodado. O resultado do redespacho passa pelo `runDelivery()`, e o retomar lê o
exit code do `nrv revise` em vez de procurar "gate FAIL" no texto da saída.

Duas decisões que valem registro. O redespacho não recebe o teto de completude:
o run terminou sob controle do supervisor, diferente do resgate de um run
interrompido, e aplicar o teto deixaria a recuperação automática inútil, já que
a maioria dos runs não tem manifesto. E roda com zero revisões, pela mesma regra
de orçamento acima.

### Erro do runtime não abandona mais o que já foi produzido

Um run real (`proj-20260809T050140-content-creation`) entregou guia em md, html,
PDF e imagens — e mesmo assim terminou como `failed`, com os artefatos
esquecidos no disco: sem verify, sem gate, sem decisão de entrega. Causa: o
runtime devolveu veredito de erro no fim do run (limite de uso), e o dispatch
saía com exit 1 sem olhar para a pasta de saída.

Agora um run não-ok procura artefatos com a MESMA descoberta do pipeline de
entrega. Sem artefato, nada muda (`failed`, exit 1). Com artefato, o run entra
no mesmo pipeline — verify → gate → orçamento de revisão → entregue | retido |
indeterminado. O erro do runtime continua visível: evento
`x_runtime_errored_with_artifacts` na auditoria, `last_error` preservado e
`meta.runtime_errored` no ledger até a linha terminal, e aviso explícito no
terminal. O contrato fail-closed não afrouxou: artefato de run errado que
reprova no gate continua RETIDO (exit 2).

A máquina de estados do ledger ganhou a aresta `failed → verifying` — o
caminho de resgate, que não re-despacha porque o trabalho já existe.

### `nrv dispatch` sem `--exec` sai 3, não 0

`nrv dispatch --auto "<brief>"` sem `--exec` saía 0 sem ter despachado nada.
Como 0 significa ENTREGUE, um `nrv dispatch … && publica` publicava um run que
nunca executou. Scaffold não entrega nem julga nada: passa a sair 3
(INDETERMINADO) nos três caminhos — business, squad-only e agent-x.

| exit | significado (atualizado) |
|------|--------------------------|
| 0 | entregue — gate passou, ou `--force-deliver` |
| 1 | run falhou — roteamento, execução ou verificação |
| 2 | entrega RETIDA — gate reprovou depois das revisões |
| 3 | INDETERMINADO — nada foi julgado: zero artefatos avaliáveis, **ou scaffold sem `--exec`** |
| 4 | argumentos inválidos |

## 0.2.0 — 2026-08-07

Release grande: o motor deixa de depender de disciplina para cumprir o que
promete. Três garantias novas — nunca travar, nunca entregar sem gate, nunca
abandonar um brief — mais roteamento que funciona em qualquer idioma.

### BREAKING: exit codes do `nrv dispatch` — a entrega agora é fail-closed

Antes, um gate reprovado seguia adiante e o run terminava em exit 0 com evento
`delivered`. Isso acabou. Quem tem script conferindo `exit 0` precisa adotar o
contrato novo:

| exit | significado |
|------|-------------|
| 0 | entregue — gate passou, ou `--force-deliver` explícito (audit `delivered` com `gate:"fail-forced"`) |
| 1 | run falhou — roteamento, execução ou verificação |
| 2 | entrega RETIDA — gate reprovou depois do orçamento de revisões (antes: exit 0 + `delivered`); audit `x_delivery_withheld` |
| 3 | entrega INDETERMINADA — zero artefatos avaliáveis, nada foi julgado (antes: exit 0 + `delivered`) |
| 4 | argumentos inválidos (era 2, que virou o código da retenção) |

O gate também passou a cobrir todo tipo de artefato (`.html`, `.yaml`, código e
imagens, não só `.md`/`.txt`/`.json`), o `verify-deliverable.ts` finalmente é
chamado nos runs com manifesto, e o juiz LLM liga por `quality_gate.judge_enabled`
(default segue `false`).

### Nunca travar: run-ledger + supervisor

Todo dispatch abre uma dívida num ledger SQLite com máquina de estados imposta
em código: `dispatched → running → verifying → gated → delivered | withheld`.
Um run só sai da dívida terminando; `abandoned` exige razão explícita.

O que detecta travamento é atividade, não relógio. Um sidecar renova a lease
apenas enquanto stdout, stderr ou os arquivos de saída realmente avançam, e
desiste após 5 minutos de silêncio. O supervisor então varre: retoma pela sessão
gravada, re-despacha por outro runtime, e escala com notificação quando esgota as
tentativas. Rode `nrv supervisor install` uma vez e um LaunchAgent passa a varrer
a cada 2 minutos; cada comando `nrv` também faz uma varredura preguiçosa de menos
de 20ms. O teto de relógio virou o que sempre deveria ser: 24 horas de rede de
segurança, para não matar um livro que legitimamente leva seis horas.

### Nunca abandonar: a cascata Empresa → Squad → agent-x virou código

`NO_MATCH` despacha o `agent-x` do runtime em vez de sair com erro — muda quem
executa, nunca se executa. Rota de squad agora despacha e entrega de verdade
(antes imprimia instruções e saía). Ambiguidade oferece escolha no terminal,
escolhe o topo fora dele com evento de auditoria, ou falha com `--strict-route`.
Falha de transporte do roteador tenta de novo, cai para o BM25 e só então para o
agent-x.

### Roteamento mundial

O roteador agêntico é o padrão e ficou barato: lê um digest compacto de ~45k
tokens (empresas, squads, capabilities, colisões e mind-clones) no lugar de
megabytes de registry. O contrato de resposta separa transporte de semântica —
`decision`, `ambiguous` ou `no_match` —, então falha de roteador nunca mais se
confunde com "nada serve".

No fallback determinístico: um tokenizador Unicode único (segmenta CJK, árabe e
devanágari via ICU; conserta siglas como E-E-A-T; trata `e-book` e `ebook` como o
mesmo termo), gates de cobertura que impedem injeção de mind-clone irrelevante, e
uma ponte de aliases multilíngues que resgata brief em português contra corpus em
inglês sem gastar token. O braço denso foi reavaliado com o modelo multilíngue
real e permanece desligado por medição, disponível como sugestão em `no_match`.

### Conteúdo encontrável por construção

Criar empresa, squad ou mind-clone agora passa por um gate de auto-recuperação: a
entidade só nasce quando os próprios `example_briefs` a recuperam em primeiro
lugar. O `ROUTING_METADATA_CONTRACT.md` define o padrão (descrições em inglês
canônico, grupos de sinônimos multilíngues, briefs em EN e PT com verbo no
infinitivo e conjugado, `not_for` em tokens curtos), os indexadores passaram a
emitir as descrições que antes nunca chegavam ao índice, e `nrv doctor` reporta a
cobertura da sua biblioteca. Quem já tem conteúdo pode elevá-lo com
`enrich-routing-metadata.ts`.

### Runtimes e robustez

Os dois drivers divergentes viraram um só, com nove adaptadores (claude-code,
codex, gemini-cli, antigravity-cli, kimi-cli, grok-cli, pi, qwen-code, opencode).
Prompt grande não estoura mais o limite de argumentos — cada CLI recebe pelo
método que suporta (STDIN, `--prompt-file`, anexo), verificado com 300KB. Custo
por run vem populado onde o CLI reporta, e explicitamente indisponível onde não
reporta. Locks de arquivo eliminam perda de escrita em ondas paralelas.

### Higiene do repositório

Todo o código-fonte e as instruções agênticas em inglês, com gate de CI. As
referências foram reescritas contra o código real e a tabela de eventos de
auditoria passou a ser gerada da enum, para não fossilizar de novo. `bun run
check:all` roda os quatro gates: inglês, pureza do engine, paridade de comandos e
paridade de eventos.

### Como migrar

Confira os exit codes em qualquer automação que chame `nrv dispatch`. Se você
precisa do comportamento antigo num caso específico, `--force-deliver` entrega
mesmo com gate reprovado e deixa o registro honesto na auditoria. Rode `nrv index`
depois de atualizar (o digest é reconstruído junto) e `nrv supervisor install` para
ativar a varredura automática.

## 0.1.72 — 2026-07-28

### Runtime pi: um CLI, 15+ providers e modelos locais no cascade

O Pi Coding Agent (pi.dev) entra como sétimo exec-runtime, verificado contra
o binário real (`pi 0.82.1`). O `runPi` despacha via `pi -p --mode json` com
sessão determinística (`--session-id`, mesmo padrão do gemini) e leva o
`AUTONOMOUS_DIRECTIVE` por `--append-system-prompt` nativo. Quirk importante
tratado no driver: o pi sai com exit 0 mesmo quando o provider falha, então
`ok`/`error` saem do event stream (`stopReason`/`errorMessage`), e o
quota-detector classifica o phrasing real de cota ("used all available
credits" vira `quota_exhausted`). Custo somado de `message.usage.cost.total`.
O `@provider` do LLM_CASCADE vira `--provider` de verdade, incluindo
`@ollama`: caminho de sucesso verificado 100% local com qwen2.5-coder:7b,
com resposta correta, resume real de sessão e custo $0. Completam o runtime:
aliases USE_PI, detecção de host por PI_CODING_AGENT, `agent-x.pi`, adapter
de 15 seções, symlink de skills em `~/.pi/agent/skills` no install, e os
pacotes `pi-mcp-adapter` + `@pi9/subagent` registrados na matriz. Medição
empírica registrada no adapter: modelo local de 7B não sustenta dispatch de
business completo (prompt de 92k chars, zero tool calls em 2 tentativas); o
trilho local é fim de cascade, não topo. Suíte: 141 pass, 0 fail.

### Verify aceita entregável curto nomeado no brief

O anti-stub de 200 bytes reprovava entregáveis legitimamente minúsculos:
um `haicai.md` de 57 bytes, correto e dentro do contrato, falhou o verify
num dispatch real via `--exec=codex`. Agora arquivo nomeado explicitamente
no brief conta como entregável desde que não-vazio, nos três pontos que
usavam o piso fixo (verify, lista do gate e repescagem pós-revisão).
Regressão E2E via codex fechou verde: `verify_passed`, `gate_passed`,
`delivered: pass`.

## 0.1.71 — 2026-07-27

### Roteador fast pós-censo: 94,1% → 99,8%, e NO_MATCH enfim alcançável

Censo de verdade-terreno contra TODOS os 2.358 `example_briefs` do registro
provou que o `applyAdjustments` derrubava 133 briefs válidos — todos erro,
zero curadoria. Correções, cada uma medida antes e depois:

- **Filtro de intent vira opt-in** (`NIRVANA_ROUTER_INTENT_FILTER=1` religa).
  Verbos banais ("run", "rodar") excluíam capabilities por classe: 81 NO_MATCH
  fabricados + 34 HIGH para rota alheia. Pós-ajustes: 94,1% → 99,8%.
- **`score_boost` clampado em [1.0, 1.3]** — boost 0 era aceito como
  multiplicador ×0 e auto-aniquilava a capability.
- **NO_MATCH por cobertura**: vencedor que casa ≤1 de ≥3 tokens de conteúdo do
  brief ORIGINAL (nunca o amplificado) → NO_MATCH; 2 de ≥4 com fração ≤0,5 →
  AMBIGUOUS. Brief fora de domínio agora abstém com razão explícita; zero
  falso-negativo nos 2.358 reais. Fecha a dívida "NO_MATCH inalcançável".
- **Stage -1 sem sequestro**: gatilhos banais ("portfolio", "end-to-end")
  removidos e fallback por substring morto — 56 briefs sequestrados com 0
  acertos voltam ao pipeline normal.
- **Promoção business-first vê `business_route` como rival** — fecha o
  invariante top=1.0 quebrado.
- **Business era invisível para o próprio brief**: `example_briefs`/`produces`/
  `keywords` entram no texto indexado do doc de business. Destino certo dos
  319 briefs declarados: 7,5% → 91,5%. E2E squads subiu junto (99,6%).

### Criação nativa: o engine sem conteúdo cria tudo

O engine instala sem businesses, squads ou clones — e agora cria os três de
ponta a ponta, sem squad intermediário (o papel do `nirvana-squad-creator` foi
absorvido):

- `squads/references/02-creation.md`: Phase 0 (arqueologia de intenção +
  pesquisa web obrigatória) e Phase 8 (otimização + gate de roteamento com
  `example_briefs` como verdade-terreno).
- `businesses/SKILL.md`: Round 0 e Round 5 equivalentes, com mind-clones
  escolhidos por necessidade.
- `_shared/MIND_CLONE_CREATION_PIPELINE.md` (novo): clone ponta a ponta com
  gate de material (sem fonte = archetype, nunca nome real), DNA `^[FONTE]` e
  bloco routing pelo contrato.
- Harness: clones casados por NECESSIDADE via `nrv find-clone` (campo
  `serves`), NO_MATCH despacha `agent-x` (o brief nunca para), e gate de
  atualidade na Fase 2 (escolha de stack não especificada exige pesquisa web
  com fonte e data).

### Qualidade travada no CI

- Eval de roteamento de clones entra na suíte com marcos d'água; em install
  limpo ou pack parcial os marcos skipam (pureza: o engine não instala
  conteúdo) e vale o invariante universal de auto-recuperação 100%.
- `index-clones.ts` espelha o registry do escopo global automaticamente.
- Suíte: 141 pass, 0 fail.

## 0.1.70 — 2026-07-27

### Clone ausente nunca mais derruba o dispatch — em sete camadas

Regra do dono: **o dispatch jamais pode morrer porque um mind-clone não existe.**
Um brief que cite um especialista fora da biblioteca matava a execução inteira,
mesmo quando o agente sabia perfeitamente trabalhar como aquela pessoa.

Mas degradar em silêncio é pior que falhar, então toda degradação é RUIDOSA em
três canais: evento `mind_clone_missing_degraded`, bloco explícito dentro do
prompt dizendo ao agente que ele NÃO carrega aquele DNA, e campo no retorno para
quem chamou reportar ao usuário.

O levantamento achou o defeito em sete lugares, não um:

- **`injectMindClones`** lançava exceção. Agora degrada e devolve `degraded[]`.
- **`validateTrace`**, a garantia anti-fabricação, tratava clone degradado como
  fabricação. Passou a distinguir três estados: injetado, degradado com evento, e
  sumido sem rastro. Só o terceiro reprova — a propriedade anti-fabricação segue
  intacta, verificada com trace sintético.
- **`team-orchestrator`** pulava em silêncio (`if (persona)`).
- **`employee-prompt`** era o pior: clone SOLICITADO e inexistente fazia
  `hadRequested` virar `false`, e o sistema caía calado para BUSCA e injetava
  **outra pessoa**. O employee rodava achando que era a persona certa.
- **`deterministicAudit` Regra 2** marcava clone ausente como `critical`, e
  `critical > 0` produz `verdict: "block"`. O `throw` removido ressuscitava um
  andar acima. Rebaixado para `warning`; squad e business ausentes seguem críticos.
- **`buildVoiceFidelityPack`** omitia clone ausente sem registro, deixando o gate
  de fidelidade indistinguível de "nenhum clone declarado". Ganhou `missing_clones`.
- **Rubric do auditor LLM** (`dispatch-auditor.md`) ainda listava mind-clone sob
  "Critical — verdict: block", o que reintroduziria o bloqueio pela camada
  semântica. Movido para warning, com o caminho de criação documentado.

### Rule 9 no SKILL.md: procure por necessidade, crie se faltar, degrade com honestidade

- Seleção de clone em quatro passos, e nenhum termina em falha dura: nomeado no
  brief vence tudo; não nomeado busca pela NECESSIDADE e não pelo nome; pedido e
  inexistente oferece criar via `fabrica-de-genios`
  (`knowledge_management.mind_clone_generation_pipeline.execute`); não criou, atua
  por conhecimento próprio **dizendo que é isso**.
- O ponto do passo 4 é a diferença entre degradar e mentir. Trabalhar sem o DNA é
  aceitável; deixar o usuário achar que o DNA estava lá, não.

## 0.1.69 — 2026-07-27

### O caminho fragmentado descartava a espinha operacional da persona

- `NIRVANA_DNA_INJECTION=fragments` nunca leu o `AGENT.md`. Ele lia SOUL + camadas
  do schema + coherence map, e só. Isso não era "seleção por camada": era trocar a
  definição operacional do agente pelo resumo derivado dela. O `AGENT.md` é **36%
  de tudo que o full injeta** e é onde vivem os Princípios, os Frameworks nomeados,
  os `Commands`, o `What You Refuse to Do` e as `Limitations`.
- Consequência: quem tivesse ligado o modo fragmentado — disponível há tempo, atrás
  de env var — rodava com personas sem limites declarados e sem recusas, e o sistema
  não emitia sinal nenhum. Modo degradado silencioso, como o corte cego do 0.1.68.
- Corrigido: o `AGENT.md` entra como primeira unidade do fragmento. Teste de
  regressão fixa a invariante.

### Como isso apareceu, e o que a medição mostrou

- Teste cego de 5 pares (mesmo brief, persona inteira contra fragmento da fase,
  juiz sem saber qual é qual, persona completa como referência): a persona inteira
  venceu **4×1**. Um dos juízes decidiu explicitamente por `Limitations` — seção
  que o fragmento não tinha como enxergar. Elo causal, não correlação.
- Depois do conserto, com uma variável trocada: **3×2**, que com n=5 é
  indistinguível de moeda. O déficit sumiu; a equivalência **não** ficou
  demonstrada, e o teste não tem poder para decidir.
- **O default segue `full`.** A economia real, medida com o `AGENT.md` restaurado,
  é 21% — e cai para 12% se o L5 voltar à política de fase, o que a evidência dos
  juízes sugere ser necessário em trabalho analítico. As camadas têm peso quase
  igual (17% a 26%), então não há folga a extrair sem custo proporcional.
- Registro honesto: os 55% que a versão anterior reportava somavam 34 pontos de
  amputação a 21 de seleção real. A amputação estava sendo contabilizada como ganho.

## 0.1.68 — 2026-07-26

### Injeção de DNA por camada deixa de amputar o método

- A seleção estrutural por camada (L1 Filosofias · L2 Modelos Mentais · L3 Heurísticas ·
  L4 Frameworks · L5 Metodologias) já existia e é SEM PERDA por construção, mas estava
  inutilizável: o `byteBudget` cortava com `lastIndexOf("\n", 9000)` sobre o texto já
  colado. Como a ordem de montagem é SOUL → L1 → camadas da fase → coherence map, a
  cauda amputada era sempre **a última camada pedida** — exatamente aquela que a
  política de fase escolheu — enquanto o L1, que entra em toda fase, sobrevivia intacto.
  Medido: **175 dos 548 clones** eram amputados assim, sem erro nenhum.
- O orçamento agora descarta **unidade inteira** (só o coherence map, que é derivado) e,
  se ainda estourar, entrega o fragmento COMPLETO. O teto virou consultivo: entregar
  SOUL + as camadas da fase acima do orçamento continua sendo fração do full, enquanto
  amputar destrói o método. Corte cego segue valendo só para os caminhos não fragmentados.
- Teto de 9 KB → 16 KB, escolhido por medição: 9 KB deixava 65% dos fragmentos caberem
  íntegros, 16 KB leva a 94%, e 24 KB acrescenta 2 pontos.
- A fase real chega ao seletor (`injectMindClones({ phase })`); antes era `"execute"`
  fixo, então um dispatch de planejamento recebia camadas de execução.
- Resultado na biblioteca: **0 mutilados** (eram 175), 512 clones fragmentáveis, **56%
  de economia média sem nenhuma perda**.

### Parser de camadas reconhece cabeçalho em nível 3

- Cinco clones traziam as cinco camadas completas, com fontes citadas, escritas como
  `### Layer 1 — VISION`. O parser estrito os reprovava e eles caíam para full. Reescrever
  a persona para caber no regex seria destruir material bom por causa da ferramenta.
- Fallback que só entra quando o estrito falha, repartindo também em `###`. O caminho
  canônico fica idêntico: repartir em `###` de saída quebraria o corpo das camadas dos
  clones bem formados.

### Correções na superfície de contrato do 0.1.67

- **Churn perpétuo em mind-clone.** A superfície de clone varre o diretório inteiro e
  media `CHANGES.json` e `CHANGELOG.md` — que o próprio gerador escreve. Cada execução
  produzia mudança, que escrevia arquivo, que produzia mudança. 22 clones em laço.
  Saídas do gerador agora estão fora da medição (`GENERATED_FILES`).
- **Supressão por schema virava permanente.** `diffSurfaces` ignora diff entre schemas
  diferentes de propósito, para uma melhoria do extrator não inundar compradores com
  mudanças fantasma. Mas o `gen` retornava cedo quando não havia mudança, então a
  superfície nunca era regravada com o schema novo: o mismatch persistia e TODA mudança
  real futura daquele artefato seria engolida em silêncio. Agora schema diferente força
  a regravação. `SURFACE_SCHEMA` → 2.
- Entradas fantasma já gravadas ("dna-artifact removido: CHANGELOG.md") foram limpas de
  22 clones — elas diriam ao agente do comprador que houve remoção com quebra.

## 0.1.67 — 2026-07-26

### Mudança de artefato deixa de ser narrada e passa a ser calculada

- O sistema distribui squads, empresas e mind-clones que mudam o tempo todo, mas
  quem recebe a atualização não tinha como saber **o que** mudou. O agente do
  comprador seguia invocando uma capability renomeada, ou apontando para um alvo
  que virou outro, sem nada falhar em voz alta: o trabalho só saía errado.
- A saída óbvia — um `CHANGELOG.md` escrito à mão em cada artefato — já tinha
  falhado neste sistema antes de ser tentada. O campo `version` existe em todos os
  774 artefatos e está morto: 132 dos 178 squads parados em `5.0.0` (a versão do
  *protocolo* vazando) e 48 das 49 empresas em `1.0.0`. Metadado que depende de
  alguém lembrar apodrece; escrever prosa apodrece mais rápido que trocar um número.
- Agora cada artefato carrega uma **superfície de contrato** (`.nirvana-surface.json`):
  os identificadores aos quais um agente consumidor de fato se liga — id de
  capability, alvo de `invoke`, nome de task/workflow/agent, slug de employee,
  domains e produces — mais o hash do corpo de cada um. Duas superfícies são
  comparáveis por máquina, então versão e changelog passam a ser **derivados**.
- Severidade é consequência estrutural, não opinião: id removido ou renomeado e
  alvo de invocação trocado são QUEBRA (major); id novo é aditivo (minor); só o
  corpo ou a prosa de descoberta mudou é ajuste (patch). Renomeação é reconhecida
  como tal (mesmo corpo, id diferente) em vez de virar "removido + adicionado",
  que esconderia justamente a migração trivial.
- A superfície mora **dentro** do artefato e viaja no pack. Isso dispensa registro
  central: na atualização, o instalador compara a superfície instalada com a que
  está chegando no único instante em que as duas coexistem em disco, antes de
  sobrescrever, e reporta as quebras com a migração de cada uma.
- `nrv changes pending <entidade> --project <dir>` responde a pergunta que importa
  para quem consome: *o que mudou que ESTE projeto ainda não viu?* Devolve um
  `brief_block` pronto para o orquestrador colar na instrução de dispatch (Rule 8),
  porque changelog que o agente precisa lembrar de abrir é changelog que ele não lê.
- Comportamento é o único tipo que nenhum diff estrutural enxerga (mesma interface,
  resultado diferente). Fica como anotação manual opcional em `.nirvana-behavior.md`,
  consumida e apagada no build — deliberadamente a exceção, não a regra.

### Detalhes que decidem se isto funciona ou vira ruído

- **Determinismo é requisito.** O arquivo gerado entra no `hashDir()` do instalador.
  Com timestamp ou ordenação instável, todo rebuild marcaria todo artefato como
  atualizado e o sinal morreria no ruído. Sem data de geração, chaves ordenadas em
  qualquer profundidade, e o próprio arquivo excluído do que ele mede.
- **Schema diferente reestabelece a base em silêncio.** Uma melhoria futura no
  extrator muda hashes de artefatos que ninguém tocou; comparar entre schemas
  inundaria todo comprador com mudanças fantasma. O engine não sabe o que mudou de
  verdade, então não inventa.
- **Os dois instaladores usam o mesmo helper.** `scripts/install.ts` e
  `skills/_shared/scripts/install-content.ts` têm cada um a sua cópia de `syncKind`;
  a primeira versão desta feature entrou só no primeiro, e o caminho que o comprador
  usa para atualizar teria ficado sem aviso nenhum. A comparação vive em
  `_shared/lib/contract-breaks.ts` para que os dois relatem a mesma coisa.
- Linha de base gerada para 178 squads, 49 empresas e 547 clones em ~2s; segunda
  execução não altera um byte. `build-all-packs.sh` regenera antes de montar os packs.

## 0.1.66 — 2026-07-26

### Ordem antes de forma: paralelismo vira conclusão, não default

- A Phase 4 abria mandando "Dispatch to 1 or N in parallel" — paralelo como ponto
  de partida, antes de qualquer análise de dependência. O raciocínio de ordem
  estava vinte linhas abaixo, atrás de um "load it on demand", e o multi-target
  ainda era mencionado dentro da seção **Optional subsystems** ("None is
  mandatory"). Ou seja: o maestro era instruído a paralelizar primeiro e a pensar
  na ordem só se resolvesse carregar a referência.
- Agora a Phase 4 começa pela pergunta que decide tudo — *este alvo precisa do
  entregável de outro para fazer o trabalho dele?* — e a resposta define a forma.
  Precisa de upstream: roda depois, e a `DISPATCH-INSTRUCTION.md` nomeia a fase e
  o caminho para ler. Não precisa de ninguém: roda concorrente, desde que a
  instrução seja auto-suficiente — alvo que precisaria perguntar algo a um irmão
  no meio do run nunca foi independente, estava sub-instruído.
- Concorrência passa a ser a CONCLUSÃO da análise. Dois alvos que só parecem
  independentes mas leem a saída um do outro são um run corrompido, e a falha
  aparece tarde e com cara de problema de qualidade.

### Multi-target sai de "opcional" e vira o caminho normal de 2+ alvos

- `references/04-multi-target.md` deixa de ser subsistema opcional e passa a ser
  protocolo exigido sempre que a Phase 4 aterrissa em mais de um alvo. A máquina já
  existia e é boa — workspace compartilhado, `manifest.json` com `depends_on` /
  `consumed_by` / `outputs_path` e `parallel_waves[]`, e um
  `DISPATCH-INSTRUCTION.md` por alvo com escopo, caminhos upstream e quem consome a
  saída. O que faltava era o ponto de entrada tratá-la como norma.
- Escrever o DAG é o que torna a ordem auditável: onda que se aponta é decisão,
  onda que ficou na cabeça do maestro é palpite que o usuário não pode conferir.

## 0.1.65 — 2026-07-26

### Reuso de sessão por entidade (o agente continua sendo o mesmo agente)

- Cada dispatch abria sessão fria. A mesma empresa ou squad chamada duas vezes no
  mesmo projeto reconstruía do zero o que já sabia — e um agente que recomeça frio
  não é o mesmo agente, é um novo com o mesmo prompt. Contexto perdido é qualidade
  perdida, e nenhum orçamento traz de volta o que o agente esqueceu.
- `harness/lib/session-store.ts` guarda a sessão por **(projeto, runtime,
  entidade)**. Os três importam: projeto porque a mesma empresa em outro projeto
  deve começar fria (mesma isolação da memória — o que um projeto aprendeu costuma
  ser errado para o próximo); runtime porque id do claude-code não significa nada
  para o codex; entidade porque cada funcionário/squad tem a sua linha de
  raciocínio. Vive em `<projeto>/sessions.json`, único lugar que o BP5 permite
  escrever durante um brief.
- Ligado nos dois pontos do `team-orchestrator` (passo de funcionário e squad
  obrigatório) por um helper único, sem duplicar lógica. Emite `session_resumed` e
  `session_resume_failed` na trilha de auditoria.

### Fallback: o reuso só pode melhorar, nunca degradar

- O driver passa `--resume <id>` e NÃO trata id inválido. Sessão expirada, apagada
  pelo CLI ou vinda de outra máquina faria falhar um dispatch que hoje funciona.
- Agora: se o run falhou E tínhamos passado um id, descarta o id e tenta UMA vez
  fria. O pior caso do reuso passa a ser exatamente o comportamento de hoje.

### Fix: session id vazava entre runtimes no cascade

- Bug latente que esta mudança tornaria comum. O `cascade-runner` montava as opções
  espalhando os args (`{...args, runtime: chosen}`) e, no handoff,
  `{...currentOpts, runtime: chosen}` — o `sessionId` sobrevivia à troca de runtime.
  O CLI novo recebia `--resume` com id de outro CLI.
- Contradizia o comentário do próprio código no handoff ("Build a fresh prompt for
  the new runtime — it doesn't see the old session"). Agora o id só passa quando o
  runtime escolhido é o que o chamador pediu, e é limpo em qualquer handoff.

### Cobertura

- 10 testes novos em `session-store.test.ts`, focados no que pode dar errado:
  isolamento entre runtimes, entre projetos e entre tipos de entidade; arquivo
  corrompido, JSON de forma errada e runtime sem session id não derrubando o
  dispatch; `dropSession` cirúrgico. Suíte total: 89 testes.

### Não implementado, de propósito

- Paralelismo no laço de squads obrigatórios. O mecanismo foi provado num spike
  (1531ms contra 4195ms, `session_id` idêntico, payload de 200KB íntegro através de
  múltiplos chunks, falha isolada), mas o ganho é wall-clock e a saída de cada squad
  é idêntica em série ou em paralelo. Exigiria tornar assíncrono o `cascade-runner`,
  que é o cérebro de failover — trocar o caminho mais crítico do sistema por
  latência, num sistema cuja regra primordial é qualidade sem limite de gasto, é um
  negócio ruim. A cadeia de funcionários segue sequencial por dependência real
  (cada passo lê os `priorOutputs` do anterior).

## 0.1.64 — 2026-07-25

### Rule 7 do contrato de execução: escopo inteiro, e o que passar dele é declarado

- Entrega impecável significa a tarefa INTEIRA, não a parte fácil: só reportar
  conclusão quando estiver de fato pronto e, se algo travar de verdade, terminar
  todo o resto e dizer o que ficou faltando e por quê. Ambiguidade se resolve
  como um colega cuidadoso resolveria — decisão de rotina é do maestro, e só
  volta ao usuário quando leituras diferentes levam a trabalhos materialmente
  diferentes.
- O que o escopo não pode fazer é se mover em silêncio. Nada de estreitar,
  alargar ou transformar o pedido sem avisar; achar que o brief está errado vira
  uma frase dita ao usuário, não uma troca calada. O que for além do pedido entra
  na instrução de dispatch e no relatório final como adição explícita — trabalho
  que o usuário não pediu não é bônus se ele não consegue distinguir do que pediu.

### Contrato de escrita: comprimento acompanha substância

- Seção `Structure` ganhou a regra de tamanho: cobrir o que o entregável precisa
  e parar. Seção de enchimento, resumo redundante, contexto reafirmado e
  boilerplate passam a ser tratados como DEFEITO, não como zelo — comprimento sem
  substância soterra a parte que o leitor foi buscar. Documento longo justifica o
  tamanho cobrindo mais, nunca dizendo a mesma coisa duas vezes.
- Chega aos três arquivos de contrato do projeto (`AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`) pelo `init-project`, então alcança também as entidades despachadas,
  que rodam com cwd no projeto.

### O que deliberadamente NÃO mudou

- `effort` e `model` continuam sendo os do usuário. O Nirvana-OS não altera nem um
  nem outro por conta própria: herda o que estiver no sistema e só muda se o
  `.env` especificar ou se o usuário pedir. Nenhum nível de esforço foi embutido
  em lugar nenhum.
- Nenhum teto de spawn e nenhum budget obrigatório. Orçamento ilimitado e máxima
  qualidade são regra primordial do sistema; o cap de multi-agente que a
  documentação do modelo recomenda vale para workloads sensíveis a custo, que não
  é o caso aqui. A arquitetura de fan-out fica como está.
- Os três gates determinísticos (`quality-gate`, `verify-deliverable`,
  `validate-chain`) ficam intactos: eles conferem verdade em disco, não são
  auto-verificação dirigida por prompt.

## 0.1.63 — 2026-07-25

### Colisão de slug agora é avisada (não mais silenciosa)

- Política inalterada: o pack é a fonte da verdade dos SEUS componentes, vence
  sempre e não há backup — quem altera o que é nosso é responsável pelas
  próprias mudanças. O que muda é só a VISIBILIDADE: se o usuário criou um
  componente com o mesmo slug de um do pack, o sync o sobrescrevia em silêncio e
  o trabalho dele sumia sem explicação (virava issue "sumiu do nada").
- Detecção exata: existe em disco E não está no manifesto do pack
  (`~/.nirvana-pack.json`) ⇒ é criação do usuário. Sem falso positivo na segunda
  rodada, quando o pack já passou a ser dono do slug.
- Reportado como `N overwritten` na contagem e em bloco próprio no fim, com o
  caminho de saída (renomear o seu) e o que foi preservado (run-state:
  `projects/`, `outputs/`, `memory/projects`). Aplicado nos DOIS caminhos de
  sync — `scripts/install.ts` (starter) e `_shared/scripts/install-content.ts`
  (o que o comprador roda via `setup.ts` do pack e `nrv update <slug>`).

### Clones em layout legado aninhado voltam a ser indexados

- Instalações de pack em ≤ 0.1.61 gravaram `dna/<categoria>/<slug>/` (issue #2,
  corrigida na 0.1.62). Quem já tinha essa árvore continuava com `0 mind-clones
  indexed` mesmo após atualizar, porque o scanner só via um nível.
- `index-clones.ts` agora lê os dois layouts: leitor liberal, escritor estrito.
  NADA é movido em disco — mexer nos dados do usuário durante um comando de
  leitura seria pior que o bug. O writer já é flat desde a 0.1.62, então este é
  um caminho de compatibilidade que decai sozinho conforme as instalações
  antigas reinstalam.
- Flat vence no empate de slug; para o clone aninhado a categoria vem do próprio
  diretório-pai. O total legado é reportado ao fim do index, com a orientação de
  que reinstalar o pack normaliza e nada precisa ser movido à mão.

## 0.1.62 — 2026-07-25

### Bibliotecas de conteúdo criadas vazias no install (`~/squads`, `~/businesses`, `~/businesses/_library/dna`)

- O engine é core-only (não embarca conteúdo), mas os diretórios onde o usuário
  cria as SUAS empresas/squads/mind-clones não existiam após a instalação: o
  `scripts/install.ts` só os criava quando havia conteúdo do starter pack para
  copiar (`if (available.length > 0) mkdirSync(dstRoot)`). Com `--no-starter`
  (o caminho do `npx`), nenhum era criado — e o comportamento ainda era
  inconsistente: `~/squads` acabava surgindo por acaso no primeiro `nrv index`
  (via `squads/lib/registry.js`), enquanto `~/businesses` e a biblioteca de DNA
  nunca apareciam. Resultado: instalação nova reportava `⚠ 3 warning(s). System
  usable but degraded.` no `nrv doctor`.
- Agora `ensureContentLibraries()` cria os três VAZIOS, antes do starter pack
  (vale com e sem `--no-starter`). Espelha o que o escopo de projeto já fazia
  (`init-project.ts` cria `.nirvana/{squads,businesses,mind-clones}`).
- NÃO destrutivo e idempotente: `mkdir` recursivo é no-op em diretório
  existente — conteúdo do usuário é preservado (reporta `kept` em vez de
  `created`). Cross-OS: só `path.join` + `mkdirSync`, sem comando de shell, com
  EEXIST tolerado (o Bun lança no Windows mesmo com `recursive: true`).
  `nrv install --check` continua sem mutar nada.

### Fix: pack install gravava mind-clones aninhados por categoria (issue #2) — 0 clones indexados

- `installer.ts` instalava clone em `dna/<categoria>/<slug>/`, mas o layout
  canônico é FLAT (`dna/<slug>/`) — o que `index-clones.ts` (varre um nível só)
  e `install-content.ts` já seguiam. Todo pack com mind-clones instalado por
  `nrv install --type=pack` resultava em `0 mind-clones indexed`.
- Instala flat agora (pack e asset avulso) e grava a categoria como METADADO em
  `.pack-categories.json` — arquivo que o indexer lê mas que NENHUM fluxo do
  engine escrevia, então `pack_category` nunca saía de `null`.
- Colisão de slug dentro do pack agora falha explícita (antes ficava mascarada
  por categorias diferentes). Inferência de categoria endurecida: packs reais
  são flat, então o nome do diretório pai gravaria `"mind-clones"` como
  categoria. `index-clones.ts` passou a resolver o mapa por-root (o metadado
  gravado em escopo de projeto era ignorado).

### Fix: `nrv init --with-skills` quebrava com cópia de 312 MB e projeto pela metade (issue #3)

- Eram três defeitos encadeados, não um: (1) o branch de symlink não criava
  `<target>/.agents`, então `symlinkSync` falhava com ENOENT; (2) caía no
  fallback de cópia; (3) `copyTree` usava `statSync` e seguia o symlink
  `node_modules` de cada skill → centenas de MB e recursão infinita nos ciclos
  de `node_modules/.bin/*` (ELOOP). Corrigir só o `copyTree` deixaria o gatilho
  de pé, com todo `--with-skills` copiando em vez de linkar.
- `copyTree` usa `lstatSync`, pula `node_modules` em QUALQUER profundidade (não
  só no topo) e recria symlinks em vez de expandi-los; `.agents` passou a ser
  criado no branch de symlink; e a falha de cópia virou fail-closed — antes era
  `log.warn` e o comando saía 0 deixando um projeto quebrado.

### Fix: `nrv index` falhava no Windows em escopo de projeto (issue #1, bug 2)

- `businesses/lib/registry.ts` fazia `mkdirSync` cru; no Bun/Windows isso lança
  EEXIST mesmo com `recursive: true` quando o diretório já existe — o caso de
  `<projeto>/.nirvana`, que existe desde o `nrv init`. Passou a usar o helper
  canônico `ensureDir`, que já tolera EEXIST. (Os outros 3 bugs da issue #1 já
  estavam corrigidos desde a 0.1.25/0.1.26.)

### grok-cli: flag documentada + custo real

- Trocado `--yolo` por `--always-approve` (código e docs). `--yolo` funciona,
  mas é alias OCULTO — não aparece no `--help` e pode sumir entre builds.
- O driver gravava `costUsd: null` fixo alegando que a assinatura não reporta
  gasto; o build real devolve `total_cost_usd` no JSON. Agora é parseado.
- Invocação VERIFICADA contra o binário real (`grok 0.2.103`): flags aceitas,
  JSON com `text`/`sessionId`/`total_cost_usd`. O `kimi-cli` segue NÃO
  verificado (binário ausente na máquina de teste).

## 0.1.61 — 2026-07-20

### Novos runtimes first-class: Kimi Code CLI + Grok Build CLI

- `kimi-cli` (Moonshot, binário `kimi`) e `grok-cli` (xAI, binário `grok`) agora são
  runtimes de primeira classe, iguais a codex/gemini-cli/antigravity-cli: `runKimi`/
  `runGrok` no host-agent-driver, presentes em VALID_RUNTIMES/EXEC_RUNTIMES,
  RUNTIME_ALIASES (`USE_KIMI`/`USE_GROK`), detecção de host, menção no brief, glance,
  `.env.example`, e adapters completos em `_shared/adapters/{kimi-cli,grok-cli}.md` +
  `_shared/agents/agent-x.{kimi,grok}.md`. Model vem só do LLM_CASCADE
  (`kimi-cli:k3` / `grok-cli:<model>`), NUNCA hardcoded (model-agnostic).
  - Kimi: grátis via OAuth Kimi.com (K3/K2.7), `kimi -m <model> -p … --output-format stream-json`.
  - Grok: coding agêntico + geração de mídia nativa, `grok -p … --output-format json --yolo --cwd`.
  - Ressalva: as invocações ainda NÃO foram verificadas contra os binários `kimi`/`grok`
    reais (fallback seguro se uma flag divergir).

### Consolidação dos adapters em `_shared/adapters/` (v5, fonte única)

- Aposentada a camada `squads/adapters/` v4.0 (duplicatas/órfãs): removidos codex,
  gemini-cli, antigravity, cursor, claude-code. As tabelas de `squads/references/*`
  agora apontam para `_shared/adapters/`. Nenhum código dependia da camada v4.
- Antigravity: eliminado o adapter órfão (id `antigravity`/binário `antigravity`/modelo
  fixo); fica só o canônico `antigravity-cli` (binário `agy`, sem model).
- Cursor: removido (substituído pelo `grok-cli`).
- Purgados TODOS os nomes de modelo velhos dos adapters — o engine usa o default do
  runtime ou o escolhido pelo usuário, nunca um id fixo.

## 0.1.60 — 2026-07-18

### Fix: drift de validator — limites de description de capability/business na v5

- O `capability-validator.js` (a pré-checagem estrutural v5 que o
  `validate-squad.ts` roda) fixava o limite de `description` de capability em 500,
  divergindo do limite canônico já elevado (1500 em `_shared/validators/limits.ts`,
  o mesmo `LIMITS` que os validadores zod usam). Manifestos v5 válidos com
  descrições de capability entre 500 e 1500 caracteres eram rejeitados por engano,
  abortando o preparo do `brief-squad.ts` (por exemplo o `whatsapp.system.provision`
  de um squad, com 639 caracteres). Agora o limite vem do `limits.ts` (fonte única)
  com fallback seguro para 1500 — nunca mais 500, de modo que a pré-checagem rápida
  não possa divergir do validador autoritativo.
- Schemas JSON alinhados ao `limits.ts`: `description` de capability 500→1500 e
  itens de `example_briefs` 500→1000; `description` de business 500→2000 e itens de
  `example_briefs` 500→1000.

## 0.1.59 — 2026-07-17

### Windows: parsing tolerante a CRLF

- Os parsers de frontmatter estavam ancorados em `\n`, então um checkout Windows
  com CRLF fazia `---\r\n` não casar → as rubrics (e outros 8 parsers: critérios de
  auditoria de mind-clone/squad/business, inspect/list/translate de clone)
  carregavam nada em silêncio, e o quality gate não selecionava rubric nenhuma no
  Windows. Corrigido com um `.gitattributes` (`eol=lf` para arquivos parseados,
  `eol=crlf` para os launchers `.cmd`) mais regexes tolerantes a CRLF como defesa
  em profundidade. Pego pelo novo teste de quality-gate no runner Windows do CI.

## 0.1.58 — 2026-07-17

### O engine nunca prescreve um modelo

- O modelo usado é SEMPRE o configurado no runtime de agente do próprio usuário
  (Claude Code, Codex, Gemini, Antigravity, …). O engine só sobrescreve quando o
  usuário pede explicitamente um modelo específico.
- Removido todo modelo default do engine: config do juiz (`default_judge_model:
  inherit`), default de `model_hint` de capability, `target_model` de rubric (agora
  `inherit`, só telemetria), docs dos adapters e o cliente pixelle (agora
  `gemini-flash-latest`, o ponteiro não-versionado do provedor — sem mais 404 de
  slug de modelo aposentado).

### Roteador: menção explícita vence; business-first para de sequestrar

- Novo Stage 0.5: nomear um squad ou business por slug ("use o squad code-review…")
  curto-circuita o roteamento de forma determinística (`route_tier:
  explicit_mention`) — antes de qualquer pontuação. Normalizado por acento e hífen,
  com guarda contra falso positivo.
- A preferência business-first agora é desempate relativo contra o melhor squad,
  nunca um piso absoluto; rotas por padrão de artefato (`business_route`) competem
  dentro da fusão RRF como uma terceira lista ranqueada, em vez de curto-circuitar
  à frente do casamento por conteúdo. Briefs que casam claramente com um squad não
  são mais sequestrados por rotas de business sem relação.

### Repositório e documentação

- `CHANGELOG.md` (este arquivo), `AGENT-QUICKSTART.md` (onboarding de agente em uma
  página), `SECURITY.md`, templates de issue/PR e um passo a passo ponta a ponta em
  `examples/`.
- Imagem de destaque no README + badge de CI; o badge de versão passou a ser
  reescrito a partir do `package.json` no momento da publicação.
- `AGENTS.md` é a fonte única do contrato de agente; `CLAUDE.md`/`GEMINI.md` são
  cópias geradas (divergência reprova a publicação).
- `skills/harness/SKILL.md` normalizado para inglês do começo ao fim.
- Testes novos: emissão de evento de auditoria (`audit-emit`) e os caminhos de
  seleção e de fail-closed do quality gate.

## 0.1.57 — 2026-07-13

- **Windows:** `nrv index` corrigido (a checagem de caminho do bun, só POSIX, fazia
  todo spawn de indexer falhar com ENOENT quando o Bun não estava no PATH);
  quoting por string de shell substituído por `run()` baseado em argv; 11 wrappers
  `.cmd` corrigidos (`>nul` no lugar de `/dev/null`); erros de spawn passaram a
  mostrar a causa.
- **Instalar em qualquer lugar:** o instalador npx instala o Bun mais recente
  automaticamente no Windows (PowerShell) e continua na mesma execução; o `nrv` é
  adicionado ao PATH do usuário via registro + broadcast `WM_SETTINGCHANGE`, então
  terminais novos funcionam sem reiniciar; a indexação pós-instalação agora roda no
  Windows (`nrv.cmd`); os comandos de hook são quotados e usam supressão de stderr
  por sistema operacional; `fileURLToPath` corrige a resolução da raiz do repo no
  Windows.

## 0.1.56 — 2026-07-13

- ENGINE-MENU ciente do Grok (orientação de Grok Imagine i2v nos squads de vídeo).
- `brief-squad.ts`: o dispatch de squad agora monta o diretório do projeto, o
  HANDOFF e o brief E emite `brief_received`/`dispatch_squad` automaticamente — a
  trilha de auditoria existe em qualquer runtime, sem depender de o agente obedecer
  ao SKILL.md.

## 0.1.55 — 2026-07-10

- `nrv doctor` reporta com honestidade: "last activity <data>" no lugar de um falso
  "nenhum dispatch ainda?"; detecta saídas sem auditoria (agente não emitindo
  eventos) e dispatches de squad (não só de business); caminhos seguros por sistema
  operacional.

## 0.1.54 — 2026-07-10

- Endurecimento de segurança: removido o `js-yaml` (advisory de DoS
  GHSA-h67p-54hq-rp68) — os dois usos restantes migraram para o `yaml` v2; `bun
  audit` limpo.
- Embedder travado com `allowLocalModels=false` (fecha o vetor de modelo local dos
  CVEs do ONNX; o comportamento de hub/cache não muda).

## 0.1.53 — 2026-07-10

- Recuperação híbrida: BM25 + braço denso local opcional (transformers.js/ONNX,
  MiniLM multilíngue) fundidos por Reciprocal Rank Fusion; opt-in via `nrv
  embeddings enable` — o core segue sem dependência dura, com degradação suave.
- Calibração do roteador (auditoria externa E1–E7): `keywords`/`example_briefs`/
  `produces` de capability indexados com peso por campo; separação entre
  substantivo de organização e verbo; promoção apenas do melhor business; abstenção
  de objeto genérico no estágio de keyword; poda de meta-intenção.
- Laço de aprendizado retroativo: os leitores de auditoria aceitam os aliases
  `business_slug`/`squad_name` (histórico recuperado); `nrv audit emit` como CLI
  canônica de escrita.
- Primeira suíte de testes do roteador (69 testes) + rubrics de validação de YAML e
  HTML.

---

Releases anteriores (0.1.9 → 0.1.52) são anteriores a este changelog; veja as notas
de release de cada tag no GitHub.
