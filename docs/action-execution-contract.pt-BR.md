# Contrato de execução por ação

O contrato permite escolher, de forma explícita e auditável, entre uma ação estável de um squad e o workflow tradicional. O engine é dono da fronteira, resolução, validação e auditoria; a lógica de negócio continua no squad. Uma ação tem `id`, `version`, validação de entrada e saída e uma função de execução.

Esta mudança adiciona a fundação do contrato ao engine. Ela não migra squads, não altera manifests existentes automaticamente e não move implementações para o engine.

## Resolução da política

O modo pode ser `action`, `workflow` ou `auto`. A precedência é determinística:

1. escolha explícita da invocação;
2. configuração do projeto;
3. configuração do squad;
4. padrão do engine, que é `workflow`.

`action` exige uma ação disponível e falha explicitamente se ela não existir ou se a entrada ou saída for inválida. `workflow` executa o fluxo tradicional e é o padrão. `auto` usa a ação quando disponível e recorre ao workflow quando ela não está disponível. Assim, um squad sem mapeamento continua compatível.

## Exemplo: fechamento contábil mensal

Imagine um squad de negócios responsável pelo fechamento mensal, com coleta de extratos, conciliação, saldos e relatório. Uma ação pode encapsular o fechamento validado de um período.

Configuração do projeto:

```yaml
execution:
  mode: auto
  actionId: accounting.close-month
```

Declaração proposta para um squad piloto, não uma migração feita por esta mudança:

```yaml
actions:
  - id: accounting.close-month
    version: 1.0.0
    input: accounting-close-month.v1
    output: accounting-close-result.v1
```

Invocação com fallback:

```ts
await invokeAction({
  mode: "auto",
  actionId: "accounting.close-month",
  action: closeMonthAction,
  input: { period: "2026-07", ledger: "br-gaap" },
  workflow: runMonthlyClosingWorkflow,
  audit: emit,
});
```

Se a ação não estiver disponível, `auto` usa o workflow. Se o caller escolher `action`, não há conversão silenciosa: a indisponibilidade é erro explícito.

Se o projeto optar por preservar o fluxo existente:

```yaml
execution:
  mode: workflow
```

O workflow de fechamento continua sendo executado. Com `mode: workflow`, ele permanece escolhido mesmo que exista uma ação. Sem política informada, `invokeAction` também escolhe `workflow`.

## Ações específicas e operação automatizada

É possível invocar uma operação específica como `accounting.reconcile-bank-statement` por identificador estável. A versão permite evoluir o contrato sem mudar o significado de execuções anteriores. Em `action`, entradas, saídas ou IDs incompatíveis interrompem a chamada com erro verificável. Em `auto`, um ID incompatível torna a ação solicitada indisponível e aciona o fallback para workflow.

Ao selecionar uma ação, a auditoria registra `execution_selected` com modo, `action_id` e `action_version`. Uma seleção direta de workflow registra `execution_selected` com `mode: workflow`. Quando `auto` precisa recorrer ao workflow, registra `execution_fallback` com `mode: auto`, `fallback: workflow` e `reason: action_unavailable`. Nenhum desses eventos inclui entrada, saída ou segredos.

Uma CLI humana pode oferecer prompt interativo. Execuções automatizadas não devem bloquear esperando resposta: precisam receber política na invocação ou configuração. Sem política, o padrão é `workflow`.

## Migração

Comece por uma operação pequena, declare ID, versão e contratos, implemente no próprio squad, mantenha o workflow como fallback e observe a auditoria. Só depois altere a política para `action`. Outros squads podem permanecer em workflows. Esta mudança não altera manifests nem migra squads automaticamente.
