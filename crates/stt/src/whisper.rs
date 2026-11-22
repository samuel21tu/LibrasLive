//! Cliente de streaming whisper.cpp via whisper-rs.
//!
//! Offline: o modelo deve existir localmente. Baixe uma vez:
//!   curl -L -o models/ggml-small.bin \
//!     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
//! Modelos quantizados (ex.: ggml-small-q8_0.bin) reduzem CPU e latência.
//! Para pt-BR, use `ggml-small.bin` (multilingual) com `language = "pt"`.
//!
//! Modo de desenvolvimento explícito: `LIBRASLIVE_DEMO_STT=1` devolve um texto
//! fixo e não carrega modelo — útil para testar o pipeline sem baixar ~500 MB.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use thiserror::Error;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::SAMPLE_RATE;

const MIN_FINAL_SAMPLES: usize = (0.12 * SAMPLE_RATE as f64) as usize;
const MIN_PARTIAL_SAMPLES: usize = (0.20 * SAMPLE_RATE as f64) as usize;

#[derive(Debug, Error)]
pub enum SttError {
    #[error("modelo whisper não encontrado: {0}")]
    ModelNotFound(String),
    #[error("falha ao carregar modelo whisper: {0}")]
    Load(String),
    #[error("configuração inválida: {0}")]
    InvalidConfig(String),
}

#[derive(Debug, Clone)]
pub struct SttConfig {
    pub model_path: String,
    pub language: String,
    pub threads: i32,
    pub partial_interval_ms: u64,
    /// Quando Some, modo demo: texto fixo, sem modelo (LIBRASLIVE_DEMO_STT).
    pub demo_text: Option<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            model_path: std::env::var("LIBRASLIVE_WHISPER_MODEL")
                .unwrap_or_else(|_| "models/ggml-small.bin".to_string()),
            language: std::env::var("LIBRASLIVE_LANGUAGE").unwrap_or_else(|_| "pt".to_string()),
            threads: std::env::var("LIBRASLIVE_WHISPER_THREADS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(4),
            partial_interval_ms: std::env::var("LIBRASLIVE_PARTIAL_INTERVAL_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(700),
            demo_text: std::env::var("LIBRASLIVE_DEMO_STT")
                .ok()
                .filter(|value| value == "1")
                .map(|_| {
                    std::env::var("LIBRASLIVE_DEMO_TEXT")
                        .unwrap_or_else(|_| "olá, este é um teste de reconhecimento de fala".to_string())
                }),
        }
    }
}

/// Eventos do contrato 6.3. `#[serde(tag = "type")]` gera exatamente
/// `{"type":"partial","text":"...","latency_ms":n}` (e variantes final/error).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptionEvent {
    Partial { text: String, latency_ms: u64 },
    Final { text: String, latency_ms: u64 },
    Error { message: String, latency_ms: u64 },
}

impl TranscriptionEvent {
    pub fn to_ws_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"type\":\"error\",\"message\":\"serialização falhou\",\"latency_ms\":0}".to_string()
        })
    }
}

/// Converte PCM16 (i16) para f32 normalizado, exigido pelo whisper.cpp.
pub fn pcm_i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|sample| *sample as f32 / 32768.0).collect()
}

struct Worker {
    /// `None` apenas no modo demo, onde nenhum modelo é carregado.
    context: Option<Arc<WhisperContext>>,
    config: SttConfig,
}

