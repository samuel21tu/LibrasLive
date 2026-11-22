//! Contratos de dados da Master Spec §6 — espelhos exatos dos tipos do backend.
//!
//! A integração é por serde: `GlossResult` serializado aqui é consumido diretamente
//! por `libraslive-server::contract::GlossResult` e pelo renderer via WebSocket.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// §6.1 — um sinal do léxico; é também a entrada do avatar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignPose {
    pub id: String,
    pub gloss: String,
    pub palavras: Vec<String>,
    pub categoria: Categoria,
    pub duracao_ms: u32,
    pub bones: HashMap<String, [f32; 4]>,
    pub blendshapes: HashMap<String, f32>,
    pub classificador: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Categoria {
    Substantivo,
    Verbo,
    Adjetivo,
    #[serde(rename = "advérbio")]
    Adverbio,
    Frase,
    Pergunta,
    #[serde(rename = "negação")]
    Negacao,
    Classificador,
    Datilologia,
}

/// §6.2 — um token da frase em LIBRAS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlossToken {
    pub gloss: String,
    #[serde(rename = "poseId")]
    pub pose_id: String,
    #[serde(rename = "palavraOriginal")]
    pub palavra_original: String,
    pub tipo: TokenTipo,
    pub intensidade: f32,
    pub classificador: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenTipo {
    Substantivo,
    Verbo,
    Adjetivo,
    #[serde(rename = "advérbio")]
    Adverbio,
    Frase,
    Pergunta,
    #[serde(rename = "negação")]
    Negacao,
    Classificador,
    Datilologia,
    Dedo,
}

impl From<Categoria> for TokenTipo {
    fn from(value: Categoria) -> Self {
        match value {
            Categoria::Substantivo => TokenTipo::Substantivo,
            Categoria::Verbo => TokenTipo::Verbo,
            Categoria::Adjetivo => TokenTipo::Adjetivo,
            Categoria::Adverbio => TokenTipo::Adverbio,
            Categoria::Frase => TokenTipo::Frase,
            Categoria::Pergunta => TokenTipo::Pergunta,
            Categoria::Negacao => TokenTipo::Negacao,
            Categoria::Classificador => TokenTipo::Classificador,
            Categoria::Datilologia => TokenTipo::Datilologia,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sobrancelha {
    Neutra,
    Erguida,
    Franzida,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cabeca {
    Neutra,
    Inclinada,
    Balancando,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Expressao {
    pub sobrancelha: Sobrancelha,
    pub cabeca: Cabeca,
    pub intensidade: f32,
}

/// §6.2 — saída completa do conversor texto → gloss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlossResult {
    pub tokens: Vec<GlossToken>,
    pub expressao: Expressao,
    pub duracao_total_ms: u64,
    #[serde(rename = "textoOriginal")]
    pub texto_original: String,
}

/// §6.3 — envelope de `GET /lexicon`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LexiconResponse {
    pub versao: String,
    pub sinais: Vec<SignPose>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializacao_segue_exatamente_o_contrato_6_2() {
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
        assert!(json.contains("\"tipo\":\"frase\""));
    }

    #[test]
    fn categorias_aceitam_acentos_da_spec() {
        assert_eq!(
            serde_json::from_str::<Categoria>("\"negação\"").unwrap(),
            Categoria::Negacao
        );
        assert_eq!(
            serde_json::from_str::<Categoria>("\"advérbio\"").unwrap(),
            Categoria::Adverbio
        );
        assert_eq!(
            serde_json::from_str::<TokenTipo>("\"dedo\"").unwrap(),
            TokenTipo::Dedo
        );
    }
}
