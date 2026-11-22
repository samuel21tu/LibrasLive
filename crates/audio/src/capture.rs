//! Captura de loopback — contrato 1 (PCM16 mono 16 kHz, frames de 320 amostras).
//!
//! Estratégia:
//!   1. cpal no dispositivo de monitor/loopback (PipeWire/Pulse no Linux, WASAPI no Windows);
//!   2. ffmpeg `-f pulse -i <sink>.monitor` (Linux) ou `-f dshow -i audio=<device>` (Windows);
//!   3. override explícito via `LIBRASLIVE_FFMPEG_ARGS` / `CaptureConfig::ffmpeg_args`.
//!
//! O device de monitor é descoberto com `pactl get-default-sink` + `pactl list short sources`.
//! Todo o processamento é local/offline.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Stream, StreamConfig};
use crossbeam_channel::{Receiver, Sender};
use thiserror::Error;
use tracing::{info, warn};

use crate::{CHANNELS, FRAME_SAMPLES, SAMPLE_RATE};

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("nenhum dispositivo de captura disponível: {0}")]
    NoDevice(String),
    #[error("falha no cpal: {0}")]
    Cpal(#[from] cpal::Error),
    #[error("falha ao listar configurações cpal: {0}")]
    Configs(String),
    #[error("falha no ffmpeg: {0}")]
    Ffmpeg(String),
    #[error("configuração inválida: {0}")]
    InvalidConfig(String),
}

/// Frame PCM16 mono 16 kHz pronto para o VAD/STT.
#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub sequence: u64,
    /// Milissegundos monotônicos desde o início da captura.
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureBackend {
    Cpal { device: String },
    FfmpegPulse { source: String },
    FfmpegDshow { device: String },
    FfmpegOverride { args: Vec<String> },
}

impl CaptureBackend {
    pub fn label(&self) -> String {
        match self {
            CaptureBackend::Cpal { device } => format!("cpal:{device}"),
            CaptureBackend::FfmpegPulse { source } => format!("ffmpeg-pulse:{source}"),
            CaptureBackend::FfmpegDshow { device } => format!("ffmpeg-dshow:{device}"),
            CaptureBackend::FfmpegOverride { .. } => "ffmpeg-override".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CaptureConfig {
    pub chunk_samples: usize,
    pub device_hint: Option<String>,
    pub ffmpeg_args: Option<Vec<String>>,
    pub probe_timeout_ms: u64,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            chunk_samples: FRAME_SAMPLES,
            device_hint: std::env::var("LIBRASLIVE_AUDIO_DEVICE").ok(),
            ffmpeg_args: std::env::var("LIBRASLIVE_FFMPEG_ARGS")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.split_whitespace().map(str::to_string).collect()),
            probe_timeout_ms: 2_500,
        }
    }
}

struct Framer {
    pending: Vec<i16>,
    tx: Sender<AudioChunk>,
    sequence: u64,
    started: Instant,
    chunk_samples: usize,
}

impl Framer {
    fn push(&mut self, samples: &[i16]) {
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= self.chunk_samples {
            let frame: Vec<i16> = self.pending.drain(..self.chunk_samples).collect();
            let chunk = AudioChunk {
                samples: frame,
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
                sequence: self.sequence,
                timestamp_ms: self.started.elapsed().as_millis(),
            };
            self.sequence += 1;
            if self.tx.send(chunk).is_err() {
                self.pending.clear();
                break;
            }
        }
    }
}

fn mono_i16(data: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|group| (group.iter().map(|v| *v as i32).sum::<i32>() / channels as i32) as i16)
        .collect()
}

fn mono_f32(data: &[f32], channels: usize) -> Vec<i16> {
    let scaled: Vec<i16> = data
        .iter()
        .map(|v| (v.clamp(-1.0, 1.0) * 32_767.0) as i16)
        .collect();
    mono_i16(&scaled, channels)
}

fn mono_u8(data: &[u8], channels: usize) -> Vec<i16> {
    let scaled: Vec<i16> = data.iter().map(|v| ((*v as i16) - 128) * 256).collect();
    mono_i16(&scaled, channels)
}

fn preferred_device(host: &cpal::Host, hint: Option<&str>) -> Result<Device, AudioError> {
    let devices = host.devices().map_err(|error| AudioError::Configs(error.to_string()))?;
    let mut fallback: Option<Device> = None;
    for device in devices {
        let name = device.to_string();
        if let Some(hint) = hint {
            if name.to_lowercase().contains(&hint.to_lowercase()) {
                return Ok(device);
            }
        }
        let lower = name.to_lowercase();
        if lower.contains("monitor") || lower.contains("loopback") || lower.contains("stereo mix") || lower.contains("virtual") {
            return Ok(device);
        }
        if fallback.is_none() {
            fallback = Some(device);
        }
    }
    fallback.ok_or_else(|| AudioError::NoDevice("cpal não listou dispositivos de entrada".into()))
}

