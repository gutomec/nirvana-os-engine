// agents-panel.js — the REAL live SSE stream (/api/agents/live) that the
// shipped Agents tab also consumes (glance.js's `this.agentsES`). Module-level
// signals (not component-local) so the EventSource opens exactly once no
// matter how many times Preact re-renders this component — the same
// "subscribe once, read reactively everywhere" property Alpine's
// EventSource-in-a-method pattern has to manage by hand today.
import { html } from "htm/preact";
import { signal, useSignalEffect } from "@preact/signals";
import { Panel } from "./panel.js";

const agents = signal([]);
const summary = signal(null);
const pulses = signal(0);
let streamOpened = false;

function ensureStream() {
  if (streamOpened) return;
  streamOpened = true;
  const es = new EventSource("/api/agents/live");
  const apply = (raw) => {
    const d = JSON.parse(raw);
    agents.value = d.agents || [];
    summary.value = d.summary || null;
  };
  es.addEventListener("snapshot", (e) => apply(e.data));
  es.addEventListener("pulse", (e) => { apply(e.data); pulses.value++; });
}

export function AgentsPanel() {
  useSignalEffect(() => { ensureStream(); });
  return html`
    <${Panel} title="Agentes ao vivo" hint="SSE real de /api/agents/live">
      <p class="text-[10px] text-[var(--text-tertiary)] mb-2">pulsos recebidos nesta sessão: ${pulses.value}</p>
      ${agents.value.length === 0 && html`<p class="text-sm text-[var(--text-tertiary)]">nenhum agente ativo agora</p>`}
      <ul class="flex flex-col gap-1 max-h-64 overflow-auto">
        ${agents.value.map(a => html`
          <li key=${a.trace_id} class="text-sm px-2 py-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
            <b>${a.label}</b> — <span class="text-[var(--text-tertiary)]">${a.status}</span>
            ${a.current_tool && html` · <span class="text-[var(--accent)]">${a.current_tool}</span>`}
          </li>
        `)}
      </ul>
    </${Panel}>
  `;
}
