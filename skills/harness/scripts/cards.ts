#!/usr/bin/env bun
// cards.ts — `nrv cards squad <slug>`: the work card of an installed squad
// (_shared/lib/work-cards.ts). A solo worker that needs a squad the run did not
// pick reads its card here and works as its agents; it never dispatches it.

import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { squadWorkCard } from "../../_shared/lib/work-cards.ts";

const EXIT_USAGE = 64;
const [kind, slug] = process.argv.slice(2);

if (kind !== "squad" || !slug) {
  console.error("usage: nrv cards squad <slug>");
  process.exit(EXIT_USAGE);
}

const dir = resolveEntityDir("squads", slug, process.cwd());
const card = squadWorkCard(slug, dir);
if (!card) {
  console.error(`no squad.yaml in ${dir}; \`nrv list-squads\` lists the installed squads`);
  process.exit(1);
}
process.stdout.write(card);
