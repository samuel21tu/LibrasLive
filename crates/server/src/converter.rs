//! Ponte para o conversor canônico de NLP (dono: Trama).
//!
//! O conversor provisório foi REMOVIDO. Todo texto -> gloss passa por
//! `libraslive_nlp::text_to_gloss`, o mesmo usado nos 30 testes do crate `nlp`.
//! Isso garante que cada `poseId` emitido exista no léxico (inclusive os ids de
//! datilologia `dedo-a`..`dedo-z`, em minúsculas).

use crate::contract::{GlossResult, SignPose};

pub use libraslive_nlp::{carregar_lexicon, text_to_gloss, LexiconConverter};

/// Trait mantido para desacoplar o `AppState` do conversor concreto.
pub trait GlossConverter: Send + Sync {
    fn name(&self) -> &str;
    fn to_gloss(&self, texto: &str, sinais: &[SignPose]) -> GlossResult;
}

impl GlossConverter for LexiconConverter {
    fn name(&self) -> &str {
        LexiconConverter::name(self)
    }

    fn to_gloss(&self, texto: &str, sinais: &[SignPose]) -> GlossResult {
        LexiconConverter::to_gloss(self, texto, sinais)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversor_canonico_gera_apenas_pose_ids_existentes() {
        let lexico = carregar_lexicon();
        assert_eq!(lexico.sinais.len(), 535);
        for texto in [
            "olá mundo",
            "eu não quero ir hoje",
            "onde você está?",
            "xyzqw",
        ] {
            let gloss = text_to_gloss(texto, &lexico.sinais);
            for token in &gloss.tokens {
                assert!(
                    lexico.sinais.iter().any(|sinal| sinal.id == token.pose_id),
                    "poseId '{}' inexistente no léxico (texto: {texto})",
                    token.pose_id
                );
            }
        }
    }

    #[test]
    fn datilologia_usa_ids_minusculos() {
        let lexico = carregar_lexicon();
        let gloss = text_to_gloss("xyz", &lexico.sinais);
        let dedos: Vec<&str> = gloss
            .tokens
            .iter()
            .filter(|token| token.pose_id.starts_with("dedo-"))
            .map(|token| token.pose_id.as_str())
            .collect();
        assert!(!dedos.is_empty());
        assert!(dedos.iter().all(|id| id.chars().all(|c| c.is_lowercase() || c == '-')));
    }
}