impl Worker {
    fn transcribe(&self, audio: Vec<f32>, best_of: i32) -> Result<String, String> {
        if let Some(text) = &self.config.demo_text {
            return Ok(text.clone());
        }
        let context = self
            .context
            .as_ref()
            .ok_or_else(|| "contexto whisper indisponível".to_string())?;
        let mut state = context
            .create_state()
            .map_err(|error| format!("create_state: {error}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of });
        params.set_language(Some(&self.config.language));
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_n_threads(self.config.threads);
        state
            .full(params, &audio)
            .map_err(|error| format!("whisper full: {error}"))?;

        let mut parts = Vec::new();
        for index in 0..state.full_n_segments() {
            if let Some(segment) = state.get_segment(index) {
                if let Ok(text) = segment.to_str() {
                    let text = text.trim();
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
        Ok(parts.join(" "))
    }
}

/// Stream incremental: `push_chunk` acumula fala; `finalize` transcreve o segmento.
pub struct WhisperStream {
    worker: Arc<Worker>,
    tx: UnboundedSender<TranscriptionEvent>,
    partial_inflight: Arc<AtomicBool>,
    segment: Vec<i16>,
    segment_started: Instant,
    last_partial: Instant,
}

impl WhisperStream {
    /// Cria o stream e devolve o receiver dos eventos (contrato 6.3).
    pub fn create(config: SttConfig) -> Result<(Self, UnboundedReceiver<TranscriptionEvent>), SttError> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

        let context = if config.demo_text.is_some() {
            warn!("STT em modo demo (LIBRASLIVE_DEMO_STT=1) — nenhum modelo carregado");
            None
        } else {
            let path = Path::new(&config.model_path);
            if !path.exists() {
                return Err(SttError::ModelNotFound(config.model_path.clone()));
            }
            let context = WhisperContext::new_with_params(
                &config.model_path,
                WhisperContextParameters::default(),
            )
            .map_err(|error| SttError::Load(error.to_string()))?;
            info!(model = %config.model_path, "whisper.cpp carregado");
            Some(Arc::new(context))
        };

        let stream = Self {
            worker: Arc::new(Worker { context, config }),
            tx,
            partial_inflight: Arc::new(AtomicBool::new(false)),
            segment: Vec::new(),
            segment_started: Instant::now(),
            last_partial: Instant::now(),
        };
        Ok((stream, rx))
    }

    pub fn new(config: SttConfig) -> Result<Self, SttError> {
        let (stream, _rx) = Self::create(config)?;
        Ok(stream)
    }

    pub fn describe(&self) -> String {
        if self.worker.config.demo_text.is_some() {
            "demo-text (LIBRASLIVE_DEMO_STT=1)".to_string()
        } else {
            format!(
                "whisper.cpp:{}:{}",
                self.worker.config.model_path, self.worker.config.language
            )
        }
    }

    /// Recebe um frame PCM16 do contrato 1. Nunca bloqueia em inferência.
    pub fn push_chunk(&mut self, pcm: &[i16]) {
        if self.segment.is_empty() {
            self.segment_started = Instant::now();
            self.last_partial = self.segment_started;
        }
        self.segment.extend_from_slice(pcm);

        let interval = std::time::Duration::from_millis(self.worker.config.partial_interval_ms);
        if !self.partial_inflight.load(Ordering::Relaxed)
            && self.segment.len() >= MIN_PARTIAL_SAMPLES
            && self.last_partial.elapsed() >= interval
        {
            self.last_partial = Instant::now();
            self.partial_inflight.store(true, Ordering::Relaxed);
            let inicio = self.segment_started;
            self.spawn_transcription(self.segment.clone(), 1, false, inicio);
        }
    }

    /// Encerra o segmento atual e emite o evento `final`.
    pub fn finalize(&mut self) {
        if self.segment.len() < MIN_FINAL_SAMPLES {
            self.segment.clear();
            return;
        }
        let audio = std::mem::take(&mut self.segment);
        let inicio = self.segment_started;
        self.segment_started = Instant::now();
        self.spawn_transcription(audio, 5, true, inicio);
    }

    pub fn reset(&mut self) {
        self.segment.clear();
        self.segment_started = Instant::now();
        self.last_partial = self.segment_started;
    }

    fn spawn_transcription(&mut self, audio: Vec<i16>, best_of: i32, is_final: bool, started: Instant) {
        let worker = Arc::clone(&self.worker);
        let tx = self.tx.clone();
        let inflight = Arc::clone(&self.partial_inflight);
        let is_demo = worker.config.demo_text.is_some();

        let run = move || {
            let latency_ms = started.elapsed().as_millis() as u64;
            match worker.transcribe(pcm_i16_to_f32(&audio), best_of) {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        let event = if is_final {
                            TranscriptionEvent::Final { text, latency_ms }
                        } else {
                            TranscriptionEvent::Partial { text, latency_ms }
                        };
                        let _ = tx.send(event);
                    }
                }
                Err(message) => {
                    let _ = tx.send(TranscriptionEvent::Error { message, latency_ms });
                }
            }
            if !is_final {
                inflight.store(false, Ordering::Relaxed);
            }
        };

        if is_demo {
            run();
        } else {
            std::thread::spawn(run);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_config() -> SttConfig {
        SttConfig {
            model_path: "inexistente.bin".into(),
            language: "pt".into(),
            threads: 1,
            partial_interval_ms: 10,
            demo_text: Some("olá mundo".into()),
        }
    }

    #[test]
    fn pcm_conversion_is_normalized() {
        assert_eq!(pcm_i16_to_f32(&[0, 16_384, -16_384]), vec![0.0, 0.5, -0.5]);
    }

    #[test]
    fn demo_stream_emits_partial_and_final_with_contract_shape() {
        let (mut stream, mut events) = WhisperStream::create(demo_config()).unwrap();
        let loud = vec![1000i16; 16_000];
        stream.push_chunk(&loud);
        std::thread::sleep(std::time::Duration::from_millis(20));
        stream.push_chunk(&loud);
        let partial = events.try_recv().expect("partial esperado");
        assert!(matches!(partial, TranscriptionEvent::Partial { .. }));
        assert!(partial.to_ws_json().contains("\"type\":\"partial\""));
        assert!(partial.to_ws_json().contains("\"latency_ms\":"));

        stream.finalize();
        let final_event = events.try_recv().expect("final esperado");
        match &final_event {
            TranscriptionEvent::Final { text, latency_ms } => {
                assert_eq!(text, "olá mundo");
                assert!(*latency_ms < 1_500);
            }
            _ => panic!("evento inesperado"),
        }
        assert!(final_event.to_ws_json().contains("\"type\":\"final\""));
    }

    #[test]
    fn missing_model_returns_clear_error() {
        let config = SttConfig {
            demo_text: None,
            model_path: "/nao/existe/modelo.bin".into(),
            ..demo_config()
        };
        assert!(matches!(WhisperStream::new(config), Err(SttError::ModelNotFound(_))));
    }

    #[test]
    fn short_final_is_ignored() {
        let (mut stream, mut events) = WhisperStream::create(demo_config()).unwrap();
        stream.push_chunk(&[1i16; 10]);
        stream.finalize();
        assert!(events.try_recv().is_err());
    }
}
