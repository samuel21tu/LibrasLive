# LibrasLive — backend Python (Áudio/STT)

Dono: agente de Áudio/STT. Este README cobre instalação **offline-first**, modelos e contratos.

## Subir

```bash
cd libraslive/python
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py                     # http://127.0.0.1:8000
```

Variáveis úteis (todas opcionais):

| Variável | Padrão | Uso |
|---|---|---|
| `LIBRASLIVE_WHISPER_MODEL` | `small` | nome/pasta do modelo faster-whisper |
| `LIBRASLIVE_WHISPER_DEVICE` | `cpu` | `cpu` / `cuda` |
| `LIBRASLIVE_WHISPER_COMPUTE` | `int8` | `int8`, `int8_float32`, `float16` |
| `LIBRASLIVE_LANGUAGE` | `pt` | idioma do Whisper |
| `LIBRASLIVE_VAD` | `silero` | `energy` força o VAD sem modelo |
| `LIBRASLIVE_PARTIAL_INTERVAL_MS` | `700` | periodicidade de transcrições parciais |
| `LIBRASLIVE_GLOSS_MODULE` | — | módulo Python do conversor de NLP |
| `LIBRASLIVE_DEMO_STT=1` | off | texto fixo para testar o pipeline sem modelos |

## Modelos — baixar UMA vez (com internet), depois funciona offline

### faster-whisper (small, pt-BR)
```bash
pip install huggingface_hub
huggingface-cli download Systran/faster-whisper-small \
  --local-dir ./models/faster-whisper-small
export LIBRASLIVE_WHISPER_MODEL=./models/faster-whisper-small
```
Alternativamente, deixe o `WhisperModel("small")` baixar no primeiro start para
`~/.cache/huggingface/hub`. Depois disso, rode sem rede.

### Silero-VAD
O pacote `silero-vad` baixa o ONNX no primeiro uso para `~/.cache/torch/hub` (ou
cache do pacote). Para pré-baixar:
```bash
python -c "from silero_vad import load_silero_vad; load_silero_vad()"
```
Se não houver modelo, o server usa VAD por energia automaticamente (campo `vad`
em `/health`). Para forçar: `LIBRASLIVE_VAD=energy`.

### Cliente TS (onnxruntime-node)
Se quiser VAD Silero também no cliente, coloque `silero_vad.onnx` em
`<cwd>/models/silero_vad.onnx`. Sem ele, `src/audio/vad.ts` cai para energia.

## Contratos expostos

- `WS /stream` — binário PCM16 mono 16 kHz, 320 amostras/frame; JSON de saída
  `partial` / `final` / `gloss` / `error`, todos com `latency_ms`.
- `GET /health` → `{"status","modelo","vad","gloss","lexicon","historico"}`
- `GET /lexicon` → `{"versao","sinais": SignPose[]}` (lê `src/lexicon/libras.json`)
- `GET /metrics` → estatísticas de latência (avg/p50/p95/max)
- `GET /history?limit=50` → últimas transcrições

O renderer consome o evento `gloss` via `useGlossStream.ts`; o backend não
conversa diretamente com a janela Electron.

## Integração com o módulo de NLP (pendente)

O backend espera `python/nlp/gloss.py` (ou `LIBRASLIVE_GLOSS_MODULE`) com:

```python
def text_to_gloss(texto: str, sinais: list[dict] | None = None) -> dict:  # GlossResult 6.2
    ...
```

Enquanto o arquivo não existe, `nlp/fallback_gloss.py` aplica as regras da spec
(tempo primeiro, negação no fim, expressões e datilologia) e avisa no log.
Assim que `src/lexicon/libras.json` existir, ele é carregado automaticamente.
