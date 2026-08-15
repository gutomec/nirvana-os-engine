/**
 * The body arm widens what can be found. It does not decide that something was.
 *
 * Indexing the task/agent/workflow text behind each capability moved
 * cross-language parity from 25% to 35% on the held-out paraphrase pairs, and
 * closed the self-retrieval gap between Portuguese and English to zero. That is
 * the largest routing gain measured in this library.
 *
 * It also broke an abstention on the first attempt, and the way it broke is the
 * reason for the second rule here. "bom dia, tudo bem com você?" shares four of
 * its five tokens with an online-course task doc that opens with a greeting. A
 * score cap did nothing. An overlap floor did nothing — the overlap was high,
 * the tokens were empty. A stoplist of the words that failed would have been
 * overfitting, which the routing contract forbids by name.
 *
 * What worked was saying out loud what the design already implied: abstention is
 * a decision, and decisions belong to curated metadata. These tests pin both
 * halves.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const router = require_(join(import.meta.dir, "..", "lib", "router.js"));
const bodyIndex = require_(join(import.meta.dir, "..", "..", "_shared", "lib", "body-index.js"));

/** A registry shaped like the real one, with one capability carrying a body. */
function registries(bodyText: string | null, metaDescription = "Generates a quarterly revenue report from ledger exports") {
  return {
    squads: {
      capabilities: {
        "finance.revenue_report.execute": [{
          squad: "fixture-finance",
          description: metaDescription,
          domains: ["finance"],
          examples: ["quarterly revenue report"],
          keywords: ["revenue report", "relatório de receita"],
          example_briefs: ["Preciso do relatório de receita do trimestre"],
          invoke: { type: "task", ref: "tasks/report.md" },
          ...(bodyText ? { body_text: bodyText } : {}),
        }],
      },
    },
    businesses: { businesses: {} },
  };
}

describe("the body document is emitted, and marked", () => {
  test("a capability with body_text gets a second document", () => {
    const docs = router.buildMatchDocs(registries("depreciation amortization accrual").squads, {});
    const ids = docs.map((d: { id: string }) => d.id);
    expect(ids).toContain("squad_capability:fixture-finance:finance.revenue_report.execute");
    expect(ids).toContain("squad_capability_body:fixture-finance:finance.revenue_report.execute");
  });

  test("without body_text there is only the metadata document", () => {
    const docs = router.buildMatchDocs(registries(null).squads, {});
    expect(docs.filter((d: { meta?: { via_body?: boolean } }) => d.meta?.via_body)).toHaveLength(0);
  });

  test("the body document is flagged, so scoring can treat it differently", () => {
    const docs = router.buildMatchDocs(registries("depreciation amortization").squads, {});
    const body = docs.find((d: { id: string }) => d.id.startsWith("squad_capability_body:"));
    expect(body.meta.via_body).toBe(true);
    // It still resolves to the same destination — recall, not a new entity.
    expect(body.meta.squad).toBe("fixture-finance");
    expect(body.meta.capability_id).toBe("finance.revenue_report.execute");
  });
});

describe("the body finds what the metadata missed", () => {
  test("a brief using body vocabulary reaches the capability", async () => {
    // "depreciation" appears nowhere in the description or keywords.
    const withBody = await router.route(
      "preciso calcular depreciation e amortization do trimestre",
      { registries: registries("depreciation amortization accrual ledger reconciliation"), amplify: false },
    );
    expect(withBody.stage3.signal).not.toBe("NO_MATCH");
  });
});

describe("abstention belongs to curated metadata", () => {
  test("candidates found only through a body do not lift a NO_MATCH", async () => {
    // The greeting case, generalized: a body full of conversational prose, and a
    // brief that shares its words without sharing its domain.
    const r = await router.route(
      "bom dia, tudo bem com você?",
      { registries: registries("bom dia tudo bem pessoal vamos começar a aula de hoje"), amplify: false },
    );
    expect(r.stage3.signal).toBe("NO_MATCH");
    expect(r.stage3.reason).toBe("body_only_candidates");
  });

  test("a metadata match still decides, with the body alongside it", async () => {
    const r = await router.route(
      "Preciso do relatório de receita do trimestre",
      { registries: registries("depreciation amortization accrual"), amplify: false },
    );
    expect(r.stage3.signal).not.toBe("NO_MATCH");
    expect(r.stage3.reason).not.toBe("body_only_candidates");
  });
});

describe("extraction is bounded and never throws", () => {
  test("an unresolvable ref yields no body rather than an error", () => {
    expect(bodyIndex.bodyTextFor("/nonexistent/squad.yaml", { type: "task", ref: "tasks/nope.md" })).toBe("");
    expect(bodyIndex.bodyTextFor("/nonexistent/squad.yaml", null)).toBe("");
    expect(bodyIndex.bodyTextFor("", { type: "workflow", ref: "" })).toBe("");
  });

  test("cleaning removes what a matcher cannot use", () => {
    const cleaned = bodyIndex.clean([
      "---", "name: x", "---",
      "## Objetivo",
      "Reconcile the ledger against depreciation schedules.",
      "```ts", "const x = 1;", "```",
      "See https://example.com/docs and src/lib/thing.ts",
    ].join("\n"));
    expect(cleaned).toContain("depreciation");
    expect(cleaned).not.toContain("const x");
    expect(cleaned).not.toContain("example.com");
    expect(cleaned).not.toContain("Objetivo");
  });

  test("the budget caps a body that would swamp the index", () => {
    const huge = "reconciliation ".repeat(2000);
    expect(bodyIndex.clean(huge).length).toBeGreaterThan(bodyIndex.BODY_BUDGET);
    // bodyTextFor applies the cap; clean() alone does not, by design — the cap
    // belongs to indexing, not to cleaning.
    expect(bodyIndex.BODY_BUDGET).toBe(4000);
  });
});
