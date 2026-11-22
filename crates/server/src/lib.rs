//! LibrasLive — backend axum (dono: Eco).
//!
//! CONTRATO 3 (spec 6.3): `ws://127.0.0.1:8000/stream`
//!   Fonte de áudio PRIMÁRIA: captura de loopback do sistema (crates/audio) —
//!   PipeWire/Pulse monitor no Linux, WASAPI/dshow no Windows, fallback ffmpeg.
//!   O renderer pode enviar PCM por `sendAudio` como fonte OPCIONAL; quando a
//!   captura local está ativa, esses chunks são ignorados para não duplicar STT.
//!   Servidor -> clientes: JSON `partial` / `final` / `gloss` / `error`, todos
//!   com `latency_ms`, broadcast para TODOS os clientes conectados.
//!   Cliente -> servidor (texto JSON): `{"type":"reset"|"start_capture"|"stop_capture"}`.
//! `GET /lexicon` -> `{versao, sinais}`; `GET /health` -> `{status, modelo, vad, capture, ...}`.
//! `GET /capture/status`, `POST /capture/start`, `POST /capture/stop` controlam a captura.
//!
//! CONTRATO 4: o GlossResult é entregue ao renderer dentro do evento `gloss` do
//! WebSocket. `useGlossStream.ts` (Argila) consome esse evento — o backend não
//! conversa diretamente com a janela Tauri.
//!
//! Alinhamento NLP: `contract.rs` reexporta os tipos de `libraslive-nlp` (Trama)
//! e o pipeline usa `libraslive_nlp::text_to_gloss`. Não há tipos duplicados.

pub mod contract;
pub mod converter;
pub mod history;
pub mod metrics;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use converter::{GlossConverter, LexiconConverter};
use futures::{SinkExt, StreamExt};
use history::HistoryStore;
use libraslive_audio::capture::{CaptureConfig, LoopbackCapture};
use libraslive_audio::vad::{
    create_vad, EnergyVad, VadConfig, VadDetector, VadEvent, VoiceActivitySegmenter,
};
use libraslive_stt::{SttConfig, TranscriptionEvent, WhisperStream};
use metrics::{LatencyStats, LatencySnapshot};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::contract::{ClientMessage, HealthResponse, LexiconResponse, WsEvent};

const FRAME_BYTES: usize = 640;

/// Controle da captura de loopback do sistema.
#[derive(Clone, Default)]
pub struct AudioControl {
    /// Habilitação persistente (LIBRASLIVE_CAPTURE=0 desabilita).
    pub enabled: Arc<AtomicBool>,
    /// Verdadeiro somente enquanto um LoopbackCapture está rodando.
    pub active: Arc<AtomicBool>,
    pub backend: Arc<StdMutex<Option<String>>>,
    /// Task da captura — criada sob demanda por /capture/start ou WS start_capture.
    pub task: Arc<Mutex<Option<JoinHandle<()>>>>,
    /// Contador de spawns efetivos (usado para provar idempotência nos testes).
    pub starts: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct AppState {
    pub stt: Option<Arc<StdMutex<WhisperStream>>>,
    pub stt_rx: Arc<Mutex<Option<UnboundedReceiver<TranscriptionEvent>>>>,
    pub broadcast: broadcast::Sender<WsEvent>,
    pub vad: Arc<StdMutex<VoiceActivitySegmenter>>,
    /// "silero-onnx" ou "energy" — modo real reportado em /health.
    pub vad_mode: String,
    pub audio: AudioControl,
    pub lexicon: Arc<LexiconResponse>,
    pub converter: Arc<dyn GlossConverter>,
    pub history: Arc<HistoryStore>,
    pub metrics: Arc<LatencyStats>,
    pub model_label: String,
    pub degraded: bool,
}

fn lexicon_path() -> PathBuf {
    if let Ok(path) = std::env::var("LIBRASLIVE_LEXICON") {
        return PathBuf::from(path);
    }
    let raiz = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let canonico = raiz.join("lexicon/libras.json");
    if canonico.exists() {
        return canonico;
    }
    raiz.join("src/lexicon/libras.json")
}

pub fn load_lexicon() -> LexiconResponse {
    let caminho = lexicon_path();
    match std::fs::read_to_string(&caminho) {
        Ok(conteudo) => match serde_json::from_str::<LexiconResponse>(&conteudo) {
            Ok(lexico) => {
                info!(versao = %lexico.versao, sinais = lexico.sinais.len(), caminho = %caminho.display(), "léxico carregado");
                return lexico;
            }
            Err(erro) => warn!(error = %erro, "léxico inválido; usando léxico embutido"),
        },
        Err(erro) => warn!(error = %erro, caminho = %caminho.display(), "arquivo de léxico não encontrado; usando léxico embutido do nlp"),
    }
    libraslive_nlp::carregar_lexicon()
}

pub fn build_state() -> AppState {
    let lexicon = Arc::new(load_lexicon());
    let base = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".libraslive");
    let history = Arc::new(
        HistoryStore::open(&base.join("history.sqlite"), base.join("config.json"))
            .expect("falha ao abrir SQLite do histórico"),
    );

