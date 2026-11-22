"""LibrasLive — backend FastAPI (dono: agente de Áudio/STT "Eco").

============================ CONTRATO 3 — WEBSOCKET (spec 6.3) ============================
Endpoint: ws://127.0.0.1:8000/stream
Cliente -> servidor:
  - BINÁRIO: PCM16 LE mono 16 kHz, 320 amostras (640 bytes) por frame (20 ms).
  - TEXTO JSON (opcional): {"type":"reset"} reinicia o VAD da sessão.
Servidor -> cliente (JSON texto):
  {"type":"partial","text":"...","latency_ms":n}
  {"type":"final","text":"...","latency_ms":n}
  {"type":"gloss","gloss": GlossResult (spec 6.2), "latency_ms":n}
  {"type":"error","message":"...","latency_ms":n}  (extensão documentada)

============================ CONTRATO 4 — ENTREGA DO GLOSS AO RENDERER =====================
O servidor NÃO conversa com o renderer diretamente: ele publica o GlossResult no
evento `gloss` do WebSocket (acima). `src/renderer/useGlossStream.ts` (agente do
avatar) consome esse evento e entrega o objeto a `App.tsx` — ver spec 6.4.
O conversor é o módulo externo `nlp.gloss:text_to_gloss(texto, sinais)` (contrato
6.2, definido em `nlp/gloss_contract.py`); se ausente, usa `nlp/fallback_gloss.py`.

GET /lexicon -> {"versao": string, "sinais": SignPose[]}   (spec 6.1)
GET /health  -> {"status": "ok"|"degraded", "modelo": string, ...campos extra}

Offline por padrão. Inicie com:  python server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional, Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import settings  # noqa: E402
from db import HistoryStore  # noqa: E402
from logging_utils import LatencyStats, setup_logging  # noqa: E402
from nlp import build_gloss_converter  # noqa: E402
from nlp.lexicon import load_lexicon  # noqa: E402
from stt import WhisperEngine  # noqa: E402
from vad import StreamingVAD, load_vad  # noqa: E402

SAMPLE_RATE = 16_000
MIN_SEGMENT_SAMPLES = int(0.12 * SAMPLE_RATE)
MIN_PARTIAL_SAMPLES = int(0.20 * SAMPLE_RATE)


class StreamSession:
    """Uma conexão WebSocket = uma sessão de VAD + STT independente."""

    def __init__(self, websocket: WebSocket, ctx: Any) -> None:
        self.websocket = websocket
        self.ctx = ctx
        self.vad = StreamingVAD(
            detector=ctx.vad_detector,
            start_threshold=ctx.settings.vad_start,
            end_threshold=ctx.settings.vad_end,
            silence_windows=ctx.settings.vad_silence_windows,
            min_speech_windows=ctx.settings.vad_min_speech_windows,
            max_segment_samples=int(ctx.settings.max_segment_ms / 1000 * SAMPLE_RATE),
        )
        self.send_lock = asyncio.Lock()
        self.transcribe_lock = asyncio.Lock()
        self.tasks: Set[asyncio.Task[None]] = set()
        self.segment_t0: Optional[float] = None
        self.last_partial = 0.0
        self.sequence = 0
        self.session_id = id(self)

    async def emit(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(payload, ensure_ascii=False))

    async def on_audio(self, data: bytes) -> None:
        if len(data) % 2 != 0:
            data = data[:-1]
        if not data:
            return
        samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
        events = self.vad.process(samples)

        for event in events:
            if event.type == "start":
                self.segment_t0 = time.perf_counter()
                self.last_partial = self.segment_t0
                self.ctx.logger.info("speech_start", extra={"session": self.session_id})
            elif event.type == "end" and event.pcm is not None:
                self.schedule(event.pcm, is_final=True, started_at=self.segment_t0 or time.perf_counter())
                self.segment_t0 = None
                self.last_partial = 0.0

        now = time.perf_counter()
        interval_s = self.ctx.settings.partial_interval_ms / 1000.0
        if self.vad.is_active and self.segment_t0 is not None and (now - self.last_partial) >= interval_s:
            audio = self.vad.current_segment_audio()
            if audio is not None and audio.size >= MIN_PARTIAL_SAMPLES:
                self.last_partial = now
                self.schedule(audio, is_final=False, started_at=self.segment_t0)

    async def on_text(self, text: str) -> None:
        try:
            message = json.loads(text)
        except ValueError:
            return
        if isinstance(message, dict) and message.get("type") == "reset":
            self.vad.reset()
            self.segment_t0 = None
            self.last_partial = 0.0
            await self.emit({"type": "reset", "ok": True, "latency_ms": 0})

    def schedule(self, audio: np.ndarray, is_final: bool, started_at: float) -> None:
        self.sequence += 1
        task = asyncio.create_task(self.transcribe(audio, is_final, started_at, self.sequence))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def transcribe(self, audio: np.ndarray, is_final: bool, started_at: float, sequence: int) -> None:
        try:
            async with self.transcribe_lock:
                beam = 5 if is_final else 1
                text = await asyncio.to_thread(self.ctx.engine.transcribe, audio, beam)
            text = (text or "").strip()
            latency_ms = int((time.perf_counter() - started_at) * 1000)
            self.ctx.stats.record(latency_ms)

            if not is_final:
                if text:
                    await self.emit({"type": "partial", "text": text, "latency_ms": latency_ms})
                return

            await self.emit({"type": "final", "text": text, "latency_ms": latency_ms})
            if not text:
                return

            gloss = await asyncio.to_thread(self.ctx.gloss_fn, text, self.ctx.lexicon_signs)
            gloss_latency_ms = int((time.perf_counter() - started_at) * 1000)
            self.ctx.stats.record(gloss_latency_ms)
            await self.emit({"type": "gloss", "gloss": gloss, "latency_ms": gloss_latency_ms})
            await asyncio.to_thread(self.ctx.history.add_transcript, text, gloss, gloss_latency_ms, "ws")
            self.ctx.logger.info(
                "transcription_final",
                extra={
                    "session": self.session_id,
                    "seq": sequence,
                    "latency_ms": latency_ms,
                    "gloss_latency_ms": gloss_latency_ms,
                    "text": text,
                },
            )
        except Exception as exc:
            self.ctx.logger.error(
                "transcribe_failed",
                extra={"session": self.session_id, "error": str(exc)},
                exc_info=True,
            )
            try:
                await self.emit({
                    "type": "error",
                    "message": str(exc),
                    "latency_ms": int((time.perf_counter() - started_at) * 1000),
                })
            except Exception:
                pass

    async def finish(self) -> None:
        event = self.vad.force_end()
        if event is not None and event.pcm is not None and event.pcm.size >= MIN_SEGMENT_SAMPLES:
            self.schedule(event.pcm, is_final=True, started_at=self.segment_t0 or time.perf_counter())
        pending = list(self.tasks)
        if pending:
            done, still_pending = await asyncio.wait(pending, timeout=10)
            for task in still_pending:
                task.cancel()
            if still_pending:
                await asyncio.gather(*still_pending, return_exceptions=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger = setup_logging()
    engine = WhisperEngine(settings, logger)
    vad_detector = load_vad(settings.use_silero, logger, settings.energy_threshold_db)
    gloss_fn, gloss_name = build_gloss_converter(settings, logger)
    lexicon = load_lexicon()
    history = HistoryStore()
    history.init()

    app.state.settings = settings
    app.state.logger = logger
    app.state.engine = engine
    app.state.vad_detector = vad_detector
    app.state.gloss_fn = gloss_fn
    app.state.gloss_name = gloss_name
    app.state.lexicon_signs = lexicon["sinais"]
    app.state.lexicon_versao = lexicon["versao"]
    app.state.history = history
    app.state.stats = LatencyStats()

    logger.info(
        "backend_ready",
        extra={
            "model": engine.describe(),
            "backend": vad_detector.name,
            "lexicon": lexicon["versao"],
            "gloss": gloss_name,
        },
    )
    yield
    history.close()
    logger.info("backend_stopped")


app = FastAPI(title="LibrasLive", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> JSONResponse:
    state = app.state
    engine: WhisperEngine = state.engine
    ok = engine.mode in {"faster-whisper", "demo"}
    return JSONResponse({
        "status": "ok" if ok else "degraded",
        "modelo": engine.describe(),
        "vad": state.vad_detector.name,
        "gloss": state.gloss_name,
        "lexicon": state.lexicon_versao,
        "historico": state.history.backend,
    })


@app.get("/lexicon")
async def get_lexicon() -> JSONResponse:
    state = app.state
    return JSONResponse({"versao": state.lexicon_versao, "sinais": state.lexicon_signs})


@app.get("/metrics")
async def get_metrics() -> JSONResponse:
    state = app.state
    return JSONResponse({
        "latency": state.stats.snapshot(),
        "modelo": state.engine.describe(),
        "vad": state.vad_detector.name,
        "lexicon": state.lexicon_versao,
    })


@app.get("/history")
async def get_history(limit: int = 50) -> JSONResponse:
    return JSONResponse({"transcricoes": app.state.history.list_transcripts(limit)})


@app.websocket("/stream")
async def stream(websocket: WebSocket) -> None:
    state = app.state
    await websocket.accept()
    session = StreamSession(websocket, state)
    state.logger.info("ws_connected", extra={"session": session.session_id})
    if state.engine.mode == "unavailable":
        await session.emit({
            "type": "error",
            "message": f"STT indisponível: {state.engine.error}. Instale faster-whisper e baixe o modelo (ver python/README.md).",
            "latency_ms": 0,
        })
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await session.on_audio(message["bytes"])
            elif message.get("text") is not None:
                await session.on_text(message["text"])
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        state.logger.error("ws_loop_failed", extra={"error": str(exc)}, exc_info=True)
    finally:
        await session.finish()
        state.logger.info("ws_disconnected", extra={"session": session.session_id})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")
