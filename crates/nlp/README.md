# LibrasLive NLP/Lexicon (Rust)

Dono: Trama. Contratos da Master Spec §6 (serde) e regras da §4.

## Arquivos

- `src/contracts.rs` — `SignPose`, `GlossToken`, `GlossResult`, `Expressao`, `LexiconResponse` etc.
- `src/normalize.rs` — minúsculas, remoção de pontuação, abreviações, números por extenso, lematização determinística, detecção de pergunta/negação/intensidade.
- `src/gloss.rs` — conversor texto → gloss e léxico embutido em compile time.
- `tests/gloss.rs`, `tests/normalize.rs` — `cargo test -p libraslive-nlp`.
- `../../../lexicon/libras.json` — 535 sinais canônicos (movido de `src/lexicon/`).

## API pública

```rust
use libraslive_nlp::{text_to_gloss, LexiconConverter, carregar_lexicon};

let gloss = text_to_gloss(&texto, &state.lexicon.sinais);      // integração com o backend
let gloss = LexiconConverter.to_gloss(&texto, &state.lexicon.sinais); // mesma assinatura do trait do servidor
let gloss = libraslive_nlp::texto_para_gloss(&texto);          // usa o lexicon embutido (535 sinais)
```

`texto_para_gloss_com_entrada(texto, &normalizado, sinais)` permite reutilizar a normalização.

## Integração (concluída)

1. **Andaime**: `"crates/nlp"` está em `workspace.members` no `Cargo.toml` raiz.
2. **Eco**: `crates/server/Cargo.toml` declara `libraslive-nlp = { path = "../nlp" }`
   e `crates/server/src/contract.rs` reexporta os tipos deste crate — um único
   contrato serde compartilhado, sem conversão nominal.
3. **Datilologia**: o conversor gera sempre `poseId = "dedo-<letra>"` minúsculo,
   id existente no léxico. Nenhum `poseId` inventado.

Validação: `cargo test -p libraslive-nlp` → 30 aprovados, 1 ignorado.

## Legado

Os antigos `src/nlp/*.ts` e testes Vitest foram movidos para `docs/legado/src/nlp/` e
`docs/legado/tests/`. `vitest.config.ts` foi mantido (é do Andaime).
