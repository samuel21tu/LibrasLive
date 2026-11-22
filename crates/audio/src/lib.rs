//! LibrasLive — captura de loopback e VAD (dono: Eco).
//!
//! CONTRATO 1 — CHUNK DE ÁUDIO (spec 6.3):
//! PCM16 little-endian, mono, 16_000 Hz, 320 amostras por frame (640 bytes, 20 ms).
//! `AudioChunk.samples` contém exatamente essas 320 amostras; `sequence` é monotônico
//! e `timestamp_ms` é derivado de `Instant` (monotônico, não epoch).
//!
//! Backends de captura: cpal (dispositivo de monitor/loopback) e ffmpeg
//! (`-f pulse` no Linux, `-f dshow` no Windows) como fallback universal.
//! VAD: Silero via onnxruntime-rs (`ort`) com fallback por energia RMS.

pub mod capture;
pub mod vad;

pub use capture::{AudioChunk, AudioError, CaptureBackend, CaptureConfig, LoopbackCapture};
pub use vad::{
    create_vad, EnergyVad, VadConfig, VadDetector, VadError, VadEvent, VoiceActivitySegmenter,
};

/// Sample rate canônico do contrato 6.3.
pub const SAMPLE_RATE: u32 = 16_000;
/// Amostras por frame: 20 ms a 16 kHz.
pub const FRAME_SAMPLES: usize = 320;
/// Canais: mono.
pub const CHANNELS: u16 = 1;