    let vad_config = VadConfig::default();
    let vad_detector: Box<dyn VadDetector> = match create_vad(&vad_config) {
        Ok(detector) => detector,
        Err(erro) => {
            error!(error = %erro, "falha ao criar VAD; usando energia");
            Box::new(EnergyVad::new(vad_config.energy_db_threshold))
        }
    };
    let vad_mode = vad_detector.name().to_string();
    info!(vad = %vad_mode, "VAD inicializado");
    let vad = Arc::new(StdMutex::new(VoiceActivitySegmenter::new(
        vad_detector,
        vad_config,
    )));

    let config = SttConfig::default();
    let (stt, rx, model_label, degraded) = match WhisperStream::create(config) {
        Ok((stream, receiver)) => {
            let rotulo = stream.describe();
            (Some(Arc::new(StdMutex::new(stream))), Some(receiver), rotulo, false)
        }
        Err(erro) => {
            error!(error = %erro, "STT indisponível; use LIBRASLIVE_DEMO_STT=1 para testar sem modelo");
            (None, None, format!("indisponível: {erro}"), true)
        }
    };

    let captura_habilitada = std::env::var("LIBRASLIVE_CAPTURE")
        .map(|valor| valor != "0")
        .unwrap_or(true);
    let (broadcast, _receiver) = broadcast::channel(256);

    AppState {
        stt,
        stt_rx: Arc::new(Mutex::new(rx)),
        broadcast,
        vad,
        vad_mode,
        audio: AudioControl {
            enabled: Arc::new(AtomicBool::new(captura_habilitada)),
            ..AudioControl::default()
        },
        lexicon,
        converter: Arc::new(LexiconConverter),
        history,
        metrics: Arc::new(LatencyStats::default()),
        model_label,
        degraded,
    }
}

/// Inicia o pipeline STT->gloss->broadcast e a captura de loopback do sistema.
/// Deve ser chamado uma vez, dentro do runtime tokio, antes de `axum::serve`.
pub async fn start_background_tasks(state: AppState) {
    match state.stt_rx.lock().await.take() {
        Some(receiver) => {
            let pipeline_state = state.clone();
            tokio::spawn(async move { pipeline_loop(receiver, pipeline_state).await });
            info!("pipeline STT -> gloss -> broadcast iniciado");
        }
        None => warn!("pipeline STT já iniciado"),
    }

    if start_capture_if_needed(&state).await {
        info!("captura do sistema iniciada no startup");
    } else {
        info!("captura do sistema desabilitada (LIBRASLIVE_CAPTURE=0); áudio via WebSocket aceito");
    }
}

/// Spawn idempotente da task de captura — chamado no startup, na API e no WS.
/// Retorna true somente quando uma nova task foi criada.
pub async fn start_capture_if_needed(state: &AppState) -> bool {
    if !state.audio.enabled.load(Ordering::Relaxed) {
        return false;
    }
    let mut guard = state.audio.task.lock().await;
    if let Some(handle) = guard.as_ref() {
        if !handle.is_finished() {
            return false;
        }
    }
    let capture_state = state.clone();
    let handle = tokio::spawn(async move { capture_loop(capture_state).await });
    state.audio.starts.fetch_add(1, Ordering::Relaxed);
    *guard = Some(handle);
    true
}

