# chain-atelier — design proposal

**Status:** design · 2026-08-15
**Ask:** a business that can build anything on-chain — banks, marketplaces,
ecommerce, dApps — on Solana, EVM, or a chain named at brief time, usable by a
weak local model with no internet, and aware of the regulation that applies where
the system will run.

---

## 1. The boundary, and what it costs a neighbour

`crypto-foundry` already exists and already declares `smart-contract-set`,
`defi-protocol-spec` and `security-audit-report`. A new business that also claims
those is born stealing, and the routing contract is explicit that taking a query
from a better-grounded neighbour is worse than not being found.

So the boundary has to be drawn, not avoided. It is sayable in one question:

> **Are you launching a token, or building an application?**

| | crypto-foundry | chain-atelier |
|---|---|---|
| unit of work | a project launch | a system that keeps running |
| contracts it writes | token contracts — mint, vesting, staking, distribution | application contracts — escrow, custody, settlement, access control, registry |
| horizon | 90 days to launch | the life of the system |
| artifacts | tokenomics paper, launch package, vesting schedule | system spec, deployed contracts, dApp, indexer, runbook |
| audit it runs | is this token safe to launch | do these invariants hold under adversarial use |

**crypto-foundry gives up nothing it actually does.** Its engineering is token
engineering, and it keeps that. What it should stop claiming is generic
`smart-contract-set` and `security-audit-report` — those descriptions are broader
than its material, which is precisely the shadowing failure measured across this
library today. Narrowing them is part of this proposal, not a side effect of it.

`fintech-forge` is untouched: it builds regulated fintech MVPs off-chain
(KYC/AML, licensing, payment rails, BaaS). When a system is both — a bank whose
ledger is on-chain — `fintech-forge` owns the regulatory perimeter and
`chain-atelier` owns the chain. That is a two-business brief, and the handoff
primitives exist for exactly that.

## 2. What only a business can carry here

Everything in this design that a squad could not do alone, per Business
Protocol §1.4:

- **An architecture decision that binds later phases.** Chain choice, custody
  model and settlement model are decided once and constrain every squad
  downstream. A squad is atomic and stateless; this is persistent state.
- **Security with veto.** BP9 approval chains let the audit stage *block*
  delivery. A squad can report a finding; only a business can refuse to ship.
- **The antagonist.** Above 5 employees the protocol requires one, and here it is
  load-bearing rather than ceremonial: the failure mode of on-chain work is
  confident, well-tested, exploitable code.
- **Memory across projects.** `memory/learned.md` is where a discovered attack
  pattern survives the project that found it.
- **Regulation as persistent institutional knowledge**, not a fact re-derived per
  brief by a model that may be offline and weak.

## 3. business.yaml — the declaration

```yaml
name: chain-atelier
version: 0.1.0
protocol: "1.0"
description: >
  Builds application systems that run on a blockchain and the software around
  them: escrow and marketplace contracts, custody and key policy, on-chain
  ledgers with off-chain reconciliation, token-gated commerce, and the dApp,
  indexer and deployment runbook that make them usable. Takes the chain as an
  input — Solana with Anchor and SPL, EVM with Solidity and the ERC standards,
  or another named at brief time — and produces the same system spec against
  either backend. Every contract ships with executable invariants, a property
  test suite and an adversarial review that can block release.
domains: [crypto, software_engineering, security, backend, frontend, fintech, compliance, infrastructure]
operation_mode: zero_human
authority_level: tier-2
employee_count: 7
runtime_requirements:
  minimum:
    - runtime: claude-code
produces:
  - onchain-system-spec
  - smart-contract-application-set
  - contract-invariant-suite
  - adversarial-review-report
  - custody-key-policy
  - dapp-frontend
  - chain-indexer
  - deployment-runbook
  - jurisdiction-obligation-matrix
keywords:
  - web3, web 3.0, blockchain, on-chain, onchain
  - smart contract, contrato inteligente, contratos inteligentes
  - solana, anchor, spl, program derived address, pda
  - evm, solidity, erc-20, erc-721, erc-1155, foundry, hardhat
  - escrow, custódia, custodia, custody, multisig, mpc
  - marketplace on-chain, marketplace cripto, nft marketplace
  - ecommerce cripto, pagamento em cripto, crypto payments
  - carteira, wallet, assinatura de transação, transaction signing
  - liquidação, liquidacao, settlement, ledger on-chain
  - indexador, indexer, subgraph, rpc, nó, node
  - auditoria de contrato, contract audit, invariante, invariant
  - reentrância, reentrancia, reentrancy, overflow, oracle manipulation
example_briefs:
  - "Quero um marketplace onde o comprador só libera o pagamento quando recebe, e a taxa da plataforma sai automática"
  - "Build a marketplace with escrow where funds release on delivery confirmation and the platform fee is taken on settlement"
  - "Preciso de uma loja que aceite pagamento em cripto e entregue o produto digital na hora"
  - "We need a system of accounts with balances on chain, where every movement reconciles against an off-chain ledger"
  - "Quero tokenizar cotas de um fundo e controlar quem pode transferir para quem"
  - "Same contract set, but deploy it on Solana instead of EVM"
  - "Audit this contract before we put real money in it"
```

