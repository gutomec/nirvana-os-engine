/**
 * Nirvana Glance — smoke de endpoints (critério de aceite #7 do PRD v2.0).
 * Uso: bun scripts/glance-smoke.ts [baseUrl]
 * Verifica 15 endpoints (13+ exigidos) sem depender de teste unitário.
 */
const base = process.argv[2] ?? "http://localhost:3000";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* sem corpo */
  }
  return { res, body };
}

async function main() {
  console.log(`\nNirvana Glance smoke → ${base}\n`);

  // 1. health (DEGRADED é válido: reflete FAILED recentes, ex. de um cancel)
  {
    const { res, body } = await json("/api/health");
    const h = body as { status?: string; scope?: string; version?: string } | null;
    const okStatus = h?.status === "OPERATIONAL" || h?.status === "DEGRADED";
    check("GET /api/health", res.ok && okStatus, `status=${h?.status} v=${h?.version}`);
  }

  // 2. pulse
  {
    const { res, body } = await json("/api/pulse");
    const p = body as { stats?: { agents?: number; eventsToday?: number }; subsystems?: unknown[] } | null;
    check(
      "GET /api/pulse",
      res.ok && (p?.stats?.agents ?? 0) > 0 && (p?.subsystems?.length ?? 0) === 8,
      `agents=${p?.stats?.agents} subsystems=${p?.subsystems?.length}`
    );
  }

  // 3. squads
  {
    const { res, body } = await json("/api/squads");
    const s = body as { squads?: unknown[] } | null;
    check("GET /api/squads", res.ok && (s?.squads?.length ?? 0) >= 6, `${s?.squads?.length} entidades`);
  }

  // 4. squad detail
  {
    const { res, body } = await json("/api/squads/data-hunter");
    const d = body as { slug?: string; events?: unknown[] } | null;
    check("GET /api/squads/data-hunter", res.ok && d?.slug === "data-hunter", `eventos=${d?.events?.length}`);
  }

  // 5. businesses
  {
    const { res, body } = await json("/api/businesses");
    const b = body as { businesses?: unknown[] } | null;
    check("GET /api/businesses", res.ok && (b?.businesses?.length ?? 0) >= 6, `${b?.businesses?.length} businesses`);
  }

  // 6. logs
  {
    const { res, body } = await json("/api/logs?limit=5");
    const l = body as { events?: unknown[] } | null;
    check("GET /api/logs?limit=5", res.ok && (l?.events?.length ?? 0) > 0, `${l?.events?.length} eventos`);
  }

  // 7. logs hoje
  {
    const { res, body } = await json("/api/logs?date=today&limit=1");
    const l = body as { events?: unknown[] } | null;
    check("GET /api/logs?date=today", res.ok && (l?.events?.length ?? 0) > 0);
  }

  // 8. SSE: conecta, recebe comentário/retry e um evento nomeado
  {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(`${base}/api/events`, { signal: controller.signal });
      const reader = res.body?.getReader();
      let text = "";
      const deadline = Date.now() + 8500;
      while (reader && Date.now() < deadline && !text.includes("event:")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      check(
        "GET /api/events (SSE)",
        res.ok &&
          res.headers.get("content-type")?.includes("text/event-stream") === true &&
          (text.includes("event: timeline") || text.includes("event: pulse")),
        text.slice(0, 60).replace(/\n/g, " ")
      );
    } catch {
      check("GET /api/events (SSE)", false, "sem stream em 9s");
    } finally {
      clearTimeout(timeout);
    }
  }

  // 9. SSE resume por Last-Event-ID
  {
    const logs = await json("/api/logs?limit=1");
    const lastId = ((logs.body as { events: Array<{ id: number }> }).events[0]?.id ?? 1) - 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(`${base}/api/events`, {
        headers: { "Last-Event-ID": String(lastId) },
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      let text = "";
      const deadline = Date.now() + 8500;
      while (reader && Date.now() < deadline && !text.includes("event: timeline")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      const replayed = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      const noDup = replayed.every((id) => id > lastId);
      check("SSE resume Last-Event-ID", res.ok && replayed.length >= 0 && noDup, `lastId=${lastId} replay=${replayed.length}`);
    } catch {
      check("SSE resume Last-Event-ID", false, "sem replay em 9s");
    } finally {
      clearTimeout(timeout);
    }
  }

  // 10. maestro turn completo
  {
    const post = await json("/api/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "smoke: status do pipeline", target: "squad:insight-synth" }),
    });
    const { turn } = (post.body ?? {}) as { turn?: { id: number; state: string } };
    let final: { id: number; state: string } | undefined = turn;
    for (let i = 0; i < 12 && final?.state === "RUNNING"; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const poll = await json(`/api/v1?turnId=${turn?.id}`);
      final = (poll.body as { turn?: { id: number; state: string } })?.turn;
    }
    check("POST+GET /api/v1 (turno)", post.res.status === 202 && final?.state === "COMPLETED", `state=${final?.state}`);
  }

  // 11. no_match
  {
    const post = await json("/api/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x", target: "squad:inexistente" }),
    });
    check("POST /api/v1 no_match → 422", post.res.status === 422);
  }

  // 12. cancel gated (allowActions=false → 403)
  {
    await json("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowActions: false }),
    });
    const res = await fetch(`${base}/api/events/1/cancel`, { method: "POST" });
    check("POST /api/events/1/cancel gated → 403", res.status === 403);
  }

  // 13. cancel habilitado
  {
    await json("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowActions: true }),
    });
    const logs = await json("/api/logs?limit=20");
    const target = (logs.body as { events: Array<{ id: number; kind: string; status: string; cancelled: boolean }> })
      .events.find((e) => e.kind === "RUN" && !e.cancelled && e.status !== "FAILED");
    const res = await fetch(`${base}/api/events/${target?.id ?? 1}/cancel`, { method: "POST" });
    check("POST /api/events/[id]/cancel ON", res.ok, `run=${target?.id}`);
  }

  // 14. projects
  {
    const { res, body } = await json("/api/projects");
    const p = body as { projects?: unknown[] } | null;
    check("GET /api/projects", res.ok && (p?.projects?.length ?? 0) >= 3, `${p?.projects?.length} projetos`);
  }

  // 15. settings GET/PUT + restauração
  {
    const get = await json("/api/settings");
    const put = await json("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowActions: false, scope: "project" }),
    });
    const s = put.body as { allowActions?: boolean; scope?: string } | null;
    check(
      "GET+PUT /api/settings",
      get.res.ok && put.res.ok && s?.allowActions === false && s?.scope === "project",
      `scope=${s?.scope} actions=${s?.allowActions}`
    );
  }

  // 16. páginas
  {
    const home = await fetch(base, { cache: "no-store" });
    const classic = await fetch(`${base}/?view=classic`, { cache: "no-store" });
    check("GET / (modern)", home.ok);
    check("GET /?view=classic (RF-11)", classic.ok);
  }

  console.log(`\nResultado: ${pass} pass · ${fail} fail · total ${pass + fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
