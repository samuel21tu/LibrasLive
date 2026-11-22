# Modelos locais

Dois arquivos deixam o LibrasLive totalmente offline. Baixe uma vez; depois disso
desligue a internet. Nenhum deles é enviado para a nuvem.

| Arquivo | Para que serve | Variável |
| --- | --- | --- |
| `ggml-small.bin` | Whisper.cpp via `whisper-rs` — transcrição pt-BR (`language = "pt"`) | `LIBRASLIVE_WHISPER_MODEL` |
| `silero_vad.onnx` | VAD Silero via `ort` (onnxruntime) — detecta fala antes do STT | `LIBRASLIVE_SILERO_MODEL` |

## Download

```bash
cd libraslive
mkdir -p models

wget -O models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

wget -O models/silero_vad.onnx \
  https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx
```

`ggml-small.bin` é multilingual e tem ~500 MB. Versões quantizadas como
`ggml-small-q8_0.bin` reduzem CPU e latência em troca de um pouco de precisão —
basta apontar `LIBRASLIVE_WHISPER_MODEL` para o arquivo escolhido.

## Uso

```bash
export LIBRASLIVE_WHISPER_MODEL="$PWD/models/ggml-small.bin"
export LIBRASLIVE_SILERO_MODEL="$PWD/models/silero_vad.onnx"
npm run tauri dev
```

Os caminhos acima são os padrões do código: se as variáveis não forem definidas,
o STT procura `models/ggml-small.bin` e o VAD procura `models/silero_vad.onnx`.

## Sem modelos (demo)

```bash
export LIBRASLIVE_DEMO_STT=1
npm run tauri dev
```

O STT devolve um texto fixo sem carregar o Whisper; use `LIBRASLIVE_DEMO_TEXT`
para trocar esse texto. Se `silero_vad.onnx` não existir, o VAD cai para
**detecção por energia** (RMS em dBFS, limite padrão −40 dB) e avisa no log.
O pipeline continua funcional, mas a segmentação de fala é menos precisa que o Silero.
