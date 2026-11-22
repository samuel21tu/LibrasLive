"""Motor STT local com faster-whisper (CTranslate2).

Modelo padrão: `small` com idioma `pt` (offline após o primeiro download).
Para usar um modelo já baixado em pasta local:
    LIBRASLIVE_WHISPER_MODEL=./models/faster-whisper-small python server.py

`transcribe` é síncrono e bloqueante (CPU) — o servidor o chama via asyncio.to_thread.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from config import Settings

MIN_AUDIO_SAMPLES = int(0.12 * 16_000)


class WhisperEngine:
    def __init__(self, settings: Settings, logger: Any) -> None:
        self.settings = settings
        self.logger = logger
        self.model: Any = None
        self.mode = "unavailable"
        self.error: str = ""

        if settings.demo_stt:
            self.mode = "demo"
            logger.warning("demo_stt_active", extra={"model": "demo-text", "backend": "demo"})
            return

        try:
            from faster_whisper import WhisperModel  # type: ignore

            self.model = WhisperModel(
                settings.whisper_model,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
            )
            self.mode = "faster-whisper"
            logger.info(
                "whisper_ready",
                extra={
                    "model": self.describe(),
                    "backend": "faster-whisper",
                    "device": settings.whisper_device,
                    "compute_type": settings.whisper_compute_type,
                },
            )
        except Exception as exc:
            self.mode = "unavailable"
            self.error = str(exc)
            logger.error("whisper_unavailable", extra={"error": self.error}, exc_info=True)

    def describe(self) -> str:
        if self.mode == "demo":
            return "demo-text (LIBRASLIVE_DEMO_STT=1)"
        if self.mode == "unavailable":
            return f"indisponível: {self.error[:120]}"
        return (
            f"faster-whisper:{self.settings.whisper_model}/"
            f"{self.settings.whisper_compute_type}/{self.settings.language}"
        )

    def transcribe(self, audio: np.ndarray, beam_size: int = 5) -> str:
        if self.mode == "demo":
            return self.settings.demo_text
        if self.model is None:
            raise RuntimeError(f"STT indisponível: {self.error or 'modelo não carregado'}")

        audio = np.asarray(audio, dtype=np.float32)
        if audio.size < MIN_AUDIO_SAMPLES:
            return ""

        segments, _info = self.model.transcribe(
            audio,
            language=self.settings.language,
            beam_size=beam_size,
            vad_filter=False,  # VAD próprio (Silero) já segmenta
            condition_on_previous_text=False,  # evita repetições entre segmentos
            without_timestamps=True,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
        return " ".join(text.split())
