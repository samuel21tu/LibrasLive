"""Detecção de atividade de voz incremental.

Backends, em ordem de preferência:
  1. Silero-VAD (`silero_vad` pip, modo torch) com estado recorrente;
  2. Silero-VAD `VADIterator` (quando a assinatura do modelo difere);
  3. VAD por energia RMS em dBFS — implementação real, sem modelos.

A janela é 512 amostras @ 16 kHz (32 ms). O state machine com histerese evita
cortar palavras e adiciona ~480 ms de silêncio de cauda para o Whisper.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

SAMPLE_RATE = 16_000
WINDOW = 512


class BaseVad(ABC):
    name: str = "base"

    @abstractmethod
    def probability(self, window: np.ndarray) -> float:
        """Probabilidade de fala (0..1) para exatamente WINDOW amostras float32."""


class EnergyVad(BaseVad):
    """Fallback determinístico: mapeia RMS de -60..-20 dBFS para 0..1."""

    name = "energy"

    def __init__(self, threshold_db: float = -40.0) -> None:
        self.threshold_db = threshold_db

    def probability(self, window: np.ndarray) -> float:
        rms = float(np.sqrt(np.mean(np.square(window, dtype=np.float64))))
        db = 20.0 * math.log10(rms + 1e-9)
        return max(0.0, min(1.0, (db + 60.0) / 40.0))


class SileroVad(BaseVad):
    """Silero-VAD via pacote `silero_vad` (modelo local em cache)."""

    name = "silero"

    def __init__(self) -> None:
        try:
            from silero_vad import load_silero_vad  # type: ignore
        except ImportError as exc:
            raise RuntimeError("pacote silero_vad não instalado") from exc

        try:
            self.model = load_silero_vad()
        except TypeError:
            self.model = load_silero_vad(onnx=False)  # type: ignore[call-arg]

        self.state: Any = None
        self.iterator: Any = None
        try:
            import torch  # type: ignore
            self.state = torch.zeros(2, 1, 128)
        except ImportError:
            pass

    def probability(self, window: np.ndarray) -> float:
        try:
            import torch  # type: ignore

            tensor = torch.from_numpy(np.ascontiguousarray(window)).unsqueeze(0)
            with torch.inference_mode():
                if self.state is None:
                    output, state = self.model(tensor, torch.tensor(SAMPLE_RATE))
                else:
                    try:
                        output, state = self.model(tensor, self.state, torch.tensor(SAMPLE_RATE))
                    except (TypeError, RuntimeError):
                        output, state = self.model(tensor, torch.tensor(SAMPLE_RATE))
                self.state = state
            return float(output.item())
        except Exception:
            # Segunda assinatura: VADIterator devolve um dict quando há fala.
            try:
                from silero_vad import VADIterator  # type: ignore
                import torch  # type: ignore

                if self.iterator is None:
                    self.iterator = VADIterator(self.model)
                result = self.iterator(torch.from_numpy(np.ascontiguousarray(window)))
                return 1.0 if result else 0.0
            except Exception:
                return 0.0


def load_vad(use_silero: bool, logger: Any, energy_threshold_db: float = -40.0) -> BaseVad:
    if use_silero:
        try:
            detector = SileroVad()
            logger.info("silero_vad_ready", extra={"backend": detector.name})
            return detector
        except Exception as exc:
            logger.warning("silero_vad_unavailable", extra={"error": str(exc)})
    detector = EnergyVad(energy_threshold_db)
    logger.warning("energy_vad_active", extra={"backend": detector.name, "threshold_db": energy_threshold_db})
    return detector


@dataclass
class VadEvent:
    type: str  # "start" | "end"
    sample_index: int
    pcm: Optional[np.ndarray] = None  # preenchido em "end": float32, segmento completo


class StreamingVAD:
    """Segmentador incremental com histerese e limite de duração de segmento."""

    def __init__(
        self,
        detector: BaseVad,
        start_threshold: float = 0.50,
        end_threshold: float = 0.35,
        silence_windows: int = 15,
        min_speech_windows: int = 3,
        max_segment_samples: Optional[int] = None,
    ) -> None:
        self.detector = detector
        self.start_threshold = start_threshold
        self.end_threshold = end_threshold
        self.silence_windows = silence_windows
        self.min_speech_windows = min_speech_windows
        self.max_segment_samples = max_segment_samples
        self._carry = np.empty(0, dtype=np.float32)
        self._total = 0
        self._active = False
        self._silence = 0
        self._speech_len = 0
        self._segment_start = 0
        self._segment: list[np.ndarray] = []

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def detector_name(self) -> str:
        return self.detector.name

    def process(self, samples: np.ndarray) -> list[VadEvent]:
        """Recebe PCM float32 16 kHz; devolve eventos concluídos nesta chamada."""
        samples = np.asarray(samples, dtype=np.float32)
        self._carry = np.concatenate((self._carry, samples)) if self._carry.size else samples
        events: list[VadEvent] = []

        while self._carry.size >= WINDOW:
            window = self._carry[:WINDOW].copy()
            self._carry = self._carry[WINDOW:]
            index = self._total
            self._total += WINDOW
            probability = self.detector.probability(window)

            if not self._active and probability >= self.start_threshold:
                self._active = True
                self._silence = 0
                self._speech_len = 1
                self._segment_start = index
                self._segment = [window]
                events.append(VadEvent("start", index))
            elif self._active:
                self._segment.append(window)
                self._speech_len += 1
                if probability < self.end_threshold:
                    self._silence += 1
                else:
                    self._silence = 0

                too_long = (
                    self.max_segment_samples is not None
                    and (self._speech_len * WINDOW) >= self.max_segment_samples
                )
                if (
                    (self._silence >= self.silence_windows and self._speech_len >= self.min_speech_windows)
                    or too_long
                ):
                    events.append(self._close(index + WINDOW))
        return events

    def current_segment_audio(self) -> Optional[np.ndarray]:
        if not self._active or not self._segment:
            return None
        return np.concatenate(self._segment).copy()

    def force_end(self) -> Optional[VadEvent]:
        if not self._active or not self._segment:
            return None
        return self._close(self._total)

    def reset(self) -> None:
        self._carry = np.empty(0, dtype=np.float32)
        self._total = 0
        self._active = False
        self._silence = 0
        self._speech_len = 0
        self._segment = []

    def _close(self, at_sample: int) -> VadEvent:
        event = VadEvent("end", at_sample, np.concatenate(self._segment).copy())
        self._active = False
        self._silence = 0
        self._speech_len = 0
        self._segment = []
        return event
