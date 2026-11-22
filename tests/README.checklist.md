# LibrasLive — Checklist de Aceite (executável)

Origem: `LibrasLive Master Spec`, seção "ATUALIZAÇÃO DE ESCOPO — STACK TODA EM RUST"
e seções 6 e 7. Stack: Tauri 2 + Rust (axum/tokio, whisper-rs, rusqlite); avatar
Three.js/R3F dentro do webview. Todos os comandos são executados dentro de
`libraslive/` (raiz do projeto):

```bash
cd /home/samuel/Documentos/Programacao/libras/libraslive
```

Marque `✅` apenas após executar o comando e conferir o resultado. `⚠️` = executa
mas com ressalva documentada; `❌` = bloqueante.

---

## A. Contrato de dados e testes automáticos

- [ ] **A1. Lexicon válido e determinístico**
  ```bash
  node scripts/verify-lexicon.mjs
  ```
  Caminho canônico: `lexicon/libras.json`; fallback transitório enquanto o Trama
  move o JSON: `src/lexicon/libras.json`. Esperado: `SINAIS: N (OK, >= 300)`,
  `ERROS: 0`, `RESULTADO: VÁLIDO`, exit code `0`. Qualquer erro → `❌`.
  Opções: `--lexicon <path>`, `--tokens <path>` e `--json`.

- [ ] **A2. Contrato de dados em JSON (CI/outras ferramentas)**
  ```bash
  node scripts/verify-lexicon.mjs --json | jq -e '.ok == true and .sinais >= 300'
  ```
  Se `jq` não estiver instalado, inspecione os campos `ok` e `sinais` manualmente.

- [ ] **A3. Testes Rust do workspace (substitui o antigo `npm test`)**
  ```bash
  cargo test
  ```
  Esperado: exit code `0` para todos os crates do workspace (`audio`, `stt`,
  `server`, `nlp`, `src-tauri`). Falha de compilação ou teste → `❌`.

- [ ] **A4. Contratos Rust dos quatro módulos do pipeline**
  ```bash
  bash scripts/verify-rust-contracts.sh
  ```
  Roda `cargo test -p libraslive-nlp -p libraslive-server -p libraslive-audio -p libraslive-stt`.
  Esperado: exit code `0` e `RESULTADO: contratos Rust OK`.
  Use `-- --nocapture` para ver logs dos testes.

- [ ] **A5. Conversor texto→gloss testado de verdade**
  ```bash
  cargo test -p libraslive-nlp
  ```
  Conferir que existem testes para SVO, tempo no início, negação/pergunta no fim,
  intensidade, classificadores e datilologia. Todos `ignored`/`skipped` → `⚠️` com
  justificativa; nenhum teste → `❌`.

- [ ] **A6. Contrato 6.1/6.2/6.3 no teste de integração TS**
  ```bash
  npm test -- --run tests/integration/contract.test.ts
  ```
  Esperado: exit code `0`, sem falhas. O teste lê o lexicon pelo mesmo resolvedor
  do item A1 e verifica as fontes do backend em `crates/server/src/*.rs`.

## B. Backend axum (contrato 6.3)

- [ ] **B1. Health check**
  ```bash
  cargo run -p libraslive-server &
  curl -fsS http://127.0.0.1:8000/health
  ```
  Esperado: `{"status":"ok","modelo":...}`.

- [ ] **B2. Lexicon servido pelo backend**
  ```bash
  curl -fsS http://127.0.0.1:8000/lexicon > /tmp/libras-lexicon.json
  node scripts/verify-lexicon.mjs --lexicon /tmp/libras-lexicon.json
  ```
  Esperado: exit code `0`, `>= 300` sinais, mesma validação do item A1.

- [ ] **B3. WebSocket de streaming**
  Confirmar em `crates/server/src/*.rs`: endpoint `ws://127.0.0.1:8000/stream`,
  cliente envia PCM16 mono 16 kHz em chunks de 320 amostras; servidor responde
  JSON com `type` = `partial` | `final` | `gloss` (e `error`), campo `latency_ms`
  presente; mensagem `gloss` contém `GlossResult` completo (tokens, expressao,
  duracao_total_ms, textoOriginal). Os testes de `libraslive-server` devem cobrir
  a serialização desses eventos (item A4).

## C. Overlay e experiência (critérios 7)

- [ ] **C1. `npm run tauri:dev` abre overlay no canto superior direito**
  ```bash
  npm run tauri:dev
  ```
  Conferir na tela: janela Tauri transparente, `alwaysOnTop`, sem borda,
  `skipTaskbar`, posicionada no **superior direito**, sem roubar foco.
  `npm run dev` sobe apenas o Vite; para o overlay usar `npm run tauri:dev`.
  Registrar screenshot.

- [ ] **C2. Controles do avatar**
  Conferir UI de tamanho, opacidade, canto e always-on-top em `src/renderer/ui/Controls.tsx`.

- [ ] **C3. Latência fim a fim < 2 s**
  Tocar vídeo pt-BR no navegador com captura de áudio do sistema ativa; medir entre a
  fala e o avatar sinalizar. Usar as métricas `latency_ms` do WS e o log de render.
  Esperado: `< 2000 ms`. Acima disso → `⚠️` com números medidos.

- [ ] **C4. Funciona offline**
  Após instalar os modelos, desconectar a rede (ou bloquear saída do app no firewall)
  e repetir C1 + C3. Nenhuma chamada de nuvem pode ser necessária.

- [ ] **C5. Modo demo sem backend**
  Com o backend parado, `npm run tauri:dev` deve continuar emitindo glossos de
  exemplo a cada ~2,5 s (`useGlossStream` em modo demo, contrato 6.4).

