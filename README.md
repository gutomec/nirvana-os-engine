# Esta branch não serve mais o site

O GitHub Pages deste repositório passou a ser servido de **`main`, pasta `/docs`**
em 2026-07-31. Editar arquivos aqui **não muda nada** no ar.

A fonte do site é:

- `docs/index.html`   → https://gutomec.github.io/nirvana-os-engine/
- `docs/install.html` → https://gutomec.github.io/nirvana-os-engine/install.html

que chegam ao repositório público pelo `scripts/publish-engine.ts`, a partir de
`~/nirvana-os`.

## Por que mudou

O site vivia aqui como cópia manual de `docs/*.html`. As duas cópias divergiram: a
página publicada passou dias mandando rodar um comando de instalação que falha,
enquanto a fonte já estava corrigida. Apontar o Pages para `main/docs` elimina a
cópia em vez de exigir que alguém lembre de sincronizá-la.

A branch fica como caminho de rollback. Se voltar a servir daqui, sincronize
`docs/*.html` antes.
