# Code amplification questions

## objective
Qual o comportamento desejado (input → output) e que erros precisam ser tratados?
_Example:_ Endpoint POST /users cria user; valida email único; 400 em duplicata.

## audience
Que consumirá este código (interno, lib pública, microserviço, frontend)?
_Example:_ Frontend Next.js + 1 outro microserviço Go.

## constraints
Stack, deps proibidas, performance, deadline, restrições legais (LGPD)?
_Example:_ TypeScript + Bun. Sem Express. P95 < 100ms. LGPD obrigatório.

## examples
Tem padrão da casa (linter config, módulo similar já existente)?
_Example:_ Mesma forma de /api/v1/sessions já no repo.

## scope
Inclui testes, docs, migration, ou só o código de produção?
_Example:_ Código + unit tests. Migration e doc ficam pra outra issue.

## success_criteria
Como vai validar (testes passam, smoke local, performance test)?
_Example:_ Vitest suite + curl manual + p95 < 100ms num bench de 1k req.
