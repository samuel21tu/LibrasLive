//! VAD incremental — Silero (onnxruntime-rs) com fallback por energia.
//!
//! Janela fixa: 512 amostras @ 16 kHz (32 ms). O segmentador reagrupa os frames
//! de 320 amostras do contrato 1 em janelas de 512 e aplica histerese:
//! fala começa acima de `threshold_start` e termina após `silence_windows_to_end`
//! janelas abaixo de `threshold_end`. O segmento devolvido inclui a cauda de silêncio.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use thiserror::Error;
use tracing::warn;

use crate::SAMPLE_RATE;

pub const VAD_WINDOW: usize = 512;

#[derive(Debug, Error)]
pub enum VadError {
    #[error("modelo Silero não encontrado: {0}")]
    ModelNotFound(String),
    #[error("onnxruntime: {0}")]
    Ort(String),
    #[error("configuração inválida: {0}")]
    InvalidConfig(String),
}

#[cfg(feature = "silero")]
impl<E> From<ort::Error<E>> for VadError {
    fn from(error: ort::Error<E>) -> Self {
        VadError::Ort(error.to_string())
    }
}

pub trait VadDetector: Send {
    fn name(&self) -> &'static str;
    fn probability(&mut self, window: &[f32; VAD_WINDOW]) -> f32;
}

#[derive(Debug, Clone)]
pub struct VadConfig {
    pub threshold_start: f32,
    pub threshold_end: f32,
    pub silence_windows_to_end: usize,
    pub min_speech_windows: usize,
    pub energy_db_threshold: f32,
    pub model_path: Option<PathBuf>,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            threshold_start: 0.5,
            threshold_end: 0.35,
            silence_windows_to_end: 15,
            min_speech_windows: 3,
            energy_db_threshold: -40.0,
            model_path: std::env::var("LIBRASLIVE_SILERO_MODEL")
                .ok()
                .map(PathBuf::from)
                .or_else(|| Some(PathBuf::from("models/silero_vad.onnx"))),
        }
    }
}

/// Fallback real e determinístico: RMS em dBFS mapeado de -60..-20 para 0..1.
pub struct EnergyVad {
    threshold_db: f32,
}

impl EnergyVad {
    pub fn new(threshold_db: f32) -> Self {
        Self { threshold_db }
    }
}

impl VadDetector for EnergyVad {
    fn name(&self) -> &'static str {
        "energy"
    }

    fn probability(&mut self, window: &[f32; VAD_WINDOW]) -> f32 {
        let sum: f64 = window.iter().map(|value| *value as f64 * *value as f64).sum();
        let rms = (sum / VAD_WINDOW as f64).sqrt();
        let db = 20.0 * (rms + 1e-9).log10();
        let normalized = ((db + 60.0) / 40.0) as f32;
        // Calibra de modo que `energy_db_threshold` corresponda a probabilidade 0.5
        // (o limiar padrão de início de fala do segmentador).
        let threshold_probability = (self.threshold_db + 60.0) / 40.0;
        ((normalized - threshold_probability) * 2.0 + 0.5).clamp(0.0, 1.0)
    }
}

/// Silero-VAD via `onnxruntime-rs` (`ort`). Modelo local, sem rede em runtime.
/// Environment ort compartilhado e sempre vivo (a sessão depende dele).
#[cfg(feature = "silero")]
fn ort_environment() -> Result<&'static ort::environment::Environment, VadError> {
    static ENVIRONMENT: OnceLock<ort::environment::Environment> = OnceLock::new();
    if let Some(environment) = ENVIRONMENT.get() {
        return Ok(environment);
    }
    let environment = ort::init().with_name("libraslive").build()?;
    Ok(ENVIRONMENT.get_or_init(|| environment))
}

#[cfg(feature = "silero")]
pub struct SileroVad {
    session: ort::session::Session,
    state: Vec<f32>,
}

#[cfg(feature = "silero")]
impl SileroVad {
    pub fn from_file(path: &Path) -> Result<Self, VadError> {
        if !path.exists() {
            return Err(VadError::ModelNotFound(path.display().to_string()));
        }
        let environment = ort_environment()?;
        let session = ort::session::Session::builder(environment)?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
            .with_intra_threads(1)?
            .commit_from_file(path)?;
        Ok(Self {
            session,
            state: vec![0.0_f32; 2 * 128],
        })
    }
}