**Domain check:** every value is in `CAPABILITY_CATALOG_V1.yaml` v1.1.0. No
`experimental_domains` needed.

**Briefs check:** 7 briefs, EN and PT both present, symptom-phrased, no business
slug inside any of them, conjugated and infinitive forms both covered.

## 4. The org — 7 employees

Seven crosses the antagonist threshold on purpose: the adversary is the point.

| employee | type | role |
|---|---|---|
| `ca-intake` | orchestrator · `is_brief_intake: true` | the only entry. Extracts the three answers that shape everything: which chain, custody by whom, which jurisdiction. Refuses to route until it has them or a stated default. |
| `ca-architect` | functional_specialist | writes the chain-agnostic system spec and its invariants. Owns the decision record. Reports to intake. |
| `ca-solana` | functional_specialist | Anchor, SPL/Token-2022, PDAs, compute budget, account model. |
| `ca-evm` | functional_specialist | Solidity, ERC standards, proxy and upgrade patterns, gas. |
| `ca-adversary` | antagonist_gate · `is_antagonist: true` | tries to break what the other two built. Holds the release veto. |
| `ca-regulatory` | functional_specialist | maps the jurisdiction to obligations and turns them into design constraints before code exists, not after. |
| `ca-integration` | functional_specialist | dApp, wallet flows, indexer, RPC, deployment runbook, observability. |

Org chart: `ca-intake` is the single root; the other six report to it.
`ca-adversary` reports to intake and answers to nobody it reviews — an antagonist
that reports to the person it audits is decoration.

**Approval chain** (BP9), for anything touching value:

```
producer   ca-solana | ca-evm
reviewer   ca-adversary        ← can reject, and rejection stops delivery
approver   ca-architect        ← confirms the invariants still hold
```

## 5. Squads — what exists, what must be built

Nothing in the library builds application-layer on-chain systems. What is
adjacent and reusable:

| exists | used for |
|---|---|
| `crypto-token-forge` | when the system needs a token minted (Solana, SPL/Token-2022) |
| `nirvana-backend` | the off-chain half — API, database, reconciliation |
| `nirvana-security-fullstack`, `security-audit` | conventional application security around the chain |
| `landing-page-nirvana`, `awwwards-singularity-studio` | the marketing surface, when asked |
| `nirvana-compliance-lgpd`, `nirvana-juridico-total` | Brazilian data and legal work |

To create, four squads. Not seven — I proposed seven earlier by symmetry and the
boundary test does not support it. Architecture and regulation decide together
and produce one artifact set, so they are one squad. Frontend, indexer and
deployment are one delivery surface, not three.

| new squad | boundary, in one sentence |
|---|---|
| `onchain-architect` | Turns a system requirement into a chain-agnostic spec with executable invariants, a threat model, and the jurisdiction's obligations already folded in as constraints. |
| `solana-engineering` | Implements an approved spec as Anchor programs with SPL/Token-2022, PDAs and an account model, plus its test suite. |
| `evm-engineering` | Implements an approved spec as Solidity contracts with the right ERC standards and upgrade path, plus its test suite. |
| `onchain-adversary` | Attacks a contract set against its declared invariants and known vulnerability classes, and reports whether it can be released. |

