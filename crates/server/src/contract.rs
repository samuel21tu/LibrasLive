//! Tipos do contrato 6 (serde) — REEXPORTADOS de `libraslive-nlp` (Trama).
//!
//! Não existem mais tipos duplicados: `SignPose`, `GlossResult`, `LexiconResponse`
//! etc. são exatamente os tipos do crate de NLP. A integração é por serde e por
//! identidade de tipos — o `GlossResult` produzido pelo conversor canônico entra
//! direto no envelope `WsEvent::Gloss` sem conversão.

pub use libraslive_nlp::{
    Cabeca, Categoria, Expressao, GlossResult, GlossToken, LexiconResponse, SignPose, Sobrancelha,
    TokenTipo,
};

use serde::{Deserialize, Serialize};

/// Contrato 6.3 — respostas do WebSocket. `tag = "type"` gera exatamente
/// `{"type":"partial","text":"...","latency_ms":n}` etc.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    Partial { text: String, latency_ms: u64 },
    Final { text: String, latency_ms: u64 },
    Gloss { gloss: GlossResult, latency_ms: u64 },
    Error { message: String, latency_ms: u64 },
}

impl WsEvent {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"type\":\"error\",\"message\":\"serialização falhou\",\"latency_ms\":0}".to_string()
        })
    }
}

/// Mensagem de controle opcional do cliente (texto JSON no WebSocket).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Reset,
    StartCapture,
    StopCapture,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub modelo: String,
    /// Modo real do VAD: "silero-onnx" ou "energy".
    pub vad: String,
    pub gloss: String,
    pub lexicon: String,
    pub historico: String,
    /// Estado da captura de áudio do sistema: "ativo", "inativo" ou "desabilitado".
    pub capture: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_event_serialization_matches_contract_6_3() {
        let event = WsEvent::Partial {
            text: "olá".into(),
            latency_ms: 123,
        };
        assert_eq!(
            event.to_json(),
            r#"{"type":"partial","text":"olá","latency_ms":123}"#
        );
        let final_event = WsEvent::Final {
            text: "olá mundo".into(),
            latency_ms: 900,
        };
        assert_eq!(
            final_event.to_json(),
            r#"{"type":"final","text":"olá mundo","latency_ms":900}"#
        );
    }

    #[test]
    fn gloss_result_reexportado_tem_serializacao_do_contrato_6_2() {
        let gloss = GlossResult {
            tokens: vec![GlossToken {
                gloss: "OLA".into(),
                pose_id: "ola".into(),
                palavra_original: "olá".into(),
                tipo: TokenTipo::Frase,
                intensidade: 0.5,
                classificador: None,
            }],
            expressao: Expressao {
                sobrancelha: Sobrancelha::Neutra,
                cabeca: Cabeca::Neutra,
                intensidade: 0.5,
            },
            duracao_total_ms: 500,
            texto_original: "olá".into(),
        };
        let json = serde_json::to_string(&gloss).unwrap();
        assert!(json.contains("\"poseId\":\"ola\""));
        assert!(json.contains("\"palavraOriginal\":\"olá\""));
        assert!(json.contains("\"textoOriginal\":\"olá\""));
        assert!(json.contains("\"duracao_total_ms\":500"));
        assert!(json.contains("\"sobrancelha\":\"neutra\""));
    }

    #[test]
    fn categoria_accepts_accents_and_dedos() {
        let categoria: Categoria = serde_json::from_str("\"negação\"").unwrap();
        assert_eq!(categoria, Categoria::Negacao);
        let tipo: TokenTipo = serde_json::from_str("\"dedo\"").unwrap();
        assert_eq!(tipo, TokenTipo::Dedo);
    }
}
