# Code amplification questions

## objective
What is the desired behavior (input → output) and which errors need to be handled?
_Example:_ POST /users endpoint creates a user; validates unique email; 400 on duplicate.

## audience
Who will consume this code (internal, public library, microservice, frontend)?
_Example:_ A Next.js frontend and one Go microservice.

## constraints
Stack, forbidden dependencies, performance, deadline, legal constraints (GDPR)?
_Example:_ TypeScript + Bun. No Express. P95 < 100ms. GDPR compliance required.

## success_criteria
How will you validate it (tests pass, local smoke test, performance test)?
_Example:_ Vitest suite + manual curl + p95 < 100ms on a 1k-request benchmark.