#[cfg(feature = "silero")]
impl VadDetector for SileroVad {
    fn name(&self) -> &'static str {
        "silero-onnx"
    }

    fn probability(&mut self, window: &[f32; VAD_WINDOW]) -> f32 {
        let input = match ort::value::Tensor::from_array(([1usize, VAD_WINDOW], window.to_vec())) {
            Ok(value) => value,
            Err(error) => {
                warn!(error = %error, "silero input tensor falhou");
                return 0.0;
            }
        };
        let state = match ort::value::Tensor::from_array(([2usize, 1usize, 128usize], self.state.clone())) {
            Ok(value) => value,
            Err(error) => {
                warn!(error = %error, "silero state tensor falhou");
                return 0.0;
            }
        };
        let sample_rate = match ort::value::Tensor::from_array(([1usize], vec![SAMPLE_RATE as i64])) {
            Ok(value) => value,
            Err(error) => {
                warn!(error = %error, "silero sr tensor falhou");
                return 0.0;
            }
        };
        let outputs = match self.session.run(ort::inputs! {
            "input" => input,
            "state" => state,
            "sr" => sample_rate,
        }) {
            Ok(outputs) => outputs,
            Err(error) => {
                warn!(error = %error, "silero inferência falhou");
                return 0.0;
            }
        };
        let probability = outputs["output"]
            .try_extract_tensor::<f32>()
            .map(|(_shape, data)| data.first().copied().unwrap_or(0.0))
            .unwrap_or(0.0);
        if let Ok((_shape, data)) = outputs["hn"].try_extract_tensor::<f32>() {
            if data.len() == self.state.len() {
                self.state.copy_from_slice(data);
            }
        }
        probability
    }
}

/// Fábrica: Silero se o modelo existir; caso contrário, energia (com aviso).
pub fn create_vad(config: &VadConfig) -> Result<Box<dyn VadDetector>, VadError> {
    #[cfg(feature = "silero")]
    if let Some(path) = &config.model_path {
        match SileroVad::from_file(path) {
            Ok(detector) => {
                tracing::info!(backend = detector.name(), model = %path.display(), "VAD inicializado");
                return Ok(Box::new(detector));
            }
            Err(error) => warn!(error = %error, "Silero indisponível; usando VAD por energia"),
        }
    }
    Ok(Box::new(EnergyVad::new(config.energy_db_threshold)))
}

#[derive(Debug, Clone, PartialEq)]
pub enum VadEvent {
    SpeechStart { at_sample: u64, at_ms: u128 },
    SpeechEnd {
        at_sample: u64,
        at_ms: u128,
        /// PCM16 mono 16 kHz do segmento, incluindo a cauda de silêncio.
        pcm: Vec<i16>,
        duration_ms: u128,
    },
}

/// Segmentador incremental com histerese.
pub struct VoiceActivitySegmenter {
    detector: Box<dyn VadDetector>,
    config: VadConfig,
    carry: Vec<f32>,
    total_samples: u64,
    active: bool,
    silence_windows: usize,
    speech_windows: usize,
    segment: Vec<i16>,
}

impl VoiceActivitySegmenter {
    pub fn new(detector: Box<dyn VadDetector>, config: VadConfig) -> Self {
        Self {
            detector,
            config,
            carry: Vec::new(),
            total_samples: 0,
            active: false,
            silence_windows: 0,
            speech_windows: 0,
            segment: Vec::new(),
        }
    }

    pub fn is_speech_active(&self) -> bool {
        self.active
    }