`squads_authorized` stays **empty**, which means every squad is permitted. That
is deliberate: the operational rule is now the top-5 agentic choice recorded in
the audit, and a whitelist would only re-introduce a gate the harness already
enforces better.

## 6. Mind-clones

Sparse and grounded, per the pipeline's own rule — a clone without material is an
invented persona wearing a real name. Candidates worth building only if the
sources sustain five layers:

- a protocol designer, for the economic and mechanism reasoning the templates
  cannot cover
- a smart-contract security researcher, for the adversary's judgement
- an applied cryptographer, for custody and key policy

Anyone whose public material is thin ships as a declared **archetype**, not under
a real name.

## 7. The requirement that shapes everything: weak model, no internet

The protocols already give: BM25 routing with zero LLM, deterministic gates,
deterministic scaffolding by contract, local runtimes via Ollama and llama.cpp.
What they do not give — stated plainly in the protocol audit — is offline
*creation*. Creating this business needs a strong model. **Using** it must not.

So the knowledge cannot live in the model. It lives in the artifacts:

**Templates instead of advice.** Not "the agent knows how to write escrow" — the
squad carries an audited escrow contract, parameterised. A weak model fills
blanks; it does not design.

**Gates instead of review.** `slither` and `mythril` for EVM, `anchor test` and
`cargo-audit` for Solana, property tests over the declared invariants. The judge
is the compiler and the fuzzer, which do not get worse when the model does.

**A local chain instead of the internet.** `anvil` and `solana-test-validator`
run offline; dependencies vendored, toolchains pinned. Nothing says "check the
latest docs".

**Regulation as a table, not as memory.** A weak model does not know MiCA from
BACEN from the SEC. So the matrix is data: jurisdiction → obligation → what it
forces in the design. `ca-regulatory` reads a table.

## 8. What this business must refuse, in writing

The refusal is a feature and belongs in `not_for`, short enough to fire
(≤25 chars each):

```
not_for:
  - novo mecanismo de consenso
  - new consensus mechanism
  - curva de amm inédita
  - novel amm curve
  - criptografia nova
  - novel cryptography
  - lançamento de token        # crypto-foundry
  - token launch               # crypto-foundry
  - tokenomics
  - trading de cripto          # nirvana-crypto-trading
  - crypto trading
```

The honest scope: **excellent at composing known, audited patterns; refuses
novel design.** Escrow, vault, marketplace, registry, access control, vesting,
multisig — patterns that exist, have been audited many times, and fit a template.
A weak model composes those safely because it is not inventing.

Novel economic design, new cryptography, a bespoke consensus — no gate catches a
design error there. A business that accepts those with a weak model produces
unsafe systems that look approved. For the bank in the original ask: a bank
assembled from known patterns, this builds. Deposit tokenisation with bespoke
settlement is novel design and needs people.

## 9. Gates before this counts as created

1. `validate-business.ts` — manifest, org chart, employee frontmatter (`.strict()`), integrity: one root, exactly one `is_brief_intake`, at least one antagonist above 5 employees.
2. `validate-squad.ts` on each of the four new squads.
3. **Self-retrieval** on the business and every capability — each `example_brief` returns its owner at rank 1.
4. **Neighbours intact** — `crypto-foundry`, `fintech-forge`, `crypto-token-forge` and `nirvana-crypto-trading` keep winning their own briefs. This is the gate this design is most likely to fail, and the one worth failing on.
5. `measure-language-parity.ts --safety` — the golden negatives keep abstaining.
6. Isolation test, per BP §9.4.

## 10. Build order

Not four squads at once. `onchain-architect` and `onchain-adversary` first, and
prove them on one real system: a marketplace with escrow, built on Solana and on
EVM from the same spec. If a weak offline model produces both and both pass the
gates, the design holds and the rest is replication. If it does not, we learn it
with two squads instead of four.
