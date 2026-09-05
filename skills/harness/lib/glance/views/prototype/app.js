// app.js — bootstrap only. Every real piece of UI is its own file
// (panel.js, businesses-panel.js, agents-panel.js, debug-hud.js); this file
// just composes them. That split IS the thing being tested: can a
// contributor open one small file for one feature, instead of one shared
// multi-thousand-line glance.js for all of them.
import { render } from "preact";
import { html } from "htm/preact";
import { BusinessesPanel } from "./businesses-panel.js";
import { AgentsPanel } from "./agents-panel.js";
import { DebugHud } from "./debug-hud.js";

function App() {
  return html`
    <div class="flex flex-col gap-4">
      <header class="flex items-baseline justify-between">
        <h1 class="text-lg font-semibold">Glance — prototype</h1>
        <span class="text-[10px] text-[var(--text-tertiary)]">
          Preact + Signals + htm, via import map · Tailwind (browser CDN) lendo tokens.css · zero build ·
          servido pelo mesmo Bun em /prototype · não faz parte de nenhuma release
        </span>
      </header>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <${BusinessesPanel} />
        <${AgentsPanel} />
      </div>
      <${DebugHud} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