    pub fn detector_name(&self) -> &'static str {
        self.detector.name()
    }

    /// Recebe PCM16 mono 16 kHz (qualquer tamanho) e devolve eventos concluídos.
    pub fn feed(&mut self, samples: &[i16]) -> Vec<VadEvent> {
        self.carry.extend(samples.iter().map(|value| *value as f32 / 32768.0));
        let mut events = Vec::new();

        while self.carry.len() >= VAD_WINDOW {
            let window_float: [f32; VAD_WINDOW] = self.carry[..VAD_WINDOW].try_into().unwrap();
            self.carry.drain(..VAD_WINDOW);
            let window_pcm: Vec<i16> = window_float
                .iter()
                .map(|value| (value * 32768.0).clamp(-32768.0, 32767.0) as i16)
                .collect();
            let sample_index = self.total_samples;
            self.total_samples += VAD_WINDOW as u64;
            let probability = self.detector.probability(&window_float);

            if !self.active && probability >= self.config.threshold_start {
                self.active = true;
                self.silence_windows = 0;
                self.speech_windows = 1;
                self.segment = window_pcm;
                events.push(VadEvent::SpeechStart {
                    at_sample: sample_index,
                    at_ms: self.to_ms(sample_index),
                });
            } else if self.active {
                self.speech_windows += 1;
                self.segment.extend_from_slice(&window_pcm);
                if probability < self.config.threshold_end {
                    self.silence_windows += 1;
                } else {
                    self.silence_windows = 0;
                }
                if self.silence_windows >= self.config.silence_windows_to_end
                    && self.speech_windows >= self.config.min_speech_windows
                {
                    events.push(self.close_segment(sample_index + VAD_WINDOW as u64));
                }
            }
        }
        events
    }

    pub fn force_end(&mut self) -> Option<VadEvent> {
        if !self.active || self.segment.is_empty() {
            return None;
        }
        Some(self.close_segment(self.total_samples))
    }

    pub fn current_segment(&self) -> Option<Vec<i16>> {
        if self.active && !self.segment.is_empty() {
            Some(self.segment.clone())
        } else {
            None
        }
    }

    pub fn reset(&mut self) {
        self.carry.clear();
        self.total_samples = 0;
        self.active = false;
        self.silence_windows = 0;
        self.speech_windows = 0;
        self.segment.clear();
    }

    fn close_segment(&mut self, at_sample: u64) -> VadEvent {
        let pcm = std::mem::take(&mut self.segment);
        let duration_ms = self.to_ms(pcm.len() as u64);
        self.active = false;
        self.silence_windows = 0;
        self.speech_windows = 0;
        VadEvent::SpeechEnd {
            at_sample,
            at_ms: self.to_ms(at_sample),
            pcm,
            duration_ms,
        }
    }

    fn to_ms(&self, samples: u64) -> u128 {
        samples as u128 * 1000 / SAMPLE_RATE as u128
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedVad(f32);
    impl VadDetector for FixedVad {
        fn name(&self) -> &'static str {
            "fixed"
        }
        fn probability(&mut self, _window: &[f32; VAD_WINDOW]) -> f32 {
            self.0
        }
    }

    fn loud_window() -> [f32; VAD_WINDOW] {
        let mut window = [0.0_f32; VAD_WINDOW];
        for (index, value) in window.iter_mut().enumerate() {
            *value = (index as f32 * 0.3).sin() * 0.7;
        }
        window
    }

    #[test]
    fn energy_probability_distinguishes_silence_and_speech() {
        let mut vad = EnergyVad::new(-40.0);
        assert!(vad.probability(&[0.0; VAD_WINDOW]) < 0.1);
        assert!(vad.probability(&loud_window()) > 0.8);
    }

    #[test]
    fn segmenter_emits_start_then_end_with_pcm() {
        let config = VadConfig {
            silence_windows_to_end: 2,
            min_speech_windows: 1,
            ..VadConfig::default()
        };
        let mut segmenter = VoiceActivitySegmenter::new(Box::new(FixedVad(0.9)), config.clone());
        let loud = vec![1000i16; VAD_WINDOW * 3];
        let events = segmenter.feed(&loud);
        assert!(matches!(events.first(), Some(VadEvent::SpeechStart { .. })));

        let mut segmenter = VoiceActivitySegmenter::new(Box::new(FixedVad(0.9)), config);
        let mut events = segmenter.feed(&loud);
        assert!(segmenter.is_speech_active());
        assert!(segmenter.current_segment().is_some());
        let tail = segmenter.force_end().expect("deve fechar segmento ativo");
        match tail {
            VadEvent::SpeechEnd { pcm, duration_ms, .. } => {
                assert_eq!(pcm.len(), VAD_WINDOW * 3);
                assert_eq!(duration_ms, (VAD_WINDOW * 3) as u128 * 1000 / SAMPLE_RATE as u128);
            }
            _ => panic!("evento inesperado"),
        }
        events.clear();
    }

    #[test]
    fn silence_does_not_start_segment() {
        let mut segmenter = VoiceActivitySegmenter::new(
            Box::new(FixedVad(0.0)),
            VadConfig::default(),
        );
        let events = segmenter.feed(&vec![0i16; VAD_WINDOW * 10]);
        assert!(events.is_empty());
        assert!(!segmenter.is_speech_active());
    }
}
