"""Logging estruturado (JSON por linha) e métricas de latência do LibrasLive."""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from typing import Any

EXTRA_FIELDS = (
    "latency_ms",
    "gloss_latency_ms",
    "session",
    "stage",
    "model",
    "backend",
    "text",
    "error",
)


class JsonFormatter(logging.Formatter):
    """Formata cada registro como um objeto JSON numa única linha (stdout)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        for field in EXTRA_FIELDS:
            if hasattr(record, field):
                payload[field] = getattr(record, field)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("libraslive")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    logger.propagate = False
    return logger


class LatencyStats:
    """Estatísticas em memória de latência por estágio (STT/gloss)."""

    def __init__(self, capacity: int = 1000) -> None:
        self._samples: list[float] = []
        self._capacity = capacity
        self._lock = threading.Lock()

    def record(self, milliseconds: float) -> None:
        with self._lock:
            self._samples.append(float(milliseconds))
            if len(self._samples) > self._capacity:
                del self._samples[: len(self._samples) - self._capacity]

    def snapshot(self) -> dict[str, float | int]:
        with self._lock:
            samples = sorted(self._samples)
        if not samples:
            return {"count": 0, "avg_ms": 0, "p50_ms": 0, "p95_ms": 0, "max_ms": 0}
        count = len(samples)
        return {
            "count": count,
            "avg_ms": round(sum(samples) / count, 1),
            "p50_ms": round(samples[count // 2], 1),
            "p95_ms": round(samples[min(count - 1, int(count * 0.95))], 1),
            "max_ms": round(samples[-1], 1),
        }
