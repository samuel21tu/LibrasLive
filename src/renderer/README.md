# Renderer LibrasLive

Documentação do módulo de avatar/overlay. O README raiz é mantido pelo orquestrador;
o trecho abaixo deve ser incorporado à seção **Avatar** do README principal.

## Como integrar

```tsx
import { App } from "./renderer/App";

createRoot(document.getElementById("root")!).render(<App />);
```

O renderer consome **apenas** `useGlossStream()`; não importa módulos do backend
(axum/Rust). O fluxo é:

```
useGlossStream → GlossResult → AnimationQueue.enqueue → Avatar (useFrame) → pose aplicada aos ossos
```

`AnimationQueue` é um objeto mutável compartilhado por referência. O `FrameDriver`
dentro do `<Canvas>` chama `queue.advance(deltaMs)` uma vez por frame; os avatares
apenas leem o frame. Assim não há `setState` por frame e a animação não sofre
re-renders do React.

## Ponte com o shell (`window.librasHost`)

`src/renderer/host.ts` expõe `window.librasHost` e substitui o antigo
`window.electronAPI`. As chamadas usam `invoke()` do `@tauri-apps/api/core`
para os comandos de `src-tauri/src/lib.rs`:

| Método do host | Comando Tauri |
| --- | --- |
| `getConfig()` / `setConfig()` | `get_config` / `set_config` |
| `setAlwaysOnTop(v)` | `set_always_on_top` |
| `setOpacity(v)` / `resize(w,h)` | `set_opacity` / `resize_window` |
| `moveCorner(c)` / `cycleCorner()` | `move_corner` / `cycle_corner` |
| `setIgnoreMouse(v)` | `set_ignore_mouse` |
| `minimize()` / `close()` | `minimize` / `close_window` |
| `drag(dx,dy)` | `drag_window` |
| `startBackend()` | `start_backend` |

Se não estiver no Tauri, a ponte usa a bridge legada do `index.html` quando
presente; se não houver nenhuma das duas, todos os métodos viram no-op
seguro — a demo roda normalmente no navegador. Nenhuma chamada lança exceção
para o React.

## Contratos consumidos

- `SignPose` — seção 6.1 (`src/renderer/types.ts`)
- `GlossToken` / `GlossResult` — seção 6.2 (`src/renderer/types.ts`)
- `ws://127.0.0.1:8000/stream` + `GET /lexicon` — seção 6.3 (servidor axum em Rust)

`sendAudio(chunk)` exposto pelo hook envia PCM16 mono 16 kHz ao backend quando
a conexão está aberta. É uma **fonte opcional**: com a captura iniciada no
lado Rust, o axum empurra `partial`/`final`/`gloss` para o WebSocket mesmo sem
nenhum chunk vindo do renderer. O hook apenas escuta mensagens de texto
JSON — não depende de ter enviado áudio para receber os eventos.

## Modo demo

Sem backend, `useGlossStream` entra em `status: "demo"`: emite um `GlossResult`
a cada ~2,5 s a partir de `avatar/fixtures.ts` e tenta reconectar com backoff
exponencial (1 s → 30 s). A UI mostra o indicador âmbar "Demo".

**Os fixtures são apenas para a demo visual.** O lexicon canônico
(`lexicon/libras.json`, na raiz do projeto) substitui o mapa assim que
`GET /lexicon` responde. Em dev, o renderer também tenta
`/lexicon/libras.json` (mesmo arquivo, servido estaticamente pelo Vite).
Se nenhuma fonte responder, o fixture embutido permanece como fallback.

## Trocando o procedural por um GLB (evolução)

```tsx
<Avatar queue={queue} modelUrl="/models/avatar.glb" />
```

- Use um humanoide com rig **mixamo-compatible**. O loader procura ossos por
  nome exato e por sufixo (accept `mixamorigHips`, `mixamorigLeftHand`, etc.).
- Morph targets ARKit são aplicados por `morphTargetInfluences` usando as chaves
  do contrato 6.1 (`browInnerUp`, `jawOpen`, `mouthSmile_L`, …).
- Se o GLB falhar ao carregar, o componente volta automaticamente ao humanoide
  procedural — a demo nunca fica em branco.
- O modelo procedural não possui morph targets; as expressões são simuladas
  com posição/rotação/escala de sobrancelhas, olhos, boca e bochechas.

Para adicionar um GLB real: coloque o arquivo em `public/models/` e passe a
URL. Nenhuma outra mudança é necessária — os nomes de ossos e blendshapes já
seguem o contrato.

## Regras de LIBRAS aplicadas no retarget (`avatar/retarget.ts`)

- Pergunta SIM/NÃO: sobrancelha erguida + cabeça inclinada.
- Pergunta QU ("onde", "quem", "quando", "como", "por que"): sobrancelha franzida.
- Negação: cabeça balançando + boca franzida.
- Intensidade do `GlossToken` escala a amplitude das rotações (slerp com fator)
  e o valor dos blendshapes.
- `duracao_ms` de cada sinal controla o tempo do clipe; easing `easeInOutCubic`.
- Palavra sem sinal no lexicon → **datilologia**, nunca sinal inventado.

## `prefers-reduced-motion`

O `App` detecta a preferência do SO e desliga: balanço idle, oscilação da
cabeça em negação, pulso do indicador e transições CSS. A suavização de
quaternions é acelerada para aproximar o movimento de um corte seco.