fn build_cpal_stream(
    device: &Device,
    framer: Arc<Mutex<Framer>>,
) -> Result<Stream, AudioError> {
    let config = StreamConfig {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        buffer_size: cpal::BufferSize::Default,
    };

    let format = device
        .supported_input_configs()
        .map_err(|error| AudioError::Configs(error.to_string()))?
        .find(|range| {
            range.channels() == CHANNELS
                && range.min_sample_rate() <= SAMPLE_RATE
                && range.max_sample_rate() >= SAMPLE_RATE
        })
        .map(|range| range.sample_format())
        .unwrap_or(cpal::SampleFormat::I16);

    let stream = match format {
        cpal::SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                let mono = mono_i16(data, CHANNELS as usize);
                if let Ok(mut guard) = framer.try_lock() {
                    guard.push(&mono);
                }
            },
            |error| warn!(error = %error, "cpal input error"),
            None,
        )?,
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| {
                let mono = mono_f32(data, CHANNELS as usize);
                if let Ok(mut guard) = framer.try_lock() {
                    guard.push(&mono);
                }
            },
            |error| warn!(error = %error, "cpal input error"),
            None,
        )?,
        cpal::SampleFormat::U8 => device.build_input_stream(
            config,
            move |data: &[u8], _| {
                let mono = mono_u8(data, CHANNELS as usize);
                if let Ok(mut guard) = framer.try_lock() {
                    guard.push(&mono);
                }
            },
            |error| warn!(error = %error, "cpal input error"),
            None,
        )?,
        other => return Err(AudioError::InvalidConfig(format!("formato cpal não suportado: {other:?}"))),
    };
    Ok(stream)
}

fn pulse_monitor_source() -> Option<String> {
    let sink = Command::new("pactl")
        .args(["get-default-sink"])
        .output()
        .ok()?;
    let sink = String::from_utf8_lossy(&sink.stdout).trim().to_string();
    if sink.is_empty() {
        return None;
    }
    let monitor = format!("{sink}.monitor");
    let sources = Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
        .ok()?;
    let sources = String::from_utf8_lossy(&sources.stdout);
    if sources.lines().any(|line| line.contains(&monitor)) {
        return Some(monitor);
    }
    sources.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.get(1).filter(|name| name.contains(".monitor")).map(|name| (*name).to_string())
    })
}

fn ffmpeg_tail() -> Vec<String> {
    vec![
        "-ac".into(),
        CHANNELS.to_string(),
        "-ar".into(),
        SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-f".into(),
        "s16le".into(),
        "pipe:1".into(),
    ]
}

fn ffmpeg_presets(config: &CaptureConfig) -> Vec<CaptureBackend> {
    if let Some(args) = &config.ffmpeg_args {
        return vec![CaptureBackend::FfmpegOverride { args: args.clone() }];
    }
    let mut presets = Vec::new();
    if cfg!(target_os = "linux") {
        if let Some(source) = pulse_monitor_source() {
            presets.push(CaptureBackend::FfmpegPulse { source });
        }
        presets.push(CaptureBackend::FfmpegPulse { source: "default".into() });
    } else if cfg!(target_os = "windows") {
        let mut candidates = vec!["virtual-audio-capturer", "Stereo Mix", "Mixagem estéreo"];
        if let Some(hint) = &config.device_hint {
            candidates.insert(0, hint.as_str());
        }
        for device in candidates {
            presets.push(CaptureBackend::FfmpegDshow { device: device.into() });
        }
    } else {
        presets.push(CaptureBackend::FfmpegPulse { source: "default".into() });
    }
    presets
}

fn ffmpeg_args(backend: &CaptureBackend) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
    ];
    match backend {
        CaptureBackend::FfmpegPulse { source } => {
            args.extend(["-f".into(), "pulse".into(), "-i".into(), source.clone()]);
        }
        CaptureBackend::FfmpegDshow { device } => {
            args.extend(["-f".into(), "dshow".into(), "-i".into(), format!("audio={device}")]);
        }
        CaptureBackend::FfmpegOverride { args: override_args } => {
            args.extend(override_args.clone());
        }
        CaptureBackend::Cpal { .. } => {}
    }
    args.extend(ffmpeg_tail());
    args
}

/// Captura contínua. A thread do ffmpeg é descartada ao chamar `stop()` ou `Drop`.
pub struct LoopbackCapture {
    backend: CaptureBackend,
    receiver: Receiver<AudioChunk>,
    stop: Arc<AtomicBool>,
    stream: Option<Stream>,
    ffmpeg: Option<std::thread::JoinHandle<()>>,
    child: Option<Child>,
}