/// Parada graciosa: sinaliza `enabled=false`, aguarda o loop terminar e aborta se necessário.
pub async fn stop_capture(state: &AppState) {
    state.audio.enabled.store(false, Ordering::Relaxed);
    state.audio.active.store(false, Ordering::Relaxed);
    let handle = state.audio.task.lock().await.take();
    if let Some(handle) = handle {
        if !handle.is_finished() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !handle.is_finished() {
            handle.abort();
        }
        let _ = handle.await;
    }
    *state.audio.backend.lock().unwrap() = None;
}

/// Consome eventos do STT, gera gloss com o conversor canônico e faz broadcast.
async fn pipeline_loop(mut receiver: UnboundedReceiver<TranscriptionEvent>, state: AppState) {
    while let Some(evento) = receiver.recv().await {
        let eventos: Vec<WsEvent> = match evento {
            TranscriptionEvent::Partial { text, latency_ms } => {
                vec![WsEvent::Partial { text, latency_ms }]
            }
            TranscriptionEvent::Error { message, latency_ms } => {
                vec![WsEvent::Error { message, latency_ms }]
            }
            TranscriptionEvent::Final { text, latency_ms } => {
                let inicio = Instant::now();
                let gloss = state.converter.to_gloss(&text, &state.lexicon.sinais);
                let gloss_latency_ms = latency_ms + inicio.elapsed().as_millis() as u64;
                state.metrics.record(gloss_latency_ms);
                if let Ok(valor) = serde_json::to_value(&gloss) {
                    if let Err(erro) = state.history.add_transcript(&text, &valor, gloss_latency_ms, "system") {
                        error!(error = %erro, "falha ao persistir transcrição");
                    }
                }
                info!(
                    stt_latency_ms = latency_ms,
                    gloss_latency_ms = gloss_latency_ms,
                    tokens = gloss.tokens.len(),
                    "transcrição final pronta"
                );
                vec![
                    WsEvent::Final { text, latency_ms },
                    WsEvent::Gloss { gloss, latency_ms: gloss_latency_ms },
                ]
            }
        };
        for evento in eventos {
            let _ = state.broadcast.send(evento);
        }
    }
}

