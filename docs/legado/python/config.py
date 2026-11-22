"""Configuração central do backend LibrasLive (dono: agente de Áudio/STT).

Todas as opções são via variáveis de ambiente para manter o backend offline e
portátil. Nenhuma chamada de rede é feita por este módulo.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEXICON_PATH = ROOT / "src" / "lexicon" / "libras.json"


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("LIBRASLIVE_HOST", "127.0.0.1")
    port: int = _int_env("LIBRASLIVE_PORT", 8000)

    # faster-whisper / CTranslate2 — modelo local (pasta ou nome HF em cache).
    whisper_model: str = os.getenv("LIBRASLIVE_WHISPER_MODEL", "small")
    whisper_device: str = os.getenv("LIBRASLIVE_WHISPER_DEVICE", "cpu")
    whisper_compute_type: str = os.getenv("LIBRASLIVE_WHISPER_COMPUTE", "int8")
    language: str = os.getenv("LIBRASLIVE_LANGUAGE", "pt")

    # VAD
    use_silero: bool = os.getenv("LIBRASLIVE_VAD", "silero").lower() != "energy"
    vad_start: float = _float_env("LIBRASLIVE_VAD_START", 0.50)
    vad_end: float = _float_env("LIBRASLIVE_VAD_END", 0.35)
    vad_silence_windows: int = _int_env("LIBRASLIVE_VAD_SILENCE_WINDOWS", 15)
    vad_min_speech_windows: int = _int_env("LIBRASLIVE_VAD_MIN_SPEECH_WINDOWS", 3)
    energy_threshold_db: float = _float_env("LIBRASLIVE_ENERGY_DB", -40.0)

    # Streaming / latência
    partial_interval_ms: int = _int_env("LIBRASLIVE_PARTIAL_INTERVAL_MS", 700)
    max_segment_ms: int = _int_env("LIBRASLIVE_MAX_SEGMENT_MS", 15000)

    # NLP: módulo externo opcional que implementa text_to_gloss(texto, sinais)
    gloss_module: str | None = os.getenv("LIBRASLIVE_GLOSS_MODULE") or None

    # Modo de desenvolvimento explícito (NÃO é o padrão): sem modelos, texto fixo.
    demo_stt: bool = os.getenv("LIBRASLIVE_DEMO_STT", "0") == "1"
    demo_text: str = os.getenv("LIBRASLIVE_DEMO_TEXT", "olá, este é um teste de reconhecimento de fala")


settings = Settings()