impl LoopbackCapture {
    /// Tenta cpal primeiro, depois os presets do ffmpeg.
    pub fn start(config: CaptureConfig) -> Result<Self, AudioError> {
        let (tx, receiver) = crossbeam_channel::unbounded();
        let framer = Arc::new(Mutex::new(Framer {
            pending: Vec::new(),
            tx: tx.clone(),
            sequence: 0,
            started: Instant::now(),
            chunk_samples: config.chunk_samples.max(1),
        }));

        let host = cpal::default_host();
        if let Ok(device) = preferred_device(&host, config.device_hint.as_deref()) {
            let name = device.to_string();
            match build_cpal_stream(&device, Arc::clone(&framer)) {
                Ok(stream) => match stream.play() {
                    Ok(()) => {
                        info!(backend = %name, "captura cpal iniciada");
                        return Ok(Self {
                            backend: CaptureBackend::Cpal { device: name },
                            receiver,
                            stop: Arc::new(AtomicBool::new(false)),
                            stream: Some(stream),
                            ffmpeg: None,
                            child: None,
                        });
                    }
                    Err(error) => warn!(error = %error, "cpal play falhou; tentando ffmpeg"),
                },
                Err(error) => warn!(error = %error, "cpal build falhou; tentando ffmpeg"),
            }
        }

        for preset in ffmpeg_presets(&config) {
            let args = ffmpeg_args(&preset);
            match spawn_ffmpeg(&args, tx.clone(), config.chunk_samples.max(1), config.probe_timeout_ms) {
                Ok((child, handle)) => {
                    info!(backend = %preset.label(), "captura ffmpeg iniciada");
                    return Ok(Self {
                        backend: preset,
                        receiver,
                        stop: Arc::new(AtomicBool::new(false)),
                        stream: None,
                        ffmpeg: Some(handle),
                        child: Some(child),
                    });
                }
                Err(error) => warn!(backend = %preset.label(), error = %error, "ffmpeg falhou"),
            }
        }

        Err(AudioError::NoDevice(
            "cpal e ffmpeg falharam; verifique monitor do PulseAudio ou instale um virtual cable no Windows".into(),
        ))
    }

    pub fn backend(&self) -> &CaptureBackend {
        &self.backend
    }

    pub fn chunks(&self) -> &Receiver<AudioChunk> {
        &self.receiver
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.stream.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(handle) = self.ffmpeg.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_ffmpeg(
    args: &[String],
    tx: Sender<AudioChunk>,
    chunk_samples: usize,
    _probe_timeout_ms: u64,
) -> Result<(Child, std::thread::JoinHandle<()>), AudioError> {
    let mut child = Command::new("ffmpeg")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| AudioError::Ffmpeg(error.to_string()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| AudioError::Ffmpeg("stdout indisponível".into()))?;
    let handle = std::thread::spawn(move || {
        let mut pending = Vec::with_capacity(chunk_samples * 2);
        let mut buffer = [0u8; 4096];
        let mut sequence = 0u64;
        let started = Instant::now();
        loop {
            let read = match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => size,
            };
            pending.extend_from_slice(&buffer[..read]);
            let bytes = chunk_samples * 2;
            while pending.len() >= bytes {
                let frame_bytes: Vec<u8> = pending.drain(..bytes).collect();
                let samples: Vec<i16> = (0..bytes)
                    .step_by(2)
                    .map(|indice| i16::from_le_bytes([frame_bytes[indice], frame_bytes[indice + 1]]))
                    .collect();
                let chunk = AudioChunk {
                    samples,
                    sample_rate: SAMPLE_RATE,
                    channels: CHANNELS,
                    sequence,
                    timestamp_ms: started.elapsed().as_millis(),
                };
                sequence += 1;
                if tx.send(chunk).is_err() {
                    return;
                }
            }
        }
    });
    Ok((child, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_conversion_averages_channels() {
        assert_eq!(mono_i16(&[10, 20], 2), vec![15]);
        assert_eq!(mono_f32(&[1.0, 0.0], 2), vec![16_383]);
        assert_eq!(mono_u8(&[128, 255], 2), vec![16_256]);
    }

    #[test]
    fn framer_emits_exact_contract_frames() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut framer = Framer {
            pending: Vec::new(),
            tx,
            sequence: 0,
            started: Instant::now(),
            chunk_samples: FRAME_SAMPLES,
        };
        framer.push(&vec![1i16; 800]);
        let first = rx.recv().unwrap();
        let second = rx.recv().unwrap();
        assert_eq!(first.samples.len(), FRAME_SAMPLES);
        assert_eq!(second.samples.len(), FRAME_SAMPLES);
        assert_eq!(first.sample_rate, SAMPLE_RATE);
        assert_eq!(first.channels, CHANNELS);
        assert_eq!(first.sequence, 0);
        assert_eq!(second.sequence, 1);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn ffmpeg_tail_requests_pcm16_mono_16k() {
        let tail = ffmpeg_tail();
        assert!(tail.windows(2).any(|w| w == ["-ar", "16000"]));
        assert!(tail.windows(2).any(|w| w == ["-ac", "1"]));
        assert!(tail.windows(2).any(|w| w == ["-f", "s16le"]));
    }
}
