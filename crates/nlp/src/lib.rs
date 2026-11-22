//! LibrasLive — NLP/Lexicon (dono: Trama).
//!
//! Contratos §6 idênticos aos de `libraslive-server` (integração por serde).
//! Integração no backend:
//!
//! ```ignore
//! use libraslive_nlp::{text_to_gloss, LexiconConverter};
//! let gloss = text_to_gloss(&texto, &state.lexicon.sinais);
//! // ou, preservando a assinatura do trait do servidor:
//! let gloss = LexiconConverter.to_gloss(&texto, &state.lexicon.sinais);
//! ```

pub mod contracts;
pub mod gloss;
pub mod normalize;

pub use contracts::{
    Cabeca, Categoria, Expressao, GlossResult, GlossToken, LexiconResponse, SignPose, Sobrancelha,
    TokenTipo,
};
pub use gloss::{
    carregar_lexicon, classificador_para_substantivo, converter_texto_para_gloss, lexicon_embedido,
    text_to_gloss, texto_para_gloss, texto_para_gloss_com_entrada, LexiconConverter,
};
pub use normalize::{
    expandir_abreviacoes, lematizar, normalizar, numero_por_extenso, numeros_por_extenso,
    remover_acentos, TextoNormalizado, TipoPergunta, TokenNormalizado, INTENSIFICADORES,
};
