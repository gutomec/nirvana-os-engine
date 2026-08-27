// ─── Dicionários Nirvana Glance (en · pt-BR) ───────────────────────────────
//
// Convenção do engine oficial (CONTRIBUTING.md): código em inglês, strings
// de runtime localizadas — PT-BR é o locale padrão do engine. Aqui o padrão
// segue o idioma do navegador (pt* → pt-BR, senão en) e a escolha manual
// persiste em localStorage (`nrv.locale`).
//
// Rótulos de dados do engine (ex.: "Ledger: retido", estados canônicos
// "operational") permanecem como chegam do engine — não são traduzidos.

export const LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "nrv.locale";

export const en = {
  // Hero
  "hero.overview": "Overview",
  "hero.title1": "Agent operations,",
  "hero.title2": "at a glance.",
  "hero.subtitle": "Real-time overview of Nirvana Glance agents and system activity.",
  "hero.stat.agents": "Agents",
  "hero.stat.agentsSub": "Active",
  "hero.stat.eventsToday": "Events today",
  "hero.stat.eventsSub": "Total",
  "hero.stat.successRate": "Success rate (24h)",
  "hero.stat.successSub": "Last 24h",
  "hero.stat.avgResponse": "Avg. response",
  "hero.stat.uptime": "Uptime",
  "hero.uptimeLabel": "30 days",
  "hero.statsAria": "System metrics",

  // Timeline
  "timeline.title": "Event timeline",
  "timeline.filterAria": "Filter events",
  "timeline.logAria": "Run Kernel events",
  "timeline.empty": "No events for this filter yet.",
  "timeline.cancel": "Cancel run",
  "timeline.cancelBlocked": "Cancellation blocked",
  "filter.ALL": "All events",
  "filter.RUN": "Runs",
  "filter.GATE": "Quality gate",
  "filter.SYSTEM": "System",
  "filter.ENTITY": "Entity",

  // Entities
  "entities.title": "Agent entities",
  "entities.lastSeen": "Last seen:",
  "entities.openAria": "Open entity {name}",
  "entity.runsToday": "Runs today",
  "entity.successRate": "Success rate",
  "entity.lastSeen": "Last seen",
  "entity.recentEvents": "Recent events",
  "entity.noEvents": "No events recorded yet.",

  // Tier 3
  "tier3.title": "Engine subsystems",

  // Top bar
  "topbar.statusAria": "System status",
  "topbar.scopeAria": "Toggle scope",
  "topbar.themeAria": "Toggle theme",
  "topbar.clockAria": "Current time (UTC)",

  // Icon rail
  "rail.overview": "Overview",
  "rail.entities": "Entities",
  "rail.timeline": "Timeline",
  "rail.projects": "Projects",
  "rail.settings": "Settings",
  "rail.permissions": "Permissions",
  "rail.menu": "Menu",
  "rail.language": "Language",
  "rail.theme": "Theme",
  "rail.openMenu": "Open menu",
  "rail.closeMenu": "Close menu",
  "rail.pinMenu": "Pin menu open",
  "rail.unpinMenu": "Unpin menu",

  // Command palette (⌘K)
  "palette.title": "Command menu",
  "palette.subtitle": "Navigate and adjust preferences",
  "palette.openAria": "Open command menu (⌘K)",
  "palette.placeholder": "Type a command or search…",
  "palette.empty": "No results.",
  "palette.groupNav": "Navigate",
  "palette.groupPrefs": "Preferences",
  "palette.groupViews": "Views",
  "palette.themeLight": "Theme → Light",
  "palette.themeDark": "Theme → Dark",
  "palette.langEn": "Language → English",
  "palette.langPt": "Language → Português",
  "palette.classic": "Open classic view",

  // Ask bar
  "ask.placeholder": "Ask Nirvana Glance anything…",
  "ask.send": "Send",
  "ask.using": "Using",
  "ask.clearTarget": "Clear target",
  "ask.hint.squad": "use squad:<slug>",
  "ask.hint.business": "use business:<slug>",
  "ask.state.running": "Running",
  "ask.state.completed": "Completed",
  "ask.state.rolled_back": "Rolled back",
  "ask.state.failed": "Failed",
  "ask.state.no_match": "No match",
  "ask.budget": "Budget",
  "ask.target": "Target",
  "ask.dismiss": "Dismiss",
  "ask.aria": "Ask bar",
  "ask.suggestionsAria": "Target suggestions",
  "ask.turnCompleted": "Turn completed — response recorded in the ledger.",
  "ask.turnFailed": "Turn failed.",

  // Chat v2 · thread + agentic forms
  "ask.threadAria": "Conversation with the maestro",
  "ask.threadEmpty": "Pick a guided flow or ask anything — the maestro answers with live kernel data and generates forms in real time.",
  "ask.flow.diagnose": "Diagnose",
  "ask.flow.route": "Route task",
  "ask.flow.gate": "Review gates",
  "ask.flow.status": "Status",
  "ask.flowsAria": "Guided flows",
  "ask.thinking": "Consulting the kernel…",
  "ask.form.answered": "Answered",
  "ask.form.source": "live kernel",
  "ask.form.multiSubmit": "Confirm selection",
  "ask.form.inputAria": "Form field",

  // Drawers
  "drawer.close": "Close",
  "drawer.entity.title": "Entity",
  "drawer.gallery.title": "All entities",
  "drawer.gallery.squads": "Squads & tools",
  "drawer.gallery.businesses": "Businesses",
  "drawer.projects.title": "Projects · DAG",
  "drawer.projects.empty": "No projects yet.",
  "drawer.projects.lastRun": "Last run",
  "drawer.projects.duration": "Duration",
  "drawer.settings.title": "Settings",
  "drawer.settings.core": "Settings core",
  "drawer.settings.scope": "Scope",
  "drawer.settings.scopeHint": "Operational scope of the Glance.",
  "drawer.settings.actionsGate": "Operator action gate.",
  "drawer.settings.liveHint": "Changes apply live and are reflected in the TopBar.",
  "drawer.settings.scopeProject": "project",
  "drawer.settings.scopeGlobal": "global",
  "drawer.settings.allowActions": "Allow actions",
  "drawer.settings.allowActionsHint": "Enables write endpoints (same as --allow-actions in nrv glance).",
  "drawer.settings.budget": "Budget used",
  "drawer.settings.idempotency": "Idempotency keys",
  "drawer.settings.headless": "Headless permissions",
  "drawer.permissions.title": "Permissions",
  "drawer.permissions.actionsHint": "Enables inline cancel of runs and destructive actions.",
  "drawer.permissions.stateOn": "Current state: actions ON — cancel available in the timeline.",
  "drawer.permissions.stateOff": "Current state: actions GATED — cancel returns 403.",
  "drawer.permissions.readOnly": "Read-only by default",
  "drawer.permissions.readOnlyHint": "Writes require --allow-actions and Idempotency-Key, exactly like the official engine.",
  "drawer.permissions.cancel": "Inline cancel of running runs",
  "drawer.permissions.scopeChange": "Scope switch (project ⇄ global)",
  "drawer.permissions.settings": "Settings write",

  // Toasts / errors
  "toast.settingsFail": "Failed to save setting.",
  "toast.cancelBlocked": "Cancel blocked.",
  "toast.cancelOk": "Run cancelled by operator.",
  "toast.scopeChanged": "Scope → {scope}",
  "toast.actionsOn": "Actions enabled (--allow-actions on).",
  "toast.actionsOff": "Actions blocked (gated).",
  "error.snapshot": "Failed to load initial snapshot.",
  "error.turnRequest": "Failed to send message.",
  "error.cancelNetwork": "Network failure while cancelling run.",

  // Classic view
  "classic.title": "Classic view",
  "classic.note": "Compatibility mode — one-pager at /",
  "classic.stats": "Stats",
  "classic.name": "Name",
  "classic.kind": "Kind",
  "classic.entity": "Entity",
  "classic.status": "Status",
  "classic.runs": "Runs today",
  "classic.lastSeen": "Last seen",
  "classic.events": "Events",
  "classic.eventsMeta": "last 40 · refreshes every 5s · snapshot {at} UTC",
  "classic.refresh": "Refresh",
  "classic.loading": "loading…",
  "classic.modernView": "← modern view",

  // Data source chip
  "source.simulated": "Simulated kernel",
  "source.engine": "Live engine",
  "source.hint": "Data source: {source}",
};

