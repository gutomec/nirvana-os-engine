/* glance.js — Alpine app, fetch helpers, log streaming, navigation */
function glance() {
  return {
    // ─── State ───
    // kind restaurado do localStorage (quick win: lembra a seção entre reloads).
    kind: (typeof localStorage !== 'undefined' && localStorage.getItem('glance.kind')) || 'squads',
    kinds: [
      { id: 'agents', label: 'Agents', icon: 'activity' },
      { id: 'runs', label: 'Runs', icon: 'play' },
      { id: 'squads', label: 'Squads', icon: 'users' },
      { id: 'businesses', label: 'Businesses', icon: 'building-2' },
      { id: 'projects', label: 'Projects', icon: 'folder-kanban' },
      { id: 'mind-clones', label: 'Mind-clones', icon: 'brain' },
      { id: 'memory', label: 'Memory', icon: 'database' },
      { id: 'graph', label: 'Graph', icon: 'share-2' },
      { id: 'cost', label: 'Cost', icon: 'dollar-sign' },
    ],
    // Navegação em pilha do sidebar. LIST_KINDS têm uma lista lateral e entram
    // no Nível 2 (lista ocupa o aside inteiro); os demais são páginas inteiras
    // e ficam no Nível 1 (cartões de tipo). navLevel deriva de kind+kindEntered.
    LIST_KINDS: ['squads', 'businesses', 'projects', 'mind-clones'],
    kindEntered: false,   // true = Nível 2 (lista) para um LIST_KIND
    kindMenuOpen: false,  // popover de troca rápida de tipo no header do Nível 2
    counts: {},
    // Estado de carregamento/erro por lista — distingue "carregando" de "vazio"
    // de "falhou" (antes o catch era silencioso e tudo virava empty-state).
    listLoading: { squads: false, businesses: false, projects: false, 'mind-clones': false },
    listError: { squads: null, businesses: null, projects: null, 'mind-clones': null },

    // ── Live Agents tab state ──
    agents: [],                    // AgentState[] from /api/agents/live SSE
    agentsSummary: null,
    agentsViewMode: 'swimlane',    // 'swimlane' | 'workspace'
    suspiciousFilterOn: false,     // when true, filter agents to is_suspicious_dispatch only
    agentsES: null,                // EventSource handle
    selectedAgent: null,           // detail modal
    _agentsTickerHandle: null,     // status_since_ms ticker
    squads: [],
    businesses: [],
    projects: [],
    runs: [],                      // audit-derived runs grouped by trace_id
    runsFilter: 'recent',          // recent | running | delivered | failed
    runsAutoRefresh: null,         // setInterval handle
    selectedRun: null,             // full run detail (events timeline)
    mindClones: [],
    // Memory layer (state.db) — populated lazily when kind === 'memory'
    memorySubTab: 'decisions',  // decisions | gates | audit
    memoryStats: null,
    decisions: [],
    gates: [],
    auditEvents: [],
    memoryFilters: { project_id: '', phase: '', verdict: '', event: '' },
    memoryExpanded: {},        // { 'decision:D-01': true, 'gate:42': true, ... }
    memoryAddOpen: false,
    memoryAddDraft: { decision_id: '', text: '', source: 'manual', rationale: '' },
    // Graph view
    graph: null,
    graphFilter: 'all',        // all | capabilities | created | squads | businesses | mind-clones | red-yellow
    graphTimeline: null,       // { range: [iso,iso], minMs, maxMs }
    graphTimeMs: null,         // current slider value (epoch ms)
    graphTimeISO: null,
    graphFilteredCount: 0,
    graphPlaying: false,
    graphPlayInterval: null,
    graphLegendOpen: false,    // toggle legend panel under header
    graphSettingsOpen: false,
    graphFullscreen: false,
    graphSelectedNode: null,
    graphSelectedNeighbors: [],
    graphCtrl: null,           // controller returned by renderGraph
    graphPhysics: (() => {
      const def = { linkDistance: 36, charge: -120, collide: 3, alphaDecay: 0.02, nodeScale: 1.0, labelOpacity: 0.7 };
      try {
        const saved = JSON.parse(localStorage.getItem('glance.graphPhysics') || 'null');
        return saved ? Object.assign(def, saved) : def;
      } catch { return def; }
    })(),
    graphColors: (() => {
      const def = {
        squad: '#2563eb', business: '#a855f7', 'mind-clone': '#10b981', capability: '#f59e0b',
        project: '#dc2626', brief: '#fb923c', plan: '#eab308', dag: '#84cc16',
        handoff: '#06b6d4', audit_run: '#8b5cf6', output: '#14b8a6', decision: '#ec4899',
      };
      try {
        const saved = JSON.parse(localStorage.getItem('glance.graphColors') || 'null');
        return saved ? Object.assign(def, saved) : def;
      } catch { return def; }
    })(),
    graphTypeKeys: ['squad', 'business', 'mind-clone', 'capability', 'project', 'brief', 'plan', 'dag', 'handoff', 'audit_run', 'output', 'decision'],
    // Cost dashboard
    cost: null,
    costPeriod: '7d',          // 7d | 30d | all
    // Activity feed (right sidebar)
    activityOpen: true,
    activityEvents: [],
    activityStream: null,
    // Layout chrome — collapsible sidebars + agents fullscreen
    sidebarOpen: (typeof localStorage !== 'undefined' && localStorage.getItem('glance.sidebarOpen') !== '0'),
    rightPaneOpen: (typeof localStorage !== 'undefined' && localStorage.getItem('glance.rightPaneOpen') !== '0'),
    agentsFullscreen: false,
    // Scope filter: 'all' = entire machine, 'project' = only events whose cwd
    // starts with scope.projectRoot. Disabled when no projectRoot is detected.
    projectFilter: (typeof localStorage !== 'undefined' && localStorage.getItem('glance.projectFilter')) || 'all',
    // Setup mode (project scaffolding via Glance)
    // Setup mode (project scaffolding via Glance)
    setupMode: false,
    setupSelected: { squads: {}, businesses: {}, "mind-clones": {} },
    setupStatus: null,
    setupApplying: false,
    // Global source lists (always read from ~/squads, ~/businesses, ~/.../dna)
    // independente do scope ativo — usado pelo Setup mode pra escolher o que copiar.
    setupGlobalSquads: [],
    setupGlobalBusinesses: [],
    setupGlobalMindClones: [],
    // Settings modal state (env editor)
    settingsOpen: false,
    settingsData: null,
    settingsActiveGroup: 'scope',
    settingsScopePicker: 'project',  // 'project' | 'global'
    settingsDraft: {},
    settingsDeletes: {},
    settingsSaving: false,
    settingsRestartRequired: false,
    selected: null,
    detail: null,
    mindCloneContent: null,
    mindCloneDetail: null,         // { files: [...], file_count, total_bytes, format, dir }
    mindCloneActiveFile: null,     // path string of file currently shown
    tab: 'overview',
    orgView: 'tree',
    squadTabs: ['overview', 'manifest', 'capabilities', 'state', 'files'],
    businessTabs: ['overview', 'manifest', 'org-chart', 'routing', 'memory'],
    filterQuery: '',
    filterSource: '',
    searchQuery: '',
    searchResults: [],
    searchDone: false,   // true após uma busca com ≥2 chars retornar (p/ "no results")
    scope: null,
    health: { ok: false, uptime: '' },
    logs: [],
    logType: 'harness',
    logStream: null,
    showHero: false,
    toast: { visible: false, message: '' },
    // Actions / Console drawer state
    consoleOpen: false,
    activeJobId: null,
    jobs: [],
    jobOutputs: {},
    jobStreams: {},
    // Per-kind audit scores: { squads: { slug: {tier, score} }, businesses: ..., 'mind-clones': ... }
    auditScores: { squads: {}, businesses: {}, 'mind-clones': {} },

    // ─── Computed ───
    get currentList() {
      // Setup mode: list assets from the GLOBAL library (independent of NIRVANA_SCOPE)
      // so the user can see everything available to copy into the project.
      if (this.setupMode) {
        if (this.kind === 'squads') return this.setupGlobalSquads;
        if (this.kind === 'businesses') return this.setupGlobalBusinesses;
        if (this.kind === 'mind-clones') return this.setupGlobalMindClones.map(m => ({
          slug: `${m.category}/${m.slug}`, source: m.source, category: m.category, _mc: m
        }));
      }
      if (this.kind === 'squads') return this.squads;
      if (this.kind === 'businesses') return this.businesses;
      if (this.kind === 'projects') return this.projects;
      if (this.kind === 'mind-clones') return this.mindClones.map(m => ({
        // Display slug: canonical persona name only; the category appears as subtitle.
        // For top-level personas (category === '_root') we drop the synthetic prefix.
        slug: m.slug,
        // Unique key across categories — used by isSelected / filter
        id: `${m.category}/${m.slug}`,
        source: m.source,
        category: m.category === '_root' ? null : m.category,
        format: m.format,
        _mc: m,
      }));
      return [];
    },
    get filteredList() {
      const q = this.filterQuery.toLowerCase();
      const src = this.filterSource;
      return this.currentList.filter(item => {
        const slugStr = (item.slug || item.id || '').toLowerCase();
        if (q && !slugStr.includes(q) && !(item.domains || []).some(d => d.toLowerCase().includes(q))) return false;
        if (src && item.source !== src) return false;
        return true;
      });
    },
    get kindLabel() {
      return (this.kinds.find(k => k.id === this.kind) || {}).label?.toLowerCase() || 'item';
    },

    // ─── Boot ───
    async boot() {
      // Restaura o Nível 2 se o reload pegou o usuário navegando uma lista.
      try {
        if (this.isListKind(this.kind) && localStorage.getItem('glance.kindEntered') === '1') {
          this.kindEntered = true;
        }
      } catch {}
      // Histórico de chats + hash router (deep-link).
      this.loadChatHistory();
      this.applyHash();
      window.addEventListener('hashchange', () => this.applyHash());
      // Awwwards hero only on awwwards theme
      const theme = document.documentElement.dataset.theme;
      if (theme === 'awwwards') {
        this.showHero = true;
        setTimeout(() => { this.showHero = false; }, 1800);
      }

      // Global hotkeys: Esc exits agents fullscreen; ⌘\ / Ctrl+\ toggles sidebar; ⌘. / Ctrl+. toggles right pane
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.agentsFullscreen) {
          this.agentsFullscreen = false;
          this.$nextTick(() => { try { window.lucide?.createIcons(); } catch {} });
        }
        if (e.key === 'Escape' && this.graphFullscreen) {
          this.graphFullscreen = false;
          this.$nextTick(() => { try { window.lucide?.createIcons(); } catch {} this.renderGraphNow({ autoFit: true }); });
        }
        if (e.key === 'Escape' && this.graphSettingsOpen) {
          this.graphSettingsOpen = false;
        }
        if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); this.toggleSidebar(); }
        if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); this.toggleRightPane(); }
      });

      // Lucide icons are auto-rendered by the inline initLucide IIFE in index.html.
      // No additional observer needed here — that one handles initial + new <i> stubs.

      // When setup mode toggles on, always refresh both status and global sources.
      // This is a safety net in case toggleSetupMode is bypassed (e.g. state restored).
      this.$watch('setupMode', (v) => {
        if (v) {
          this.fetchSetupStatus();
          this.fetchSetupSources();
        }
      });
      // Ao trocar project↔global no settings, recarrega as regras daquele scope.
      this.$watch('settingsScopePicker', () => { if (this.settingsOpen && this.rulesData) this.loadRulesDraft(); });

      await this.refreshAll();

      // Cmd-K focuses search · ESC navigates back from detail
      window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          document.querySelector('input[placeholder*="Search"]')?.focus();
          return;
        }
        if (e.key === 'Escape') {
          // Don't fight inputs/textareas where ESC has its own meaning
          const t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          // Close search dropdown first if open
          if (this.searchResults.length > 0 || this.searchDone) { this.searchResults = []; this.searchDone = false; return; }
          // Then close console drawer if open
          if (this.consoleOpen) { this.consoleOpen = false; return; }
          // Then close memory add modal if open
          if (this.memoryAddOpen) { this.memoryAddOpen = false; return; }
          // Pilha de navegação: detalhe → lista → cartões de tipo
          if (this.selected) { this.goBack(); return; }
          if (this.navLevel === 'list') { this.backToKinds(); return; }
        }
      });

      // Health refresh every 30s
      setInterval(() => this.fetchHealth(), 30_000);

      // Logs SSE
      this.startLogStream();

      // Activity feed SSE (right sidebar)
      try { this.startActivityStream(); } catch {}

      // Watch kind changes to load lazy data for memory/graph/cost views
      this.$watch?.('kind', (k) => {
        if (k === 'memory' && this.decisions.length === 0) this.refreshMemory();
        else if (k === 'graph' && !this.graph) this.fetchGraph();
        else if (k === 'cost' && !this.cost) this.fetchCost();
        else if (k === 'agents') this.startAgentsStream();
        // close agents SSE when leaving (saves resources)
        if (k !== 'agents') this.stopAgentsStream();
      });
      this.$watch?.('memorySubTab', () => {
        if (this.kind === 'memory') {
          if (this.memorySubTab === 'gates') this.fetchGates();
          if (this.memorySubTab === 'audit') this.fetchAuditEvents();
          if (this.memorySubTab === 'decisions') this.fetchDecisions();
        }
      });
      this.$watch?.('memoryFilters.project_id', () => { if (this.kind === 'memory') this.refreshMemory(); });

      // Re-render charts when tab changes (their containers are created
      // lazily by x-if; we have to wait for the DOM to mount).
      this.$watch('tab', (next) => this.renderActiveChart(next));

      // Periodically refresh job list when actions are enabled
      setInterval(() => { if (this.health.allow_actions) this.refreshJobs(); }, 5000);
    },

    renderActiveChart(tab) {
      if (!tab) tab = this.tab;
      this.$nextTick(() => {
        if (this.kind === 'businesses' && tab === 'org-chart' && this.detail?.org_chart_raw && window.renderOrgChart) {
          window.renderOrgChart('#org-chart-canvas', this.detail.org_chart_raw);
        }
        if (this.kind === 'projects' && tab === 'dag' && this.detail?.dag && window.renderDag) {
          window.renderDag('#dag-canvas', this.detail.dag);
        }
      });
    },

    async refreshAll() {
      await Promise.all([
        this.fetchScope(),
        this.fetchSquads(),
        this.fetchBusinesses(),
        this.fetchProjects(),
        this.fetchRuns(),
        this.fetchMindClones(),
        this.fetchHealth(),
        this.fetchAuditScores(),
        this.fetchSetupSources(),
        this.fetchSetupStatus(),
      ]);
      this.flash(`refreshed · ${this.squads.length} squads, ${this.businesses.length} bus`);
    },

    // ─── Audit scores (squads/businesses/mind-clones) ───
    async fetchAuditScores() {
      const endpoints = [
        { kind: 'squads',       url: '/api/audit/report' },
        { kind: 'businesses',   url: '/api/businesses/audit/report' },
        { kind: 'mind-clones',  url: '/api/mind-clones/audit/report' },
      ];
      await Promise.all(endpoints.map(async ({ kind, url }) => {
        try {
          const r = await api(url);
          if (!r || !Array.isArray(r.scores)) return;
          const map = {};
          for (const s of r.scores) {
            const key = kind === 'mind-clones' ? `${s.category}/${s.slug}` : s.slug;
            map[key] = { tier: s.tier, score: s.score };
          }
          this.auditScores[kind] = map;
        } catch {}
      }));
    },
    scoreFor(item) {
      const map = this.auditScores[this.kind] || {};
      const key = item.slug || item.id || '';
      return map[key] || null;
    },
    /**
     * Aggregate audit summary for a given kind:
     *   { total, green, yellow, red, avg, allGreen }
     * Returns null when there's no audit data for that kind yet.
     */
    auditSummary(kind) {
      const map = this.auditScores[kind];
      if (!map) return null;
      const entries = Object.values(map);
      if (entries.length === 0) return null;
      const counts = { green: 0, yellow: 0, red: 0 };
      let sum = 0;
      for (const e of entries) {
        counts[e.tier] = (counts[e.tier] || 0) + 1;
        sum += e.score || 0;
      }
      const total = entries.length;
      return {
        total,
        green: counts.green,
        yellow: counts.yellow,
        red: counts.red,
        avg: Math.round(sum / total),
        allGreen: counts.green === total,
      };
    },

    // ─── Fetch ───
    async fetchScope()    { try { this.scope = await api('/api/scope'); } catch(e) {} },
    async fetchHealth()   { try { const h = await api('/api/health'); this.health = { ...h, ok: h.ok, uptime: humanizeMs(h.uptime_ms) }; } catch(e) {} },
    async fetchSquads()   { this.listLoading.squads = true; this.listError.squads = null; try { const r = await api('/api/squads'); this.squads = r.squads; this.counts.squads = r.squads.length; } catch(e) { this.listError.squads = e.message || 'failed'; this.flash(`✗ squads: ${e.message || 'load failed'}`, 3000); } finally { this.listLoading.squads = false; } },
    async fetchBusinesses(){ this.listLoading.businesses = true; this.listError.businesses = null; try { const r = await api('/api/businesses'); this.businesses = r.businesses; this.counts.businesses = r.businesses.length; } catch(e) { this.listError.businesses = e.message || 'failed'; this.flash(`✗ businesses: ${e.message || 'load failed'}`, 3000); } finally { this.listLoading.businesses = false; } },
    async fetchProjects() { this.listLoading.projects = true; this.listError.projects = null; try { const r = await api(`/api/projects${this.projectQuery('?')}`); this.projects = r.projects; this.counts.projects = r.projects.length; } catch(e) { this.listError.projects = e.message || 'failed'; this.flash(`✗ projects: ${e.message || 'load failed'}`, 3000); } finally { this.listLoading.projects = false; } },
    async fetchRuns(opts = {}) {
      try {
        const r = await api(`/api/runs?days=7&limit=200${this.projectQuery()}`);
        this.runs = r.runs || [];
        this.counts.runs = r.total || this.runs.length;
        // If a run is selected, refresh its detail
        if (this.selectedRun?.trace_id && opts.refreshDetail !== false) {
          const updated = this.runs.find(x => x.trace_id === this.selectedRun.trace_id);
          if (updated) this.selectedRun = updated;
        }
      } catch (e) {}
    },
    selectRun(run) {
      this.selectedRun = run;
    },
    runStatusColor(status) {
      if (status === 'delivered') return 'meta-ok';
      if (status === 'gate_failed' || status === 'no_match') return 'meta-bad';
      if (status === 'running') return 'meta-pending';
      return '';
    },
    runEventColor(event) {
      if (event === 'brief_received' || event === 'brief_amplified') return '#3b82f6';
      if (event === 'delivered' || event === 'gate_passed') return '#10b981';
      if (event === 'gate_failed' || event.startsWith('validation_')) return '#ef4444';
      if (event === 'tool_invoked' || event === 'artifact_touched' || event === 'bash_completed') return '#8b5cf6';
      if (event.startsWith('dispatch_')) return '#a855f7';
      if (event === 'cost_emission') return '#9ca3af';
      return '#64748b';
    },
    runRelTime(iso) {
      if (!iso) return '';
      // Clamp negative diffs to 0 — events from machines with skewed clocks
      // were rendering as huge positive numbers (-150000h ago bug).
      const ms = Math.max(0, Date.now() - new Date(iso).getTime());
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}min ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(iso).toLocaleDateString();
    },
    startRunsAutoRefresh() {
      if (this.runsAutoRefresh) return;
      this.runsAutoRefresh = setInterval(() => {
        if (this.kind === 'runs') this.fetchRuns({ refreshDetail: true });
      }, 5000);
    },
    stopRunsAutoRefresh() {
      if (this.runsAutoRefresh) { clearInterval(this.runsAutoRefresh); this.runsAutoRefresh = null; }
    },
    async fetchMindClones(){ this.listLoading['mind-clones'] = true; this.listError['mind-clones'] = null; try { const r = await api('/api/mind-clones'); this.mindClones = r.mind_clones; this.counts['mind-clones'] = r.mind_clones.length; } catch(e) { this.listError['mind-clones'] = e.message || 'failed'; this.flash(`✗ mind-clones: ${e.message || 'load failed'}`, 3000); } finally { this.listLoading['mind-clones'] = false; } },

    // ─── Memory layer (state.db) ───
    async fetchMemoryStats() {
      try { this.memoryStats = await api('/api/memory/stats'); }
      catch (e) { this.memoryStats = { available: false, error: String(e) }; }
    },
    async fetchDecisions() {
      const q = new URLSearchParams();
      if (this.memoryFilters.project_id) q.set('project_id', this.memoryFilters.project_id);
      q.set('limit', '200');
      try {
        const r = await api(`/api/decisions?${q}${this.projectQuery()}`);
        this.decisions = r.decisions || [];
      } catch (e) { this.decisions = []; }
    },
    async fetchGates() {
      const q = new URLSearchParams();
      if (this.memoryFilters.project_id) q.set('project_id', this.memoryFilters.project_id);
      if (this.memoryFilters.phase) q.set('phase', this.memoryFilters.phase);
      if (this.memoryFilters.verdict) q.set('verdict', this.memoryFilters.verdict);
      q.set('limit', '100');
      try {
        const r = await api(`/api/gates?${q}${this.projectQuery()}`);
        this.gates = r.gates || [];
      } catch (e) { this.gates = []; }
    },
    async fetchAuditEvents() {
      const q = new URLSearchParams();
      if (this.memoryFilters.event) q.set('event', this.memoryFilters.event);
      if (this.memoryFilters.project_id) q.set('project_id', this.memoryFilters.project_id);
      q.set('limit', '200');
      try {
        const r = await api(`/api/audit/events?${q}${this.projectQuery()}`);
        this.auditEvents = r.events || [];
      } catch (e) { this.auditEvents = []; }
    },
    async fetchMemory() {
      // Refetch the visible memory tab when project filter changes
      try {
        const list = [];
        if (this.kind === 'memory') {
          if (this.memorySubTab === 'decisions') list.push(this.fetchDecisions());
          else if (this.memorySubTab === 'gates') list.push(this.fetchGates());
          else if (this.memorySubTab === 'audit') list.push(this.fetchAuditEvents());
        }
        await Promise.all(list);
      } catch {}
    },
    restartAgentsStream() {
      try { this.stopAgentsStream && this.stopAgentsStream(); } catch {}
      if (this.kind === 'agents') {
        try { this.startAgentsStream && this.startAgentsStream(); } catch {}
      }
    },
    restartActivityStream() {
      try { if (this.activityStream) this.activityStream.close(); } catch {}
      try { this.startActivityStream && this.startActivityStream(); } catch {}
    },
    async refreshMemory() {
      await Promise.all([this.fetchMemoryStats(), this.fetchDecisions(), this.fetchGates(), this.fetchAuditEvents()]);
    },
    toggleMemoryRow(key) {
      this.memoryExpanded[key] = !this.memoryExpanded[key];
    },
    async addDecision() {
      if (!this.memoryAddDraft.decision_id || !this.memoryAddDraft.text) {
        this.toast = { visible: true, message: 'decision_id + text obrigatórios' };
        setTimeout(() => { this.toast.visible = false; }, 2500);
        return;
      }
      try {
        const r = await fetch('/api/decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision_id: this.memoryAddDraft.decision_id,
            text: this.memoryAddDraft.text,
            source: this.memoryAddDraft.source || 'glance',
            rationale: this.memoryAddDraft.rationale || null,
            project_id: this.memoryFilters.project_id || undefined,
          }),
        });
        const data = await r.json();
        if (data.ok) {
          this.toast = { visible: true, message: `decision ${this.memoryAddDraft.decision_id} salva` };
          this.memoryAddOpen = false;
          this.memoryAddDraft = { decision_id: '', text: '', source: 'manual', rationale: '' };
          await this.fetchDecisions();
        } else {
          this.toast = { visible: true, message: data.error || 'erro ao salvar' };
        }
        setTimeout(() => { this.toast.visible = false; }, 2500);
      } catch (e) { this.toast = { visible: true, message: String(e) }; setTimeout(() => { this.toast.visible = false; }, 2500); }
    },

    // ─── Graph view (knowledge graph) ───
    async fetchGraph() {
      try { this.graph = await api(`/api/graph${this.projectQuery('?')}`); }
      catch (e) { this.graph = { nodes: [], edges: [] }; }
      // Compute temporal range from nodes with created_at
      const stamps = (this.graph?.nodes || [])
        .map(n => n.created_at)
        .filter(Boolean)
        .sort();
      if (stamps.length >= 2) {
        const minMs = new Date(stamps[0]).getTime();
        const maxMs = new Date(stamps[stamps.length - 1]).getTime();
        this.graphTimeline = { range: [stamps[0], stamps[stamps.length - 1]], minMs, maxMs };
        this.graphTimeMs = maxMs;
        this.graphTimeISO = new Date(maxMs).toISOString();
      } else {
        this.graphTimeline = null;
        this.graphTimeMs = null;
        this.graphTimeISO = null;
      }
      this.renderGraphNow();
    },
    renderGraphNow(opts = {}) {
      // Tear down previous instance so the simulation/listeners don't leak
      try { this.graphCtrl?.dispose?.(); } catch {}
      this.graphCtrl = null;
      setTimeout(() => {
        if (!window.renderGraph || !this.graph) return;
        this.graphCtrl = window.renderGraph('#graph-canvas', this.graph, {
          filter: this.graphFilter,
          timeFilterISO: this.graphTimeISO,
          physics: this.graphPhysics,
          colors: this.graphColors,
          onNodeSelect: (node) => this.onGraphNodeSelect(node),
        });
        // Compute visible count
        const cutoff = this.graphTimeISO;
        this.graphFilteredCount = (this.graph.nodes || []).filter(n => !n.created_at || !cutoff || n.created_at <= cutoff).length;
        // Auto-fit-to-extent: by default true on filter change. Wait for the
        // sim to do a few ticks so nodes have positions before we measure.
        if (opts.autoFit !== false) {
          setTimeout(() => this.graphCtrl?.fitToExtent?.(80), 600);
        }
      }, 50);
    },
    setGraphFilter(filter) {
      this.graphFilter = filter;
      this.clearGraphSelection();
      this.renderGraphNow({ autoFit: true });
    },
    graphFitView() {
      this.graphCtrl?.fitToExtent?.(80);
    },
    toggleGraphLegend() {
      this.graphLegendOpen = !this.graphLegendOpen;
      this.$nextTick?.(() => window.lucide?.createIcons?.());
    },
    toggleGraphSettings() {
      this.graphSettingsOpen = !this.graphSettingsOpen;
      this.$nextTick?.(() => window.lucide?.createIcons?.());
    },
    toggleGraphFullscreen() {
      this.graphFullscreen = !this.graphFullscreen;
      this.$nextTick?.(() => {
        try { window.lucide?.createIcons?.(); } catch {}
        // Resize the simulation viewport
        this.renderGraphNow({ autoFit: true });
      });
    },
    applyGraphPhysics() {
      try { localStorage.setItem('glance.graphPhysics', JSON.stringify(this.graphPhysics)); } catch {}
      this.graphCtrl?.updatePhysics?.(this.graphPhysics);
    },
    setGraphColor(type, hex) {
      this.graphColors[type] = hex;
      try { localStorage.setItem('glance.graphColors', JSON.stringify(this.graphColors)); } catch {}
      this.graphCtrl?.updateColors?.(this.graphColors);
    },
    resetGraphSettings() {
      this.graphPhysics = { linkDistance: 36, charge: -120, collide: 3, alphaDecay: 0.02, nodeScale: 1.0, labelOpacity: 0.7 };
      this.graphColors = {
        squad: '#2563eb', business: '#a855f7', 'mind-clone': '#10b981', capability: '#f59e0b',
        project: '#dc2626', brief: '#fb923c', plan: '#eab308', dag: '#84cc16',
        handoff: '#06b6d4', audit_run: '#8b5cf6', output: '#14b8a6', decision: '#ec4899',
      };
      try { localStorage.removeItem('glance.graphPhysics'); localStorage.removeItem('glance.graphColors'); } catch {}
      this.graphCtrl?.updatePhysics?.(this.graphPhysics);
      this.graphCtrl?.updateColors?.(this.graphColors);
    },
    onGraphNodeSelect(node) {
      this.graphSelectedNode = node || null;
      if (!node) { this.graphSelectedNeighbors = []; return; }
      const ids = new Set();
      for (const e of (this.graph?.edges || [])) {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        const t = typeof e.target === 'string' ? e.target : e.target.id;
        if (s === node.id) ids.add(t);
        if (t === node.id) ids.add(s);
      }
      this.graphSelectedNeighbors = (this.graph?.nodes || []).filter(n => ids.has(n.id));
      this.$nextTick?.(() => window.lucide?.createIcons?.());
    },
    selectGraphNode(node) {
      this.onGraphNodeSelect(node);
      this.graphCtrl?.select?.(node.id);
    },
    centerGraphNode(id) {
      this.graphCtrl?.centerOn?.(id);
    },
    clearGraphSelection() {
      this.graphSelectedNode = null;
      this.graphSelectedNeighbors = [];
      this.graphCtrl?.select?.(null);
    },
    onGraphTimeInput(evt) {
      const ms = Number(evt.target.value);
      if (!Number.isFinite(ms)) return;
      this.graphTimeMs = ms;
      this.graphTimeISO = new Date(ms).toISOString();
      this.renderGraphNow();
    },
    setGraphTime(iso) {
      const ms = new Date(iso).getTime();
      this.graphTimeMs = ms;
      this.graphTimeISO = iso;
      this.renderGraphNow();
    },
    toggleGraphPlay() {
      if (this.graphPlaying) {
        clearInterval(this.graphPlayInterval);
        this.graphPlayInterval = null;
        this.graphPlaying = false;
      } else if (this.graphTimeline) {
        this.graphPlaying = true;
        // Restart from beginning if at end
        if (this.graphTimeMs >= this.graphTimeline.maxMs) {
          this.graphTimeMs = this.graphTimeline.minMs;
        }
        const totalSpan = this.graphTimeline.maxMs - this.graphTimeline.minMs;
        const stepMs = Math.max(1000, Math.floor(totalSpan / 60));
        this.graphPlayInterval = setInterval(() => {
          this.graphTimeMs += stepMs;
          if (this.graphTimeMs >= this.graphTimeline.maxMs) {
            this.graphTimeMs = this.graphTimeline.maxMs;
            clearInterval(this.graphPlayInterval);
            this.graphPlayInterval = null;
            this.graphPlaying = false;
          }
          this.graphTimeISO = new Date(this.graphTimeMs).toISOString();
          this.renderGraphNow();
        }, 250);
      }
    },
    graphTypeColor(type) {
      const c = {
        squad: '#2563eb', business: '#a855f7', 'mind-clone': '#10b981', capability: '#f59e0b',
        project: '#dc2626', brief: '#fb923c', plan: '#eab308', dag: '#84cc16',
        handoff: '#06b6d4', audit_run: '#8b5cf6', output: '#14b8a6', decision: '#ec4899',
      };
      return c[type] || '#64748b';
    },
    navigateToNode(node) {
      if (!node) return;
      if (node.type === 'squad') { this.kind = 'squads'; setTimeout(() => this.select({ slug: node.slug }), 100); }
      else if (node.type === 'business') { this.kind = 'businesses'; setTimeout(() => this.select({ slug: node.slug }), 100); }
      else if (node.type === 'mind-clone') {
        this.kind = 'mind-clones';
        const [cat, sl] = node.slug.split('/');
        setTimeout(() => this.select({ slug: node.slug, category: cat, _mc: { category: cat, slug: sl, source: node.source || 'global' } }), 100);
      }
    },

    // ─── Cost dashboard ───
    async fetchCost() {
      try { this.cost = await api(`/api/cost/summary?period=${this.costPeriod}${this.projectQuery()}`); }
      catch (e) { this.cost = null; }
      setTimeout(() => {
        if (window.renderCostCharts && this.cost) {
          window.renderCostCharts(this.cost);
        }
      }, 50);
    },
    setCostPeriod(p) { this.costPeriod = p; this.fetchCost(); },

    // ─── Live Agents (Agents tab SSE) ───
    startAgentsStream() {
      if (this.agentsES) { try { this.agentsES.close(); } catch {} }
      this.agentsES = new EventSource('/api/agents/live' + this.projectQuery('?'));
      this.agentsES.addEventListener('snapshot', (e) => {
        try {
          const d = JSON.parse(e.data);
          this.agents = d.agents || [];
          this.agentsSummary = d.summary || null;
          // re-render swimlanes after Alpine updates DOM
          this.$nextTick(() => this.renderAllSwimlanes());
          // re-render workspace if active
          if (this.agentsViewMode === 'workspace' && window.__agentWorkspace) {
            window.__agentWorkspace.syncAgents(this.agents);
          }
        } catch {}
      });
      this.agentsES.addEventListener('status_change', (e) => {
        try {
          const d = JSON.parse(e.data);
          // optional: brief flash animation; for now just rely on snapshot to redraw
          console.debug('[agents] status change:', d.trace_id, d.from, '→', d.to);
        } catch {}
      });
      // ticker that updates "X seconds ago" displays without polling backend
      if (!this._agentsTickerHandle) {
        this._agentsTickerHandle = setInterval(() => {
          // No-op trigger to make Alpine re-evaluate `agentRelativeTime` getters
          if (this.kind === 'agents') this.agents = [...this.agents];
        }, 1000);
      }
    },
    stopAgentsStream() {
      if (this.agentsES) { try { this.agentsES.close(); } catch {} this.agentsES = null; }
      if (this._agentsTickerHandle) { clearInterval(this._agentsTickerHandle); this._agentsTickerHandle = null; }
    },
    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
      try { localStorage.setItem('glance.sidebarOpen', this.sidebarOpen ? '1' : '0'); } catch {}
      this.$nextTick(() => { try { window.lucide?.createIcons(); } catch {} });
    },
    toggleRightPane() {
      this.rightPaneOpen = !this.rightPaneOpen;
      try { localStorage.setItem('glance.rightPaneOpen', this.rightPaneOpen ? '1' : '0'); } catch {}
      this.$nextTick(() => { try { window.lucide?.createIcons(); } catch {} });
    },
    // ── Project scope filter ──
    canFilterByProject() {
      return !!(this.scope && this.scope.projectRoot);
    },
    // URL helper: returns the param suffix to attach to backend requests when
    // the user has selected "Project" mode. Empty string when filter is off
    // or when no projectRoot is available.
    projectQuery(prefix = '&') {
      if (this.projectFilter !== 'project' || !this.canFilterByProject()) return '';
      return `${prefix}project=${encodeURIComponent(this.scope.projectRoot)}`;
    },
    setProjectFilter(mode) {
      // 'all' | 'project' — silently ignore 'project' if no root detected
      if (mode === 'project' && !this.canFilterByProject()) return;
      const changed = this.projectFilter !== mode;
      this.projectFilter = mode;
      try { localStorage.setItem('glance.projectFilter', mode); } catch {}
      if (changed) {
        // Refetch every backend-aggregated view so Cost / Runs / Memory match
        // what's shown for Agents / Activity. Squads/businesses/mind-clones
        // intentionally NOT refetched — those stay global.
        try { this.fetchRuns && this.fetchRuns(); } catch {}
        try { this.fetchCost && this.fetchCost(); } catch {}
        try { this.fetchMemory && this.fetchMemory(); } catch {}
        try { this.fetchProjects && this.fetchProjects(); } catch {}
        try { this.fetchGraph && this.fetchGraph(); } catch {}
        try { this.restartAgentsStream && this.restartAgentsStream(); } catch {}
        try { this.restartActivityStream && this.restartActivityStream(); } catch {}
      }
      this.$nextTick(() => this.renderAllSwimlanes && this.renderAllSwimlanes());
    },
    matchesCurrentProject(item) {
      if (this.projectFilter !== 'project' || !this.canFilterByProject()) return true;
      const root = (this.scope.projectRoot || '').replace(/\/+$/, '');
      if (!root) return true;

      // 1. Direct cwd prefix match (most reliable — works for any agent CLI)
      if (item.cwd && (item.cwd === root || item.cwd.startsWith(root + '/'))) return true;

      // 2. Fallback for project_id. Claude Code stores transcripts under
      //    ~/.claude/projects/-Users-guto-foo-bar/, and our importer turns that
      //    back into "Users/guto/foo/bar" — every "-" becomes "/" indiscriminately,
      //    so a real "nirvana-os" path is encoded as "nirvana/os". We can't reverse
      //    that perfectly, but for matching we normalise BOTH sides by treating
      //    "/" and "-" as the same separator and lowercasing.
      if (item.project_id) {
        const norm = (s) => s.toLowerCase().replace(/[\\/_\-]+/g, '/').replace(/^\/+|\/+$/g, '');
        const rootN = norm(root);
        const pidN = norm(item.project_id);
        if (pidN === rootN || pidN.startsWith(rootN + '/')) return true;
      }
      return false;
    },
    get visibleAgents() {
      let list = this.agents;
      if (this.projectFilter === 'project' && this.canFilterByProject()) {
        list = list.filter(a => this.matchesCurrentProject(a));
      }
      if (this.suspiciousFilterOn) {
        list = list.filter(a => a.is_suspicious_dispatch);
      }
      return list;
    },
    suspiciousDispatchCount() {
      let list = this.agents;
      if (this.projectFilter === 'project' && this.canFilterByProject()) {
        list = list.filter(a => this.matchesCurrentProject(a));
      }
      return list.filter(a => a.is_suspicious_dispatch).length;
    },
    toggleSuspiciousDispatchFilter() {
      this.suspiciousFilterOn = !this.suspiciousFilterOn;
      this.$nextTick(() => this.renderAllSwimlanes && this.renderAllSwimlanes());
    },
    get visibleAgentsSummary() {
      if (this.projectFilter !== 'project' || !this.canFilterByProject()) return this.agentsSummary;
      const list = this.visibleAgents;
      const out = { tool_in_flight: 0, running: 0, idle: 0, waiting: 0, stale: 0, completed: 0, failed: 0, no_match: 0, total: 0 };
      for (const s of list) { out[s.status] = (out[s.status] || 0) + 1; out.total++; }
      return out;
    },
    get visibleRuns() {
      if (this.projectFilter !== 'project' || !this.canFilterByProject()) return this.runs;
      return this.runs.filter(r => this.matchesCurrentProject(r));
    },
    get visibleActivityEvents() {
      if (this.projectFilter !== 'project' || !this.canFilterByProject()) return this.activityEvents;
      return this.activityEvents.filter(e => this.matchesCurrentProject(e));
    },

    toggleAgentsFullscreen() {
      this.agentsFullscreen = !this.agentsFullscreen;
      this.$nextTick(() => {
        try { window.lucide?.createIcons(); } catch {}
        // resize PixiJS canvas if active
        if (this.agentsViewMode === 'workspace' && window.__agentWorkspace?._handleResize) {
          window.__agentWorkspace._handleResize();
        }
        // re-render swimlanes to fit new width
        if (this.agentsViewMode === 'swimlane') this.renderAllSwimlanes();
      });
    },
    renderAllSwimlanes() {
      if (!window.renderAgentSwimlane) return;
      for (const a of this.agents) {
        const el = document.querySelector(`[data-agent-swimlane="${a.trace_id}"]`);
        if (el) {
          try { window.renderAgentSwimlane(el, a.recent_events || []); } catch {}
        }
      }
    },
    selectAgent(agent) { this.selectedAgent = agent; },
    closeAgentDetail() { this.selectedAgent = null; },
    agentStatusColor(status) {
      const colors = {
        tool_in_flight: '#facc15',  // amber-400 (pulse)
        running: '#22c55e',          // green-500
        idle: '#94a3b8',             // slate-400 (alive but inference-only)
        waiting: '#3b82f6',          // blue-500
        stale: '#f59e0b',            // amber-500
        completed: '#10b981',        // emerald-500
        failed: '#ef4444',           // red-500
        no_match: '#a3a3a3',         // neutral-400
      };
      return colors[status] || '#64748b';
    },
    // Map status → token variant (success/warn/danger/info/neutral)
    agentStatusVariant(status) {
      return ({
        tool_in_flight: 'warn',
        running: 'success',
        idle: 'neutral',
        waiting: 'info',
        stale: 'warn',
        completed: 'success',
        failed: 'danger',
        no_match: 'neutral',
      })[status] || 'neutral';
    },
    runStatusVariant(status) {
      return ({
        running: 'warn',
        delivered: 'success',
        gate_failed: 'danger',
        no_match: 'danger',
        stale: 'neutral',
        unknown: 'neutral',
      })[status] || 'neutral';
    },
    gateVariant(verdict) {
      return ({ pass: 'success', fail: 'danger', needs_revision: 'warn', skipped: 'neutral' })[verdict] || 'neutral';
    },
    agentStatusLabel(status) {
      const labels = {
        tool_in_flight: 'Tool in flight',
        running: 'Running',
        idle: 'Idle',
        waiting: 'Waiting',
        stale: 'Stale',
        completed: 'Completed',
        failed: 'Failed',
        no_match: 'No match',
      };
      return labels[status] || status;
    },
    agentHostIcon(host) {
      // Lucide icon names; UI swaps via [data-lucide]
      const icons = {
        'claude-code': 'sparkles',
        'claude-code-hook': 'sparkles',
        'gemini-cli': 'gem',
        'gemini-cli-hook': 'gem',
        'codex': 'code-2',
        'fs-watch': 'folder-search',
      };
      return icons[host] || 'bot';
    },
    formatAgentDuration(ms) {
      if (!ms || ms < 0) ms = 0;
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${s % 60}s`;
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    },
    // ── Mind-clone chip helpers (Phase D) ──
    mindCloneChipText(agent) {
      const inj = (agent.injected_mind_clones || []).length;
      const dec = (agent.declared_mind_clones || []).length;
      return `${inj}/${dec}`;
    },
    mindCloneChipTitle(agent) {
      if (!agent || !agent.declared_mind_clones?.length) return '';
      if (agent.is_suspicious_dispatch) {
        const miss = (agent.missing_mind_clones || []).join(', ');
        return `⚠ ${(agent.missing_mind_clones || []).length} mind-clone(s) declared but not injected: ${miss}`;
      }
      const inj = (agent.injected_mind_clones || []).length;
      return `${inj} mind-clone(s) injected (sha-verified)`;
    },

    // ── Mind-clone detail helpers ──
    mindCloneFileGroups() {
      const files = this.mindCloneDetail?.files || [];
      const groups = new Map();
      const order = ['agent', 'dna', 'playbooks', 'dossiers', 'memory', '_root', 'other'];
      const labels = { agent: 'Agent', dna: 'DNA', playbooks: 'Playbooks', dossiers: 'Dossiers', memory: 'Memory', _root: 'Root', other: 'Other' };
      for (const f of files) {
        const key = order.includes(f.category) ? f.category : 'other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }
      return order.filter(k => groups.has(k)).map(k => ({ label: labels[k] || k, files: groups.get(k) }));
    },
    mindCloneActiveFileObj() {
      const files = this.mindCloneDetail?.files || [];
      return files.find(f => f.path === this.mindCloneActiveFile) || null;
    },
    selectMindCloneFile(path) {
      this.mindCloneActiveFile = path;
      // Re-render lucide icons in the newly visible content area
      this.$nextTick(() => { try { window.lucide?.createIcons(); } catch {} });
    },
    async copyMindCloneFile() {
      const f = this.mindCloneActiveFileObj();
      if (!f?.content) return;
      try { await navigator.clipboard.writeText(f.content); this.flash(`copied ${f.path}`); }
      catch (e) { this.flash(`copy failed`); }
    },
    formatBytes(n) {
      if (!n) return '0 B';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    },

    formatTokens(n) {
      if (!n) return '0';
      if (n < 1000) return String(n);
      if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
      return (n / 1_000_000).toFixed(2) + 'M';
    },
    formatUSD(n) {
      if (!n || n < 0.01) return '<$0.01';
      if (n < 10) return '$' + n.toFixed(2);
      if (n < 1000) return '$' + n.toFixed(1);
      return '$' + Math.round(n);
    },

    // ─── Activity feed (right sidebar SSE) ───
    startActivityStream() {
      if (this.activityStream) try { this.activityStream.close(); } catch {}
      this.activityStream = new EventSource('/api/activity/stream' + this.projectQuery('?'));
      this.activityStream.addEventListener('snapshot', (e) => {
        try { const d = JSON.parse(e.data); this.activityEvents = d.events || []; } catch {}
      });
      this.activityStream.addEventListener('event', (e) => {
        try {
          const ev = JSON.parse(e.data);
          this.activityEvents.unshift(ev);
          if (this.activityEvents.length > 50) this.activityEvents.length = 50;
        } catch {}
      });
    },
    activityIcon(event) {
      const icons = {
        stall_detected: '⚠', stall_retry: '↻', loop_detected: '∞',
        approval_granted: '✓', approval_rejected: '✗', approval_checkpoint: '◇',
        gate_failed: '✗', validation_failed: '✗', context_budget_warning: '⚡',
        humanization_applied: '✨', invocation_start: '▶', invocation_end: '■',
        handoff: '↪', resume: '↶',
      };
      return icons[event] || '·';
    },
    navigateFromActivity(ev) {
      if (!ev) return;
      // If event has a project_id, jump to projects view
      if (ev.project_id) {
        this.kind = 'projects';
        setTimeout(() => this.select({ id: ev.project_id }), 100);
      }
    },
    activityRelative(ts) {
      if (!ts) return '';
      const d = (Date.now() - new Date(ts).getTime()) / 1000;
      if (d < 60) return `${Math.round(d)}s ago`;
      if (d < 3600) return `${Math.round(d / 60)}m ago`;
      if (d < 86400) return `${Math.round(d / 3600)}h ago`;
      return `${Math.round(d / 86400)}d ago`;
    },

    // ─── Setup mode (overlay on lists) ───
    async toggleSetupMode() {
      this.setupMode = !this.setupMode;
      if (this.setupMode) {
        // When activating Setup, prefer to view a kind that has items to pick from
        if (!['squads','businesses','mind-clones'].includes(this.kind)) this.kind = 'squads';
        await Promise.all([
          this.fetchSetupStatus(),
          this.fetchSetupSources(),
        ]);
      }
    },
    async fetchSetupSources() {
      try {
        const [s, b, m] = await Promise.all([
          api('/api/setup/source?kind=squads'),
          api('/api/setup/source?kind=businesses'),
          api('/api/setup/source?kind=mind-clones'),
        ]);
        this.setupGlobalSquads = s.items || [];
        this.setupGlobalBusinesses = b.items || [];
        this.setupGlobalMindClones = m.items || [];
      } catch (e) {
        this.toast = { visible: true, message: 'failed to load global sources: ' + (e.message || e) };
        setTimeout(() => { this.toast.visible = false; }, 3000);
      }
    },
    async fetchSetupStatus() {
      try { this.setupStatus = await api('/api/setup/status'); }
      catch { this.setupStatus = null; }
    },
    isLocalCopy(kind, slug) {
      // For mind-clones the source list (setupGlobalMindClones) carries per-item
      // `local` flag computed by the backend (`<category>/<slug>.md` presence).
      // For squads/businesses we still compare against /api/setup/status local lists.
      if (kind === 'mind-clones') {
        const item = (this.setupGlobalMindClones || []).find(m => `${m.category}/${m.slug}` === slug);
        return !!item?.local;
      }
      const list = this.setupStatus?.local?.[kind] || [];
      return list.includes(String(slug).split('/').pop());
    },
    toggleSetupSelection(kind, slug) {
      if (!this.setupSelected[kind]) this.setupSelected[kind] = {};
      if (this.setupSelected[kind][slug]) delete this.setupSelected[kind][slug];
      else this.setupSelected[kind][slug] = true;
    },
    isItemPicked(kind, slug) {
      return !!this.setupSelected[kind]?.[slug];
    },
    setupSelectionCount() {
      return Object.keys(this.setupSelected.squads || {}).length
           + Object.keys(this.setupSelected.businesses || {}).length
           + Object.keys(this.setupSelected['mind-clones'] || {}).length;
    },
    setupSelectAll(kind) {
      if (!this.setupSelected[kind]) this.setupSelected[kind] = {};
      // Use the list as currently displayed (respects search/source filter and
      // setup-mode global override). filteredList already maps mind-clones to
      // `${category}/${slug}` slugs.
      for (const item of this.filteredList) {
        const slug = item.slug || item.id;
        if (slug) this.setupSelected[kind][slug] = true;
      }
    },
    setupClearAll() {
      this.setupSelected = { squads: {}, businesses: {}, 'mind-clones': {} };
    },
    async applySetup() {
      const items = [];
      for (const slug of Object.keys(this.setupSelected.squads || {})) items.push({ kind: 'squads', slug });
      for (const slug of Object.keys(this.setupSelected.businesses || {})) items.push({ kind: 'businesses', slug });
      for (const slug of Object.keys(this.setupSelected['mind-clones'] || {})) items.push({ kind: 'mind-clones', slug });
      if (items.length === 0) {
        this.toast = { visible: true, message: 'nothing selected' };
        setTimeout(() => { this.toast.visible = false; }, 2000);
        return;
      }
      const target = this.setupStatus?.project_root;
      if (!target) { this.toast = { visible: true, message: 'project_root not detected' }; setTimeout(()=>{this.toast.visible=false},2500); return; }
      this.setupApplying = true;
      try {
        if (!this.setupStatus?.has_nirvana) {
          const initR = await fetch('/api/setup/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_dir: target, scope: 'merge' }),
          }).then(r => r.json());
          if (!initR.ok) { throw new Error(initR.error || 'init failed'); }
        }
        const r = await fetch('/api/setup/copy-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_dir: target, items, overwrite: false }),
        }).then(r => r.json());
        if (r.ok || r.applied > 0) {
          this.toast = { visible: true, message: `copied ${r.applied} of ${items.length} to ${target.split('/').slice(-2).join('/')}` };
          await this.fetchSetupStatus();
          await this.refreshAll();
        } else {
          this.toast = { visible: true, message: r.error || 'copy failed' };
        }
      } catch (e) {
        this.toast = { visible: true, message: String(e.message || e) };
      } finally {
        this.setupApplying = false;
        setTimeout(() => { this.toast.visible = false; }, 3500);
      }
    },
    mindClonesDiagnosticIssues() {
      return this.setupStatus?.mind_clones_diagnostic?.issues || [];
    },
    mindClonesDiagnosticSummary() {
      const d = this.setupStatus?.mind_clones_diagnostic;
      if (!d) return '';
      const broken = (d.issues || []).filter(i => i.kind === 'broken_symlink').length;
      const missing = (d.issues || []).filter(i => i.kind === 'missing_dir').length;
      const cats = d.categories || [];
      const brokenCats = cats.filter(c => c.broken).length;
      const healthyCats = cats.filter(c => !c.broken).length;
      const parts = [];
      if (broken) parts.push(`${broken} broken symlink${broken === 1 ? '' : 's'} — external volume not mounted`);
      if (missing) parts.push(`${missing} missing dir${missing === 1 ? '' : 's'}`);
      parts.push(`${brokenCats}/${cats.length} categories broken · ${healthyCats} healthy · ${d.total_mind_clones} mind-clones loadable`);
      return parts.join(' · ');
    },
    // ─── Settings modal (env editor) ───
    // ─── Chat (Fase 3) — painel de conversa que opera o Nirvana ──
    chatOpen: false,
    chatId: null,              // trace_id/project_id da session ativa
    chatMessages: [],          // [{role:'user'|'assistant'|'system', text, events:[], streaming}]
    chatInput: '',
    chatBusy: false,
    chatRunEvents: [],         // eventos de audit da trace ativa (timeline ao vivo)
    chatRunES: null,           // EventSource do /api/runs/:id/stream
    chatMode: 'run',           // 'run' (novo dispatch) | 'revise' | 'resume'
    chatHistory: [],           // [{id, title, mode, updatedAt}] persistido em localStorage
    chatHistoryOpen: false,    // drawer de histórico dentro do painel

    // Histórico de chats (localStorage — o transcript completo vem do /api/runs).
    loadChatHistory() {
      try { this.chatHistory = JSON.parse(localStorage.getItem('glance.chatHistory') || '[]'); } catch { this.chatHistory = []; }
    },
    saveChatToHistory() {
      if (!this.chatId) return;
      const title = (this.chatMessages.find(m => m.role === 'user')?.text || 'Nova conversa').slice(0, 60);
      const existing = this.chatHistory.findIndex(c => c.id === this.chatId);
      const entry = { id: this.chatId, title, mode: this.chatMode, updatedAt: Date.now() };
      if (existing >= 0) this.chatHistory[existing] = entry; else this.chatHistory.unshift(entry);
      this.chatHistory = this.chatHistory.slice(0, 30);
      try { localStorage.setItem('glance.chatHistory', JSON.stringify(this.chatHistory)); } catch {}
    },
    async openChatFromHistory(entry) {
      this.chatId = entry.id;
      this.chatMode = 'revise';   // continuar via revise
      this.chatHistoryOpen = false;
      this.chatMessages = [{ role: 'system', text: `Continuando a conversa "${entry.title}".` }];
      // Reidrata a timeline a partir do audit trail da trace.
      try {
        const run = await api(`/api/runs/${encodeURIComponent(entry.id)}`);
        if (run?.brief) this.chatMessages.push({ role: 'user', text: run.brief });
        this.chatRunEvents = run?.events || [];
      } catch {}
      this.chatOpen = true;
      this.subscribeRun(entry.id);
    },
    deleteChatFromHistory(id) {
      this.chatHistory = this.chatHistory.filter(c => c.id !== id);
      try { localStorage.setItem('glance.chatHistory', JSON.stringify(this.chatHistory)); } catch {}
    },

    // Abre o chat apontado para um run existente, para continuar a session.
    openChatForRun(run) {
      this.chatId = run.trace_id;
      this.chatMode = run.resumable ? 'revise' : 'resume';
      this.chatMessages = [{ role: 'system', text: run.resumable
        ? `Continuando a session ${run.session_id?.slice(0,12)} (${run.session_runtime}). Escreva a mudança que quer.`
        : `Retomando o projeto ${run.trace_id.slice(0,20)} em contexto novo.` }];
      this.chatOpen = true;
      this.subscribeRun(run.trace_id);
    },

    // ─── Runtime routing rules (USE_* / NOT_USE_*) — aba especial do settings ──
    rulesData: null,           // { project:[{key,value}], global:[], runtimes:[] }
    rulesDraft: [],            // [{ envKey, mode:'use'|'not', runtime, text }]
    rulesLoading: false,
    async openSettings() {
      this.settingsOpen = true;
      this.settingsRestartRequired = false;
      await Promise.all([this.fetchSettings(), this.fetchRules()]);
    },
    async fetchRules() {
      this.rulesLoading = true;
      try {
        this.rulesData = await api('/api/config/rules');
        this.loadRulesDraft();
      } catch (e) { this.rulesData = null; }
      finally { this.rulesLoading = false; }
    },
    // Converte as regras do scope ativo em linhas editáveis {mode,runtime,text}.
    loadRulesDraft() {
      const RT = { CLAUDE_CODE: 'claude-code', CLAUDE: 'claude-code', CODEX: 'codex', GEMINI: 'gemini-cli', GEMINI_CLI: 'gemini-cli', ANTIGRAVITY: 'antigravity-cli', ANTIGRAVITY_CLI: 'antigravity-cli', AGY: 'antigravity-cli', HERMES: 'hermes' };
      const src = (this.rulesData?.[this.settingsScopePicker] || []);
      this.rulesDraft = src.map(r => {
        const m = r.key.match(/^(NOT_USE|USE)_([A-Z0-9_]+)$/);
        const mode = m && m[1] === 'NOT_USE' ? 'not' : 'use';
        const runtime = m ? (RT[m[2]] || 'claude-code') : 'claude-code';
        return { mode, runtime, text: r.value };
      });
    },
    addRule() { this.rulesDraft.push({ mode: 'use', runtime: 'codex', text: '' }); },
    removeRule(i) { this.rulesDraft.splice(i, 1); },
    // Serializa as linhas de volta em chaves USE_<RT>/NOT_USE_<RT>.
    rulesToEnv() {
      const SUFFIX = { 'claude-code': 'CLAUDE_CODE', 'codex': 'CODEX', 'gemini-cli': 'GEMINI', 'antigravity-cli': 'ANTIGRAVITY', 'hermes': 'HERMES' };
      const out = {};
      for (const r of this.rulesDraft) {
        if (!r.text.trim()) continue;
        const key = (r.mode === 'not' ? 'NOT_USE_' : 'USE_') + (SUFFIX[r.runtime] || 'CODEX');
        out[key] = r.text.trim();
      }
      return out;
    },
    async saveRules() {
      if (!this.rulesData?.allow_actions) return;
      const updates = this.rulesToEnv();
      // Deleta as chaves que existiam mas sumiram do draft.
      const existing = (this.rulesData?.[this.settingsScopePicker] || []).map(r => r.key);
      const deletes = existing.filter(k => !(k in updates));
      try {
        const r = await fetch('/api/config/rules', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: this.settingsScopePicker, updates, deletes }),
        }).then(x => x.json());
        if (r.ok) { this.flash(`✓ ${r.applied_count} regra(s) salva(s) → ${this.settingsScopePicker} .env`); await this.fetchRules(); }
        else { this.flash(`✗ ${r.error || 'falhou'}`, 3000); }
      } catch (e) { this.flash(`✗ ${e.message}`, 3000); }
    },
    closeSettings() {
      if (this.settingsPendingCount() > 0) {
        if (!confirm('Discard staged changes?')) return;
      }
      this.settingsOpen = false;
      this.settingsDraft = {};
      this.settingsDeletes = {};
    },
    async fetchSettings() {
      try {
        this.settingsData = await api('/api/config');
        this.settingsDraft = {};
        this.settingsDeletes = {};
        if (!this.settingsActiveGroup && this.settingsData?.groups?.length) {
          this.settingsActiveGroup = this.settingsData.groups[0].id;
        }
      } catch (e) {
        this.settingsData = null;
        this.toast = { visible: true, message: `Failed to load settings: ${e.message || e}` };
        setTimeout(() => { this.toast.visible = false; }, 3000);
      }
    },
    settingsActiveGroupObj() {
      return (this.settingsData?.groups || []).find(g => g.id === this.settingsActiveGroup);
    },
    settingsPendingCount() {
      let count = 0;
      const idx = new Map();
      for (const g of this.settingsData?.groups || []) for (const f of g.fields) idx.set(f.key, f);
      for (const [k, v] of Object.entries(this.settingsDraft)) {
        const f = idx.get(k);
        if (!f) continue;
        // Sensitive blank means "leave unchanged"
        if (f.sensitive && v === '') continue;
        // Staged delete (__DELETE__ + flag) counts
        if (v === '__DELETE__' && this.settingsDeletes[k]) { count++; continue; }
        if (v === '__DELETE__') continue;
        const current = this.settingsScopePicker === 'project' ? f.project_value : f.global_value;
        if (v !== current) count++;
      }
      return count;
    },
    async saveSettings() {
      if (!this.settingsData?.allow_actions) return;
      this.settingsSaving = true;
      try {
        const updates = {};
        const deletes = [];
        const idx = new Map();
        for (const g of this.settingsData.groups) for (const f of g.fields) idx.set(f.key, f);
        for (const [k, v] of Object.entries(this.settingsDraft)) {
          const f = idx.get(k);
          if (!f) continue;
          if (v === '__DELETE__' || this.settingsDeletes[k]) { deletes.push(k); continue; }
          // Sensitive blank = skip (leave unchanged)
          if (f.sensitive && v === '') continue;
          const current = this.settingsScopePicker === 'project' ? f.project_value : f.global_value;
          if (v === current) continue;
          updates[k] = v;
        }
        if (Object.keys(updates).length === 0 && deletes.length === 0) {
          this.toast = { visible: true, message: 'no changes to save' };
          setTimeout(() => { this.toast.visible = false; }, 1800);
          this.settingsSaving = false;
          return;
        }
        const r = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: this.settingsScopePicker, updates, deletes }),
        }).then(x => x.json());
        if (r.ok) {
          const liveMsg = r.live_reloaded
            ? `saved & live · ${r.applied_count} change${r.applied_count === 1 ? '' : 's'} → ${this.settingsScopePicker} .env`
            : `saved ${r.applied_count} change${r.applied_count === 1 ? '' : 's'} to ${this.settingsScopePicker} .env (restart required)`;
          this.toast = { visible: true, message: liveMsg };
          this.settingsRestartRequired = !r.live_reloaded;
          this.settingsDraft = {};
          this.settingsDeletes = {};
          await this.fetchSettings();
          // Refresh the rest of the UI (scope header, lists) so changes are
          // visible immediately instead of waiting for next manual reload.
          await this.refreshAll();
        } else {
          this.toast = { visible: true, message: r.error || 'save failed' };
        }
        setTimeout(() => { this.toast.visible = false; }, 3000);
      } catch (e) {
        this.toast = { visible: true, message: String(e.message || e) };
        setTimeout(() => { this.toast.visible = false; }, 3000);
      }
      this.settingsSaving = false;
    },
    async restartGlance() {
      if (!confirm('Restart Glance now? You will need to re-launch it manually.')) return;
      try {
        await fetch('/api/config/restart', { method: 'POST' });
        this.toast = { visible: true, message: 'Glance is shutting down. Re-run: bun ~/.nirvana/skills/harness/scripts/glance.ts --allow-actions' };
      } catch (e) {
        this.toast = { visible: true, message: 'restart request failed: ' + (e.message || e) };
      }
    },
    // ─── Chat: métodos (Fase 3) ───
    openChat() {
      // Chat livre: novo dispatch com auto-route. Gera um chatId.
      this.chatId = 'chat-' + Date.now().toString(36);
      this.chatMode = 'run';
      this.chatMessages = [];
      this.chatRunEvents = [];
      this.chatOpen = true;
    },
    closeChat() {
      this.chatOpen = false;
      if (this.chatRunES) { this.chatRunES.close(); this.chatRunES = null; }
    },
    // Assina o stream de eventos de audit de uma trace (timeline ao vivo).
    subscribeRun(traceId) {
      if (this.chatRunES) { this.chatRunES.close(); this.chatRunES = null; }
      this.chatRunEvents = [];
      const es = new EventSource(`/api/runs/${encodeURIComponent(traceId)}/stream`);
      es.addEventListener('snapshot', (e) => { try { this.chatRunEvents = JSON.parse(e.data).events || []; } catch {} });
      es.addEventListener('event', (e) => { try { this.chatRunEvents.push(JSON.parse(e.data)); } catch {} });
      es.addEventListener('done', () => { es.close(); });
      es.onerror = () => { /* mantém — reabre no próximo turno */ };
      this.chatRunES = es;
    },
    // Rótulo humano de um evento de audit (os 5 de ouro + o resto).
    chatEventLabel(ev) {
      const map = {
        agentic_route_decision: 'Roteou', dispatch_business: 'Despachou empresa', dispatch_squad: 'Despachou squad',
        mind_clone_injected: 'Injetou mind-clone', agent_executed: 'Executou', gate_passed: 'Passou no gate',
        gate_failed: 'Falhou no gate', delivered: 'Entregou', routing_rule_applied: 'Regra de runtime',
        team_chain_selected: 'Montou o time', research_completed: 'Pesquisou', brief_received: 'Recebeu o brief',
      };
      return map[ev.event] || ev.event;
    },
    // Envia um turno. run → chat-run (novo dispatch); revise/resume → continua a session.
    async sendChat() {
      const msg = this.chatInput.trim();
      if (!msg || this.chatBusy) return;
      this.chatInput = '';
      this.chatMessages.push({ role: 'user', text: msg });
      const asst = { role: 'assistant', text: '', events: [], streaming: true };
      this.chatMessages.push(asst);
      this.chatBusy = true;
      this.$nextTick(() => this.scrollChatBottom());
      // Assina a trace deste turno para a timeline ao vivo.
      this.subscribeRun(this.chatId);
      const action = this.chatMode === 'revise' ? 'chat-revise' : (this.chatMode === 'resume' ? 'chat-resume' : 'chat-run');
      const body = { chat_id: this.chatId, message: msg, max_budget: '0.50' };
      try {
        const r = await fetch(`/api/actions/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
        if (r.error) { asst.text = `✗ ${r.error}`; asst.streaming = false; this.chatBusy = false; return; }
        // Depois do 1º turno bem-sucedido, os próximos continuam a session.
        if (this.chatMode === 'run') this.chatMode = 'revise';
        // Segue o job pela SSE de stdout; a resposta chega no fim (bloco).
        this.followChatJob(r.job.id, asst);
      } catch (e) {
        asst.text = `✗ ${e.message}`; asst.streaming = false; this.chatBusy = false;
      }
    },
    followChatJob(jobId, asst) {
      const es = new EventSource(`/api/actions/jobs/${jobId}/stream`);
      let buf = [];
      const onLine = (line) => {
        buf.push(line);
        // Espelha os passos de progresso na timeline (linhas com ▶/✓).
        asst.text = buf.filter(l => /▶|✓|✗|→/.test(l)).slice(-8).join('\n') || 'orquestrando…';
        this.$nextTick(() => this.scrollChatBottom());
      };
      es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.line) onLine(d.line); if (d.kind === 'done' || d.status) { /* fim */ } } catch {} };
      es.addEventListener('line', (e) => { try { onLine(JSON.parse(e.data).line || ''); } catch {} });
      es.addEventListener('done', () => {
        es.close();
        asst.streaming = false;
        asst.text = buf.join('\n').trim() || '(sem saída)';
        asst.events = [...this.chatRunEvents];
        this.chatBusy = false;
        this.saveChatToHistory();
        try { location.hash = `#/chat/${this.chatId}`; } catch {}
        this.$nextTick(() => { this.scrollChatBottom(); try { window.lucide?.createIcons(); } catch {} });
      });
      es.onerror = () => { es.close(); asst.streaming = false; this.chatBusy = false; };
    },
    scrollChatBottom() {
      const el = document.querySelector('.chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    },
    renderMd(text) {
      try { return window.marked ? window.marked.parse(text || '', { breaks: true }) : this.escapeHtml(text); }
      catch { return this.escapeHtml(text); }
    },
    escapeHtml(text) {
      return String(text || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>');
    },

    // ─── Deep-link por hash: #/chat/<id>, #/<kind>, #/<kind>/<slug> ───
    applyHash() {
      const h = (location.hash || '').replace(/^#\/?/, '');
      if (!h) return;
      const parts = h.split('/');
      if (parts[0] === 'chat' && parts[1]) {
        const entry = this.chatHistory.find(c => c.id === parts[1]) || { id: parts[1], title: 'conversa', mode: 'revise' };
        this.openChatFromHistory(entry);
        return;
      }
      const kindIds = this.kinds.map(k => k.id);
      if (kindIds.includes(parts[0])) {
        this.enterKind(parts[0]);
        if (parts[1] && this.isListKind(parts[0])) {
          // seleciona o item quando as listas já carregaram
          this.$nextTick(() => { const it = (this.currentList || []).find(x => (x.slug || x.id) === parts[1]); if (it) this.select(it); });
        }
      }
    },

    // ─── Navigation (pilha: kinds → lista → detalhe) ───
    isListKind(id) { return this.LIST_KINDS.includes(id || this.kind); },
    // 'kinds' = Nível 1 (cartões de tipo); 'list' = Nível 2 (lista full-height).
    get navLevel() { return (this.isListKind() && this.kindEntered) ? 'list' : 'kinds'; },
    // Entrar num tipo pelo menu. LIST_KIND → Nível 2; view-kind → troca a página
    // e mantém o Nível 1 (o cartão fica destacado). Persiste a seção.
    enterKind(id) {
      this.kind = id;
      this.selected = null;
      this.detail = null;
      this.kindEntered = this.isListKind(id);
      try { localStorage.setItem('glance.kind', id); } catch {}
      try { localStorage.setItem('glance.kindEntered', this.kindEntered ? '1' : '0'); } catch {}
    },
    // Voltar do Nível 2 para o Nível 1 (lista → cartões de tipo).
    backToKinds() {
      this.selected = null;
      this.detail = null;
      this.kindEntered = false;
      try { localStorage.setItem('glance.kindEntered', '0'); } catch {}
    },
    goBack() {
      this.selected = null;
      this.detail = null;
      this.mindCloneContent = null;
      // Stop any DAG poll started for the selected project
      if (this._dagPoll) { clearInterval(this._dagPoll); this._dagPoll = null; }
    },

    // ─── Selection ───
    async select(item) {
      this.selected = item;
      this.tab = this.kind === 'projects' ? 'dag' : (this.kind === 'businesses' ? 'overview' : 'overview');
      this.detail = null;
      this.mindCloneContent = null;
      try {
        if (this.kind === 'squads') {
          this.detail = await api(`/api/squads/${encodeURIComponent(item.slug)}`);
        } else if (this.kind === 'businesses') {
          this.detail = await api(`/api/businesses/${encodeURIComponent(item.slug)}`);
          // If user is already on the org-chart tab, render immediately;
          // otherwise the $watch on `tab` will trigger render when they switch.
          this.renderActiveChart();
        } else if (this.kind === 'projects') {
          this.detail = await api(`/api/projects/${encodeURIComponent(item.id)}/dag`);
          // Render DAG when ready
          this.$nextTick(() => {
            if (window.renderDag && this.detail?.dag) {
              window.renderDag('#dag-canvas', this.detail.dag);
            }
          });
          // Auto-refresh DAG every 5s
          if (this._dagPoll) clearInterval(this._dagPoll);
          this._dagPoll = setInterval(async () => {
            try {
              const fresh = await api(`/api/projects/${encodeURIComponent(item.id)}/dag`);
              this.detail = fresh;
              if (window.renderDag && fresh.dag) window.renderDag('#dag-canvas', fresh.dag);
            } catch(e) {}
          }, 5000);
        } else if (this.kind === 'mind-clones') {
          const mc = item._mc;
          const r = await api(`/api/mind-clones/${encodeURIComponent(mc.category)}/${encodeURIComponent(mc.slug)}`);
          this.mindCloneContent = r.content;        // legacy concatenation
          this.mindCloneDetail = r;
          // Auto-select the first file (AGENT.md typically — already sorted by priority backend-side)
          this.mindCloneActiveFile = r.files?.[0]?.path || null;
        }
      } catch(e) { this.flash(`err: ${e.message}`); }
    },

    isSelected(item) {
      if (!this.selected) return false;
      // Match per-kind: squads/businesses/mind-clones use slug, projects use id.
      // Important: never let undefined === undefined evaluate to true (which
      // would make every list row appear active).
      const itemKey = item.slug ?? item.id;
      const selKey = this.selected.slug ?? this.selected.id;
      if (itemKey == null || selKey == null) return false;
      return itemKey === selKey;
    },

    itemSubtitle(item) {
      if (item.version) return `v${item.version} · ${(item.domains || []).slice(0,3).join(', ')}`;
      if (item.brief_preview) return item.brief_preview.slice(0, 60).replace(/\n/g, ' ');
      if (item.category) return item.category;
      return '';
    },

    // ─── Theme cycle ───
    cycleTheme() {
      const seq = ['apple', 'apple-dark', 'awwwards'];
      const cur = document.documentElement.dataset.theme || 'apple';
      const next = seq[(seq.indexOf(cur) + 1) % seq.length];
      document.documentElement.dataset.theme = next;
      this.flash(`theme: ${next}`);
      // Re-render charts so their colors follow the new theme
      this.renderActiveChart();
    },

    // ─── Search ───
    async runSearch() {
      const q = this.searchQuery.trim();
      if (q.length < 2) { this.searchResults = []; this.searchDone = false; return; }
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
        this.searchResults = r.results;
        this.searchDone = true;   // marca que uma busca com ≥2 chars retornou
      } catch(e) { this.searchResults = []; this.searchDone = true; }
    },
    onSearchPick(r) {
      this.searchQuery = '';
      this.searchResults = [];
      this.searchDone = false;
      const map = { 'squad': 'squads', 'business': 'businesses', 'mind-clone': 'mind-clones' };
      // Entra no tipo (Nível 2) antes de selecionar o item — a lista aparece full-height.
      this.enterKind(map[r.kind] || 'squads');
      this.$nextTick(() => {
        let item;
        if (r.kind === 'mind-clone') {
          const [cat, slug] = r.slug.split('/');
          item = this.mindClones.find(m => m.category === cat && m.slug === slug);
          if (item) item = { slug: r.slug, source: r.source, category: cat, _mc: item };
        } else if (r.kind === 'squad') {
          item = this.squads.find(s => s.slug === r.slug);
        } else if (r.kind === 'business') {
          item = this.businesses.find(b => b.slug === r.slug);
        }
        if (item) this.select(item);
      });
    },

    // ─── Logs ───
    restartLogStream() {
      if (this.logStream) { this.logStream.close(); this.logStream = null; }
      this.logs = [];
      this.startLogStream();
    },
    startLogStream() {
      try {
        const es = new EventSource(`/api/logs/stream?type=${this.logType}`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.kind === 'snapshot') this.logs = data.events || [];
            else if (data.kind === 'tick') this.logs = data.events || [];
          } catch(err) {}
        };
        es.onerror = () => { /* will retry automatically by browser */ };
        this.logStream = es;
      } catch(e) {}
    },

    logKindLabel(e) {
      if (e.classification) return e.classification;
      if (e.event_type) return e.event_type;
      if (e.stage) return `stage-${e.stage}`;
      if (e.event) return e.event;
      return 'event';
    },
    logKindClass(e) {
      const lbl = (this.logKindLabel(e) || '').toString().toLowerCase();
      if (lbl.includes('high')) return 'log-kind-decision-high';
      if (lbl.includes('ambiguous')) return 'log-kind-decision-ambiguous';
      if (lbl.includes('no_match') || lbl.includes('nomatch')) return 'log-kind-decision-no_match';
      if (lbl.includes('route')) return 'log-kind-route';
      return 'log-kind-event';
    },
    logSummary(e) {
      if (e.brief) return e.brief.slice(0, 80);
      if (e.message) return e.message.slice(0, 80);
      if (e.target) return `→ ${e.target}`;
      if (e.target_business || e.target_squad) return `→ ${e.target_business || e.target_squad}`;
      const keys = Object.keys(e).filter(k => !['timestamp','ts','event_type','event','classification','stage','_file'].includes(k));
      if (keys.length) return keys.slice(0,2).map(k => `${k}=${JSON.stringify(e[k]).slice(0,30)}`).join(' ');
      return '';
    },

    // ─── Capability parser ───
    // Registry stores capabilities as string ids in the form "<domain>.<noun>.<verb>"
    // e.g. "design.guided_analysis.execute". Some squads may store full objects.
    parseCapability(c) {
      if (typeof c === 'string') {
        const parts = c.split('.');
        if (parts.length >= 3) {
          const verb = parts[parts.length - 1];
          const domain = parts[0];
          const noun = parts.slice(1, -1).join('.');
          return { id: c, domain, noun, verb };
        }
        return { id: c, domain: '—', noun: c, verb: '—' };
      }
      return { id: c.id || '', domain: c.domain || '—', noun: c.noun || '', verb: c.verb || '' };
    },

    // ─── Markdown lite (just headings + code spans, no deps) ───
    renderMarkdownLite(md) {
      if (!md) return '';
      return md
        .replace(/[<>]/g, c => ({ '<': '&lt;', '>': '&gt;' }[c]))
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
    },

    // ─── Actions ───
    async runAction(name, body) {
      try {
        const r = await fetch(`/api/actions/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const data = await r.json();
        if (!r.ok) {
          this.flash(`✗ ${name}: ${data.error || r.status}`, 4000);
          return;
        }
        this.flash(`▶ ${name} started`, 1500);
        this.consoleOpen = true;
        this.activeJobId = data.job.id;
        this.jobs.unshift(data.job);
        this.jobOutputs[data.job.id] = [];
        this.tailJob(data.job.id);
      } catch (e) {
        this.flash(`✗ ${e.message}`, 4000);
      }
    },
    confirmAction(name, body, prompt) {
      if (!window.confirm(prompt)) return;
      this.runAction(name, body);
    },
    tailJob(id) {
      // Avoid double-stream
      if (this.jobStreams[id]) return;
      const es = new EventSource(`/api/actions/jobs/${id}/stream`);
      this.jobStreams[id] = es;
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.kind === 'snapshot') {
            this.jobOutputs[id] = ev.lines || [];
          } else if (ev.kind === 'line') {
            this.jobOutputs[id] = [...(this.jobOutputs[id] || []), ev.line];
          } else if (ev.kind === 'done') {
            es.close();
            delete this.jobStreams[id];
            this.refreshJobs();
          }
          // Auto-scroll
          this.$nextTick(() => {
            const el = this.$refs.jobOutput;
            if (el) el.scrollTop = el.scrollHeight;
          });
        } catch {}
      };
      es.onerror = () => { es.close(); delete this.jobStreams[id]; };
    },
    async refreshJobs() {
      try {
        const r = await fetch('/api/actions/jobs');
        const data = await r.json();
        this.jobs = data.jobs || [];
      } catch {}
    },
    async cancelJob(id) {
      if (!window.confirm('Cancel this job?')) return;
      await fetch(`/api/actions/${id}/cancel`, { method: 'POST' }).catch(() => {});
      // Endpoint mismatch — use actions/jobs/:id/cancel
      await fetch(`/api/actions/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
      this.refreshJobs();
    },
    getJob(id) { return this.jobs.find(j => j.id === id); },
    renderIcons() {
      if (typeof window.lucide === 'undefined' || typeof window.lucide.createIcons !== 'function') return;
      try {
        window.lucide.createIcons({
          attrs: { 'stroke-width': '1.75', 'aria-hidden': 'true' },
        });
      } catch (_) {}
    },
    statusIcon(status) {
      return ({ running: 'circle-dot', completed: 'check', failed: 'x', cancelled: 'ban', queued: 'circle' })[status] || 'help-circle';
    },
    statusGlyph(status) {
      return ({ running: '●', completed: '✓', failed: '✗', cancelled: '⊘', queued: '◌' })[status] || '?';
    },
    formatJobTime(j) {
      if (j.finished_at) {
        const ms = j.finished_at - j.started_at;
        return `${Math.round(ms/100)/10}s ago`;
      }
      const ms = Date.now() - j.started_at;
      return `${Math.round(ms/100)/10}s elapsed`;
    },

    // ─── Toast ───
    flash(msg, ms = 1800) {
      this.toast = { visible: true, message: msg };
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast.visible = false; }, ms);
    },
  };
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function humanizeMs(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
