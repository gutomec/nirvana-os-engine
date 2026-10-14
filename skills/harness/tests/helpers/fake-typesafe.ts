// fake-typesafe.ts — a local stand-in for TypeSafe's System One endpoint.
// Tests point TYPESAFE_ENDPOINT (or the env they pass) at `url`; nothing leaves
// the machine and no key is real. Each request body and Authorization header is
// recorded, and `reply` decides the answer per request.

export interface FakeReply { status?: number; json?: unknown; text?: string; delayMs?: number }
export interface FakeRequest { body: any; authorization: string | null }

export interface FakeTypesafe {
  url: string;
  requests: FakeRequest[];
  stop: () => void;
}

/** A Choice answer the way the API shapes it. */
export const choice = (c: string, confidence: number, others: Record<string, number> = {}) =>
  ({ choice: c, confidence, probabilities: { [c]: confidence, ...others } });

export function startFakeTypesafe(reply: (body: any, n: number) => FakeReply): FakeTypesafe {
  const requests: FakeRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      let body: any = null;
      try { body = await req.json(); } catch { body = null; }
      requests.push({ body, authorization: req.headers.get("authorization") });
      const r = reply(body, requests.length);
      if (r.delayMs) await Bun.sleep(r.delayMs);
      if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200 });
      return Response.json(r.json ?? {}, { status: r.status ?? 200 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1/systemone`, requests, stop: () => server.stop(true) };
}

/** Answers every question of a request from a table; a question it does not know gets `none`. */
export function answering(table: Record<string, unknown>, usage = 1000): (body: any) => FakeReply {
  return (body) => {
    const answers: Record<string, unknown> = {};
    for (const k of Object.keys(body?.questions ?? {})) answers[k] = table[k] ?? choice("none", 0.9);
    return { json: { model: "jev-1.13.0", answers, usage: { input_tokens: usage } } };
  };
}