## D. Builds e distribuição (critérios 7 — Tauri)

- [ ] **D1. Linux (Tauri)**
  ```bash
  npm run tauri build
  ```
  Esperado: `.deb` e/ou `.AppImage` em `src-tauri/target/release/bundle/`.
  Também aceito: `npm run tauri:build` (alias).

- [ ] **D2. Windows 11 (Tauri)**
  ```bash
  npm run tauri build -- --target x86_64-pc-windows-gnu
  ```
  Esperado: instalador `.exe` (MSI/NSIS) em `src-tauri/target/<target>/release/bundle/`.
  Cross-build em Linux via toolchain MinGW: registrar a limitação. O CI com matrix
  Windows (item E5) é a forma preferencial de validar este item.

- [ ] **D3. Android (Tauri mobile)**
  ```bash
  npm run android:build
  ```
  Esperado: APK gerado com permissão `SYSTEM_ALERT_WINDOW` (overlay em foreground
  service). Justificar no README as limitações de captura de áudio do sistema no
  Android.

- [ ] **D4. Qualidade estática Rust**
  ```bash
  npm run lint
  ```
  Equivale a `cargo clippy --workspace --all-targets -- -D warnings`.
  Esperado: exit code `0`.

## E. Documentação e higiene

- [ ] **E1. README com diagrama Mermaid**
  ```bash
  rg -n '```mermaid' README.md
  ```
  Esperado: pelo menos um bloco Mermaid representando o fluxo da seção 3.

- [ ] **E2. README com LIMITAÇÕES** (obrigatório, critério 7)
  ```bash
  rg -n -i 'limita(ç|c)ões|não substitui|intérprete profissional|whisper|lexicon inicial' README.md
  ```
  A seção deve afirmar explicitamente:
  1. lexicon inicial limitado (palavras fora dele são soletradas por datilologia);
  2. qualidade depende do modelo Whisper e do processador/iluminação;
  3. **isto NÃO substitui um intérprete profissional de LIBRAS**.
  Também deve justificar a exceção Three.js/R3F no webview, a escolha Tauri e as
  limitações de captura de áudio no Android.

- [ ] **E3. Sem pseudocódigo / TODO vago / `...` omisso**
  ```bash
  rg -n '(TODO|FIXME|pseudoc[óo]digo|\.\.\.)' \
    --glob '!node_modules/**' --glob '!target/**' --glob '!dist/**' \
    --glob '!*.lock' --glob '!tests/README.checklist.md' .
  ```
  Esperado: nenhum resultado em código-fonte. Ocorrência legítima (ex.: operador
  spread `...args`, reticências em texto de UI) deve ser justificada no relatório.

- [ ] **E4. Estrutura de arquivos canônica (árvore Rust/Tauri) presente**
  ```bash
  for f in Cargo.toml crates/audio/Cargo.toml crates/stt/Cargo.toml \
    crates/server/Cargo.toml crates/nlp/Cargo.toml lexicon/libras.json \
    src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/src/lib.rs \
    src/renderer/App.tsx src/renderer/useGlossStream.ts \
    src/renderer/avatar/Avatar.tsx src/renderer/avatar/AnimationQueue.ts \
    src/renderer/avatar/retarget.ts src/renderer/ui/Controls.tsx \
    tests/integration/contract.test.ts scripts/verify-lexicon.mjs \
    scripts/verify-rust-contracts.sh package.json README.md \
    .github/workflows/ci.yml; do
    test -e "$f" || echo "FALTANDO: $f"
  done
  ```
  Esperado: nenhuma linha `FALTANDO`. Código antigo em `electron/`, `python/`,
  `src/nlp/*.ts`, `src/audio/*.ts`, `src/stt/*.ts` deve ter sido removido ou
  movido para `docs/legado/`.

- [ ] **E5. CI presente com matrix Linux/Windows**
  ```bash
  rg -n 'cargo (test|clippy)|tauri build|matrix|windows' .github/workflows/ci.yml
  ```
  Esperado: `cargo test`, `cargo clippy` e build Tauri no workflow, com matrix
  Linux/Windows.

## F. Regras LIBRAS (seção 4) — verificação no conversor Rust

- [ ] **F1. Ordem tempo/condição → sujeito → objeto → verbo → negação/pergunta**
  Testar com frases como "ontem eu não como maçã?" e inspecionar `tokens`.
- [ ] **F2. Pergunta SIM/NÃO** → `sobrancelha: "erguida"` + `cabeca: "inclinada"`.
- [ ] **F3. Pergunta QU-** ("onde", "quem") → `sobrancelha: "franzida"`.
- [ ] **F4. Negação** → `cabeca: "balancando"` + token do sinal `NAO`.
- [ ] **F5. Intensidade/adjetivo** amplia movimento e expressão (`intensidade` > 0.5).
- [ ] **F6. Classificadores** usam configuração de mão específica (`classificador` não nulo).
- [ ] **F7. Palavra desconhecida → datilologia** (`poseId: "dedo-<letra>"`, `tipo: "dedo"`),
  nunca sinal inventado. Coberto por `cargo test -p libraslive-nlp` (item A5).

---

## Modelo de registro final (preencher na ordem de revisão)

| Item | Status | Evidência (arquivo:linha / comando / valor) |
| --- | --- | --- |
| A1–A6 | ✅/⚠️/❌ | |
| B1–B3 | ✅/⚠️/❌ | |
| C1–C5 | ✅/⚠️/❌ | |
| D1–D4 | ✅/⚠️/❌ | |
| E1–E5 | ✅/⚠️/❌ | |
| F1–F7 | ✅/⚠️/❌ | |
