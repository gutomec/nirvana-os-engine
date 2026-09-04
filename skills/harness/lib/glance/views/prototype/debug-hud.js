// debug-hud.js — "mensurável" made literal: real Content-Length bytes read
// off this same running server for every prototype file versus the real
// glance.js, via HEAD requests. No estimate, no marketing number — whatever
// this panel shows is what the server actually served just now.
import { html } from "htm/preact";
import { useSignal, useSignalEffect } from "@preact/signals";
import { Panel } from "./panel.js";

const FILES = [
  { path: "/prototype/app.js", label: "app.js (bootstrap)" },
  { path: "/prototype/panel.js", label: "panel.js (componente reusável)" },
  { path: "/prototype/businesses-panel.js", label: "businesses-panel.js" },
  { path: "/prototype/agents-panel.js", label: "agents-panel.js" },
  { path: "/prototype/debug-hud.js", label: "debug-hud.js (este arquivo)" },
];
const BASELINE = { path: "/glance.js", label: "glance.js — Glance real, um arquivo com todo o estado do app" };

export function DebugHud() {
  const sizes = useSignal({});
  useSignalEffect(() => {
    Promise.all([...FILES, BASELINE].map(f =>
      fetch(f.path, { method: "HEAD" }).then(r => [f.path, Number(r.headers.get("content-length") || 0)])
    )).then(entries => { sizes.value = Object.fromEntries(entries); });
  });

  const kb = (bytes) => (bytes / 1024).toFixed(1);
  const prototypeTotal = FILES.reduce((sum, f) => sum + (sizes.value[f.path] || 0), 0);
  const baselineSize = sizes.value[BASELINE.path] || 0;

  return html`
    <${Panel} title="Debug HUD" hint="Content-Length real via HEAD, não estimativa">
      <ul class="text-xs flex flex-col gap-1">
        ${FILES.map(f => html`
          <li key=${f.path} class="flex justify-between">
            <span class="text-[var(--text-secondary)]">${f.label}</span>
            <span class="text-[var(--text-tertiary)]">${kb(sizes.value[f.path] || 0)} KB</span>
          </li>
        `)}
        <li class="flex justify-between border-t border-[var(--border-subtle)] pt-1 mt-1">
          <span class="text-[var(--text-primary)] font-medium">total do prototype (5 arquivos)</span>
          <span class="text-[var(--text-primary)] font-medium">${kb(prototypeTotal)} KB</span>
        </li>
        <li class="flex justify-between">
          <span class="text-[var(--text-secondary)]">${BASELINE.label}</span>
          <span class="text-[var(--text-tertiary)]">${kb(baselineSize)} KB</span>
        </li>
      </ul>
      <p class="text-[10px] text-[var(--text-tertiary)] mt-3 leading-relaxed">
        O ponto não é qual número é menor — é que aqui cada arquivo tem UMA responsabilidade e pode ser aberto,
        entendido e testado sozinho. No glance.js real, mexer em uma aba exige carregar o arquivo inteiro na
        cabeça pra achar onde encaixar um campo novo (foi assim que o editor de organograma foi adicionado).
      </p>
    </${Panel}>
  `;
}
