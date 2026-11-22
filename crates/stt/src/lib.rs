//! LibrasLive — STT streaming com whisper-rs (dono: Eco).
//!
//! CONTRATO 2 — EVENTOS DE TEXTO (spec 6.3):
//! `TranscriptionEvent::Partial { text, latency_ms }` -> `{"type":"partial",...}`
//! `TranscriptionEvent::Final   { text, latency_ms }` -> `{"type":"final",...}`
//! O evento `gloss` é montado pelo crate `server` a partir do `final`.
//!
//! CONTRATO 1 — ENTRADA: PCM16 mono 16 kHz, frames de 320 amostras (do crate `audio`).
//! Modelo local (ggml-small.bin / small-pt), sem rede em runtime.
//! Latência alvo < 1.5s: parciais periódicas com greedy best_of=1; final com best_of=5.

pub mod whisper;

pub use whisper::{pcm_i16_to_f32, SttConfig, SttError, TranscriptionEvent, WhisperStream};

/// Sample rate canônico (contrato 6.3).
pub const SAMPLE_RATE: u32 = 16_000;