export type Dictionary = typeof en;

export const ptBR: Dictionary = {
  // Hero
  "hero.overview": "Visão geral",
  "hero.title1": "Operações de agentes,",
  "hero.title2": "num relance.",
  "hero.subtitle": "Visão em tempo real dos agentes e da atividade do sistema no Nirvana Glance.",
  "hero.stat.agents": "Agentes",
  "hero.stat.agentsSub": "Ativos",
  "hero.stat.eventsToday": "Eventos hoje",
  "hero.stat.eventsSub": "Total",
  "hero.stat.successRate": "Taxa de sucesso (24h)",
  "hero.stat.successSub": "Últimas 24h",
  "hero.stat.avgResponse": "Resposta média",
  "hero.stat.uptime": "Uptime",
  "hero.uptimeLabel": "30 dias",
  "hero.statsAria": "Métricas do sistema",

  // Timeline
  "timeline.title": "Linha do tempo",
  "timeline.filterAria": "Filtrar eventos",
  "timeline.logAria": "Eventos do Run Kernel",
  "timeline.empty": "Nenhum evento para este filtro ainda.",
  "timeline.cancel": "Cancelar run",
  "timeline.cancelBlocked": "Cancelamento bloqueado",
  "filter.ALL": "Todos os eventos",
  "filter.RUN": "Runs",
  "filter.GATE": "Portão de qualidade",
  "filter.SYSTEM": "Sistema",
  "filter.ENTITY": "Entidade",

  // Entities
  "entities.title": "Entidades de agentes",
  "entities.lastSeen": "Visto às",
  "entities.openAria": "Abrir entidade {name}",
  "entity.runsToday": "Runs hoje",
  "entity.successRate": "Taxa de sucesso",
  "entity.lastSeen": "Visto às",
  "entity.recentEvents": "Eventos recentes",
  "entity.noEvents": "Nenhum evento registrado ainda.",

  // Tier 3
  "tier3.title": "Subsistemas do engine",

  // Top bar
  "topbar.statusAria": "Status do sistema",
  "topbar.scopeAria": "Alternar escopo",
  "topbar.themeAria": "Alternar tema",
  "topbar.clockAria": "Hora atual (UTC)",

  // Icon rail
  "rail.overview": "Visão geral",
  "rail.entities": "Entidades",
  "rail.timeline": "Linha do tempo",
  "rail.projects": "Projetos",
  "rail.settings": "Configurações",
  "rail.permissions": "Permissões",
  "rail.menu": "Menu",
  "rail.language": "Idioma",
  "rail.theme": "Tema",
  "rail.openMenu": "Abrir menu",
  "rail.closeMenu": "Fechar menu",
  "rail.pinMenu": "Fixar menu aberto",
  "rail.unpinMenu": "Desafixar menu",

  // Command palette (⌘K)
  "palette.title": "Menu de comandos",
  "palette.subtitle": "Navegue e ajuste preferências",
  "palette.openAria": "Abrir menu de comandos (⌘K)",
  "palette.placeholder": "Digite um comando ou busque…",
  "palette.empty": "Nenhum resultado.",
  "palette.groupNav": "Navegar",
  "palette.groupPrefs": "Preferências",
  "palette.groupViews": "Visualizações",
  "palette.themeLight": "Tema → Light",
  "palette.themeDark": "Tema → Dark",
  "palette.langEn": "Idioma → English",
  "palette.langPt": "Idioma → Português",
  "palette.classic": "Abrir visão clássica",

  // Ask bar
  "ask.placeholder": "Pergunte ao Nirvana Glance…",
  "ask.send": "Enviar",
  "ask.using": "Usando",
  "ask.clearTarget": "Limpar alvo",
  "ask.hint.squad": "use squad:<slug>",
  "ask.hint.business": "use business:<slug>",
  "ask.state.running": "Em execução",
  "ask.state.completed": "Concluído",
  "ask.state.rolled_back": "Revertido",
  "ask.state.failed": "Falhou",
  "ask.state.no_match": "Sem correspondência",
  "ask.budget": "Orçamento",
  "ask.target": "Alvo",
  "ask.dismiss": "Dispensar",
  "ask.aria": "Barra de perguntas",
  "ask.suggestionsAria": "Sugestões de target",
  "ask.turnCompleted": "Turno concluído — resposta registrada no ledger.",
  "ask.turnFailed": "Turno falhou.",

  // Chat v2 · thread + agentic forms
  "ask.threadAria": "Conversa com o maestro",
  "ask.threadEmpty": "Escolha um fluxo guiado ou pergunte algo — o maestro responde com dados vivos do kernel e gera formulários em tempo real.",
  "ask.flow.diagnose": "Diagnóstico",
  "ask.flow.route": "Rotear tarefa",
  "ask.flow.gate": "Revisar gates",
  "ask.flow.status": "Status",
  "ask.flowsAria": "Fluxos guiados",
  "ask.thinking": "Consultando o kernel…",
  "ask.form.answered": "Respondido",
  "ask.form.source": "kernel ao vivo",
  "ask.form.multiSubmit": "Confirmar seleção",
  "ask.form.inputAria": "Campo do formulário",

  // Drawers
  "drawer.close": "Fechar",
  "drawer.entity.title": "Entidade",
  "drawer.gallery.title": "Todas as entidades",
  "drawer.gallery.squads": "Squads & ferramentas",
  "drawer.gallery.businesses": "Empresas",
  "drawer.projects.title": "Projetos · DAG",
  "drawer.projects.empty": "Nenhum projeto ainda.",
  "drawer.projects.lastRun": "Último run",
  "drawer.projects.duration": "Duração",
  "drawer.settings.title": "Configurações",
  "drawer.settings.core": "Núcleo de configuração",
  "drawer.settings.scope": "Escopo",
  "drawer.settings.scopeHint": "Escopo operacional do Glance.",
  "drawer.settings.actionsGate": "Portão das ações do operador.",
  "drawer.settings.liveHint": "Mudanças aplicam-se ao vivo e são refletidas na TopBar.",
  "drawer.settings.scopeProject": "projeto",
  "drawer.settings.scopeGlobal": "global",
  "drawer.settings.allowActions": "Permitir ações",
  "drawer.settings.allowActionsHint": "Habilita endpoints de escrita (equivale a --allow-actions no nrv glance).",
  "drawer.settings.budget": "Orçamento usado",
  "drawer.settings.idempotency": "Chaves de idempotência",
  "drawer.settings.headless": "Permissões headless",
  "drawer.permissions.title": "Permissões",
  "drawer.permissions.actionsHint": "Habilita cancel inline de runs e ações destrutivas.",
  "drawer.permissions.stateOn": "Estado atual: actions ON — cancel disponível na timeline.",
  "drawer.permissions.stateOff": "Estado atual: actions GATED — cancel retorna 403.",
  "drawer.permissions.readOnly": "Somente leitura por padrão",
  "drawer.permissions.readOnlyHint": "Escrita exige --allow-actions e Idempotency-Key, exatamente como no engine oficial.",
  "drawer.permissions.cancel": "Cancelamento inline de runs em execução",
  "drawer.permissions.scopeChange": "Troca de escopo (projeto ⇄ global)",
  "drawer.permissions.settings": "Escrita de configurações",

  // Toasts / errors
  "toast.settingsFail": "Falha ao salvar configuração.",
  "toast.cancelBlocked": "Cancelamento bloqueado.",
  "toast.cancelOk": "Run cancelado pelo operador.",
  "toast.scopeChanged": "Escopo → {scope}",
  "toast.actionsOn": "Ações habilitadas (--allow-actions on).",
  "toast.actionsOff": "Ações bloqueadas (gated).",
  "error.snapshot": "Falha ao carregar snapshot inicial.",
  "error.turnRequest": "Falha ao enviar mensagem.",
  "error.cancelNetwork": "Falha de rede ao cancelar run.",

  // Classic view
  "classic.title": "Modo clássico",
  "classic.note": "Modo de compatibilidade — one-pager em /",
  "classic.stats": "Estatísticas",
  "classic.name": "Nome",
  "classic.kind": "Tipo",
  "classic.entity": "Entidade",
  "classic.status": "Status",
  "classic.runs": "Runs hoje",
  "classic.lastSeen": "Visto às",
  "classic.events": "Eventos",
  "classic.eventsMeta": "últimos 40 · atualiza a cada 5s · snapshot {at} UTC",
  "classic.refresh": "Atualizar",
  "classic.loading": "carregando…",
  "classic.modernView": "← visão moderna",

  // Data source chip
  "source.simulated": "Kernel simulado",
  "source.engine": "Engine ao vivo",
  "source.hint": "Fonte de dados: {source}",
};

export const DICTIONARIES: Record<Locale, Dictionary> = {
  en,
  "pt-BR": ptBR,
};

export function detectLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "en" || stored === "pt-BR") return stored;
  const nav = window.navigator.language?.toLowerCase() ?? "";
  return nav.startsWith("pt") ? "pt-BR" : DEFAULT_LOCALE;
}

/** Interpolação simples: "Escopo → {scope}" + { scope: "global" } */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}