/// Captura contínua do áudio do sistema com VAD incremental.
async fn capture_loop(state: AppState) {
    loop {
        if !state.audio.enabled.load(Ordering::Relaxed) {
            state.audio.active.store(false, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        let config = CaptureConfig::default();
        let captura = match tokio::task::spawn_blocking(move || LoopbackCapture::start(config)).await {
            Ok(Ok(captura)) => captura,
            Ok(Err(erro)) => {
                error!(error = %erro, "captura de áudio do sistema falhou; áudio via WebSocket continua disponível");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            Err(erro) => {
                error!(error = %erro, "task de captura falhou");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let backend = captura.backend().label();
        *state.audio.backend.lock().unwrap() = Some(backend.clone());
        state.audio.active.store(true, Ordering::Relaxed);
        info!(backend = %backend, vad = %state.vad_mode, "captura de áudio do sistema iniciada");

        let receptor = captura.chunks().clone();
        let stt = state.stt.clone();
        let vad = state.vad.clone();
        let habilitado = state.audio.enabled.clone();
        let ponte = tokio::task::spawn_blocking(move || {
            for chunk in receptor.iter() {
                if !habilitado.load(Ordering::Relaxed) {
                    break;
                }
                let eventos = match vad.lock() {
                    Ok(mut segmentador) => segmentador.feed(&chunk.samples),
                    Err(_) => Vec::new(),
                };
                let iniciou = eventos.iter().any(|evento| matches!(evento, VadEvent::SpeechStart { .. }));
                let terminou = eventos.iter().any(|evento| matches!(evento, VadEvent::SpeechEnd { .. }));
                if let Some(stt) = &stt {
                    if let Ok(mut stt) = stt.lock() {
                        if iniciou {
                            stt.reset();
                        }
                        stt.push_chunk(&chunk.samples);
                        if terminou {
                            stt.finalize();
                        }
                    }
                }
            }
        });

        while state.audio.enabled.load(Ordering::Relaxed) && !ponte.is_finished() {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        state.audio.active.store(false, Ordering::Relaxed);
        let mut captura = captura;
        captura.stop();
        let _ = ponte.await;
        *state.audio.backend.lock().unwrap() = None;
        info!(backend = %backend, "captura de áudio do sistema parada");
    }
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/lexicon", get(lexicon))
        .route("/metrics", get(metrics))
        .route("/history", get(history))
        .route("/capture/status", get(capture_status))
        .route("/capture/start", post(capture_start))
        .route("/capture/stop", post(capture_stop))
        .route("/stream", get(stream))
        .with_state(state)
}

fn estado_captura(state: &AppState) -> &'static str {
    if !state.audio.enabled.load(Ordering::Relaxed) {
        "desabilitado"
    } else if state.audio.active.load(Ordering::Relaxed) {
        "ativo"
    } else {
        "inativo"
    }
}

async fn health(State(state): State<AppState>) -> axum::Json<HealthResponse> {
    axum::Json(HealthResponse {
        status: if state.degraded { "degraded" } else { "ok" }.into(),
        modelo: state.model_label.clone(),
        vad: state.vad_mode.clone(),
        gloss: state.converter.name().into(),
        lexicon: state.lexicon.versao.clone(),
        historico: "sqlite+json".into(),
        capture: estado_captura(&state).into(),
    })
}

async fn lexicon(State(state): State<AppState>) -> axum::Json<LexiconResponse> {
    axum::Json((*state.lexicon).clone())
}

#[derive(Debug, Deserialize)]
struct MetricsQuery {
    #[serde(default)]
    _verbose: bool,
}

async fn metrics(
    State(state): State<AppState>,
    _query: Query<MetricsQuery>,
) -> axum::Json<serde_json::Value> {
    let latencia: LatencySnapshot = state.metrics.snapshot();
    axum::Json(serde_json::json!({
        "latency": latencia,
        "modelo": state.model_label,
        "lexicon": state.lexicon.versao,
    }))
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    #[serde(default = "padrao_limite")]
    limit: i64,
}

fn padrao_limite() -> i64 {
    50
}

async fn history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "transcricoes": state.history.list_transcripts(query.limit)
    }))
}

async fn capture_status(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    let backend = state.audio.backend.lock().unwrap().clone();
    let task_running = state
        .audio
        .task
        .lock()
        .await
        .as_ref()
        .is_some_and(|handle| !handle.is_finished());
    axum::Json(serde_json::json!({
        "estado": estado_captura(&state),
        "backend": backend,
        "vad": state.vad_mode,
        "task_running": task_running,
        "starts": state.audio.starts.load(Ordering::Relaxed),
    }))
}

async fn capture_start(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    state.audio.enabled.store(true, Ordering::Relaxed);
    let iniciada = start_capture_if_needed(&state).await;
    info!(iniciada, "captura do sistema solicitada via API");
    axum::Json(serde_json::json!({
        "ok": true,
        "iniciada": iniciada,
        "estado": estado_captura(&state),
    }))
}

async fn capture_stop(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    stop_capture(&state).await;
    info!("captura do sistema parada via API");
    axum::Json(serde_json::json!({ "ok": true, "estado": "desabilitado" }))
}

async fn stream(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    info!("websocket /stream conectado");
    let (mut sink, mut fluxo) = socket.split();
    let mut eventos = state.broadcast.subscribe();
    let emissor = tokio::spawn(async move {
        while let Ok(evento) = eventos.recv().await {
            if sink.send(Message::Text(evento.to_json().into())).await.is_err() {
                break;
            }
        }
    });

    let silencio_ms: u64 = std::env::var("LIBRASLIVE_SILENCE_FINALIZE_MS")
        .ok()
        .and_then(|valor| valor.parse().ok())
        .unwrap_or(800);
    let limite_silencio = Duration::from_millis(silencio_ms);

    loop {
        let mensagem = match tokio::time::timeout(limite_silencio, fluxo.next()).await {
            Ok(Some(Ok(mensagem))) => mensagem,
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {
                // A captura local já finaliza por VAD; isto cobre apenas a fonte WS.
                if !state.audio.active.load(Ordering::Relaxed) {
                    if let Some(stt) = &state.stt {
                        if let Ok(mut stt) = stt.lock() {
                            stt.finalize();
                        }
                    }
                }
                continue;
            }
        };

        match mensagem {
            Message::Binary(bytes) => {
                if state.audio.active.load(Ordering::Relaxed) {
                    // Fonte local ativa: ignorar áudio do renderer para não duplicar STT.
                    continue;
                }
                if let Some(stt) = &state.stt {
                    if let Ok(mut guard) = stt.lock() {
                        for inicio in (0..bytes.len()).step_by(FRAME_BYTES) {
                            if inicio + FRAME_BYTES > bytes.len() {
                                break;
                            }
                            let frame = &bytes[inicio..inicio + FRAME_BYTES];
                            let amostras: Vec<i16> = (0..FRAME_BYTES)
                                .step_by(2)
                                .map(|indice| i16::from_le_bytes([frame[indice], frame[indice + 1]]))
                                .collect();
                            guard.push_chunk(&amostras);
                        }
                    }
                }
            }
            Message::Text(texto) => match serde_json::from_str::<ClientMessage>(&texto) {
                Ok(ClientMessage::Reset) => {
                    if let Some(stt) = &state.stt {
                        if let Ok(mut stt) = stt.lock() {
                            stt.reset();
                        }
                    }
                }
                Ok(ClientMessage::StartCapture) => {
                    state.audio.enabled.store(true, Ordering::Relaxed);
                    start_capture_if_needed(&state).await;
                }
                Ok(ClientMessage::StopCapture) => {
                    stop_capture(&state).await;
                }
                Err(_) => {}
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    if !state.audio.active.load(Ordering::Relaxed) {
        if let Some(stt) = &state.stt {
            if let Ok(mut stt) = stt.lock() {
                stt.finalize();
            }
        }
    }
    emissor.abort();
    info!("websocket /stream desconectado");
}

/// Resposta para rotas não registradas.
pub fn not_found() -> Response {
    (axum::http::StatusCode::NOT_FOUND, "não encontrado").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn estado_de_teste() -> AppState {
        let (broadcast, _receiver) = broadcast::channel(16);
        let detector: Box<dyn VadDetector> = Box::new(EnergyVad::new(-40.0));
        let modo = detector.name().to_string();
        let config = VadConfig::default();
        AppState {
            stt: None,
            stt_rx: Arc::new(Mutex::new(None)),
            broadcast,
            vad: Arc::new(StdMutex::new(VoiceActivitySegmenter::new(detector, config))),
            vad_mode: modo,
            audio: AudioControl::default(),
            lexicon: Arc::new(LexiconResponse {
                versao: "teste-1".into(),
                sinais: Vec::new(),
            }),
            converter: Arc::new(LexiconConverter),
            history: Arc::new(
                HistoryStore::open(Path::new(":memory:"), std::env::temp_dir().join("libraslive-test-config.json"))
                    .unwrap(),
            ),
            metrics: Arc::new(LatencyStats::default()),
            model_label: "demo-test".into(),
            degraded: false,
        }
    }

    #[tokio::test]
    async fn health_respeita_contrato_e_reporta_vad_real() {
        let resposta = create_router(estado_de_teste())
            .oneshot(axum::http::Request::builder().uri("/health").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resposta.status(), 200);
        let corpo = axum::body::to_bytes(resposta.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&corpo).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["modelo"], "demo-test");
        assert_eq!(json["vad"], "energy");
        assert_eq!(json["capture"], "desabilitado");
    }

    #[tokio::test]
    async fn controle_de_captura_por_api() {
        let estado = estado_de_teste();
        let router = create_router(estado.clone());
        let resposta = router
            .clone()
            .oneshot(axum::http::Request::builder().method("POST").uri("/capture/stop").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resposta.status(), 200);
        assert!(!estado.audio.enabled.load(Ordering::Relaxed));
        let resposta = router
            .oneshot(axum::http::Request::builder().uri("/capture/status").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let corpo = axum::body::to_bytes(resposta.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&corpo).unwrap();
        assert_eq!(json["estado"], "desabilitado");
    }

    #[tokio::test]
    async fn captura_inicia_sob_demanda_e_start_e_idempotente() {
        let estado = estado_de_teste();
        assert!(!estado.audio.enabled.load(Ordering::Relaxed));
        let router = create_router(estado.clone());

        let status0 = router
            .clone()
            .oneshot(axum::http::Request::builder().uri("/capture/status").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let corpo0 = axum::body::to_bytes(status0.into_body(), usize::MAX).await.unwrap();
        let json0: serde_json::Value = serde_json::from_slice(&corpo0).unwrap();
        assert_eq!(json0["task_running"], false);
        assert_eq!(json0["starts"], 0);

        let iniciar = |router: Router| async move {
            let resposta = router
                .oneshot(axum::http::Request::builder().method("POST").uri("/capture/start").body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            let corpo = axum::body::to_bytes(resposta.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&corpo).unwrap()
        };

        let primeiro = iniciar(router.clone()).await;
        assert_eq!(primeiro["iniciada"], true);

        let status1 = router
            .clone()
            .oneshot(axum::http::Request::builder().uri("/capture/status").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let corpo1 = axum::body::to_bytes(status1.into_body(), usize::MAX).await.unwrap();
        let json1: serde_json::Value = serde_json::from_slice(&corpo1).unwrap();
        assert_eq!(json1["task_running"], true, "captura deve estar em execução");
        assert_eq!(json1["starts"], 1);

        // Segundo start não deve criar outra task (idempotente).
        let segundo = iniciar(router.clone()).await;
        assert_eq!(segundo["iniciada"], false);
        let status2 = router
            .clone()
            .oneshot(axum::http::Request::builder().uri("/capture/status").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let corpo2 = axum::body::to_bytes(status2.into_body(), usize::MAX).await.unwrap();
        let json2: serde_json::Value = serde_json::from_slice(&corpo2).unwrap();
        assert_eq!(json2["starts"], 1);
        assert_eq!(json2["task_running"], true);

        let parar = router
            .oneshot(axum::http::Request::builder().method("POST").uri("/capture/stop").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(parar.status(), 200);
        assert!(!estado.audio.enabled.load(Ordering::Relaxed));
        assert!(estado.audio.task.lock().await.is_none());
    }

    #[tokio::test]
    async fn ws_broadcast_sobrevive_a_reconnect_de_dois_sockets() {
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

        let estado = estado_de_teste();
        let emissor = estado.broadcast.clone();
        let gerador = tokio::spawn(async move {
            let mut contador = 0u64;
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                contador += 1;
                let _ = emissor.send(WsEvent::Partial {
                    text: format!("evento-{contador}"),
                    latency_ms: contador,
                });
            }
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endereco = listener.local_addr().unwrap();
        let router = create_router(estado);
        let servidor = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let url = format!("ws://{endereco}/stream");

        async fn receber_partial(url: &str) -> String {
            let (mut ws, _resposta) = tokio_tungstenite::connect_async(url).await.unwrap();
            for _ in 0..40 {
                let mensagem = tokio::time::timeout(Duration::from_millis(500), ws.next())
                    .await
                    .expect("timeout esperando evento")
                    .expect("stream encerrado")
                    .expect("erro no websocket");
                if let TungsteniteMessage::Text(texto) = mensagem {
                    let json: serde_json::Value = serde_json::from_str(&texto).unwrap();
                    if json["type"] == "partial" {
                        return json["text"].as_str().unwrap().to_string();
                    }
                }
            }
            panic!("nenhum evento partial recebido");
        }

        // Primeiro socket (conexão inicial) e segundo socket (reconnect).
        let primeiro = receber_partial(&url).await;
        let segundo = receber_partial(&url).await;
        assert!(primeiro.starts_with("evento-"), "{primeiro}");
        assert!(segundo.starts_with("evento-"), "{segundo}");
        assert_ne!(primeiro, segundo);

        gerador.abort();
        servidor.abort();
    }

    #[tokio::test]
    async fn lexicon_devolve_versao_e_sinais() {
        let resposta = create_router(estado_de_teste())
            .oneshot(axum::http::Request::builder().uri("/lexicon").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let corpo = axum::body::to_bytes(resposta.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&corpo).unwrap();
        assert_eq!(json["versao"], "teste-1");
        assert!(json["sinais"].is_array());
    }
}
