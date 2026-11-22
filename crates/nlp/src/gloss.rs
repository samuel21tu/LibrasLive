//! Conversor texto pt-BR → gloss LIBRAS (Master Spec §4 e §6.2).
//!
//! Regras aplicadas:
//! - tempo/condição primeiro, sujeito, objeto, verbo, negação/pergunta no fim;
//! - pergunta SIM/NÃO → sobrancelhas erguidas + cabeça inclinada;
//! - pergunta QU- → sobrancelhas franzidas;
//! - negação → cabeça balançando + sinal NÃO;
//! - intensidade → amplitude maior + expressão reforçada;
//! - classificadores → configuração de mão para objetos;
//! - palavra desconhecida → datilologia `dedo-<letra>` (nunca inventar sinal).

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::contracts::{
    Categoria, Expressao, GlossResult, GlossToken, LexiconResponse, SignPose, TokenTipo,
};
use crate::normalize::{
    normalizar, remover_acentos, TextoNormalizado, TipoPergunta, INTENSIFICADORES,
};

const LEXICON_JSON: &str = include_str!("../../../lexicon/libras.json");

/// Léxico canônico embutido no binário (funciona offline, sem I/O em runtime).
pub fn lexicon_embedido() -> &'static LexiconResponse {
    static LEXICON: OnceLock<LexiconResponse> = OnceLock::new();
    LEXICON.get_or_init(|| {
        serde_json::from_str(LEXICON_JSON).expect("lexicon/libras.json inválido (contrato §6.1)")
    })
}

/// Cópia do envelope de `GET /lexicon` (§6.3).
pub fn carregar_lexicon() -> LexiconResponse {
    lexicon_embedido().clone()
}

fn chave(palavra: &str) -> String {
    remover_acentos(palavra).to_lowercase().trim().to_string()
}

const PALAVRAS_FUNCIONAIS: &[&str] = &[
    "de", "a", "o", "as", "os", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em", "para",
    "por", "com", "sem", "ao", "aos", "e", "mas", "ou", "se", "lhe", "lhes", "me", "te", "vos",
    "que", "num", "numa", "numas", "numos",
];

const TEMPO_LEMAS: &[&str] = &[
    "hoje",
    "ontem",
    "amanha",
    "agora",
    "depois",
    "antes",
    "sempre",
    "ja",
    "ainda",
    "logo",
    "cedo",
    "tarde",
    "as-vezes",
    "primeiramente",
    "finalmente",
    "domingo",
    "segunda",
    "segunda-feira",
    "terca",
    "terca-feira",
    "quarta",
    "quarta-feira",
    "quinta",
    "quinta-feira",
    "sexta",
    "sexta-feira",
    "sabado",
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
    "dia",
    "noite",
    "manha",
    "semana",
    "mes",
    "ano",
];

const PRONOMES_SUJEITO: &[&str] = &[
    "eu", "voce", "ele", "ela", "nos", "eles", "elas", "mim", "ti", "isto", "este", "aquele",
    "quem", "alguem",
];

const CLASSIFICADORES_POR_SUBSTANTIVO: &[(&[&str], &str)] = &[
    (
        &[
            "cachorro", "gato", "passaro", "peixe", "cavalo", "vaca", "porco", "galinha", "animal",
            "ave",
        ],
        "garra",
    ),
    (
        &[
            "homem",
            "mulher",
            "menino",
            "menina",
            "crianca",
            "pessoa",
            "amigo",
            "familia",
            "mae",
            "pai",
            "irmao",
            "filho",
            "professor",
            "aluno",
            "medico",
            "enfermeiro",
            "bebe",
        ],
        "pino",
    ),
    (
        &[
            "casa",
            "escola",
            "livro",
            "mesa",
            "cadeira",
            "porta",
            "janela",
            "carro",
            "bicicleta",
            "aviao",
            "onibus",
            "trem",
            "prato",
            "copo",
            "celular",
            "computador",
            "cama",
            "sofa",
            "armario",
            "geladeira",
            "fogao",
            "televisao",
            "telefone",
            "mochila",
            "mala",
        ],
        "mao-plana",
    ),
    (
        &[
            "lapis", "caneta", "faca", "garfo", "colher", "escova", "chave",
        ],
        "dedo-indicador",
    ),
    (
        &[
            "agua",
            "cafe",
            "leite",
            "suco",
            "vinho",
            "cerveja",
            "refrigerante",
            "sopa",
        ],
        "concha",
    ),
];

/// Classificador de mão plausível para substantivos sem classificador explícito.
pub fn classificador_para_substantivo(id_ou_palavra: &str, sinais: &[SignPose]) -> Option<String> {
    let chave = chave(id_ou_palavra);
    let disponiveis: HashSet<&str> = sinais
        .iter()
        .filter(|sinal| {
            sinal.categoria == Categoria::Classificador && sinal.classificador.is_some()
        })
        .filter_map(|sinal| sinal.classificador.as_deref())
        .collect();
    for (termos, classificador) in CLASSIFICADORES_POR_SUBSTANTIVO {
        if termos.iter().any(|termo| chave.contains(termo)) && disponiveis.contains(classificador) {
            return Some((*classificador).to_string());
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Papel {
    Tempo,
    Condicao,
    Sujeito,
    Objeto,
    Verbo,
    Negacao,
    Pergunta,
}

#[derive(Debug, Clone)]
struct TokenInterno {
    token: GlossToken,
    papel: Papel,
    ordem: usize,
    duracao_ms: u64,
    eh_substantivo: bool,
}

struct Conversor<'a> {
    sinais: &'a [SignPose],
    por_id: HashMap<&'a str, &'a SignPose>,
    por_palavra: HashMap<String, Vec<&'a SignPose>>,
}

impl<'a> Conversor<'a> {
    fn novo(sinais: &'a [SignPose]) -> Self {
        let mut por_id = HashMap::with_capacity(sinais.len());
        let mut por_palavra: HashMap<String, Vec<&SignPose>> = HashMap::new();
        for sinal in sinais {
            por_id.insert(sinal.id.as_str(), sinal);
            for palavra in &sinal.palavras {
                let chave = chave(palavra);
                if chave.is_empty() {
                    continue;
                }
                let candidatos = por_palavra.entry(chave).or_default();
                if !candidatos.iter().any(|existente| existente.id == sinal.id) {
                    candidatos.push(sinal);
                }
            }
        }
        Self {
            sinais,
            por_id,
            por_palavra,
        }
    }

    /// Desambigue palavras com mais de um sentido ("como" pergunta vs. comer).
    fn resolver_sinal(
        &self,
        chave_palavra: &str,
        lemma: &str,
        normalizado: &TextoNormalizado,
    ) -> Option<&'a SignPose> {
        let por_chave = self.por_palavra.get(chave_palavra);
        let por_lema = self.por_palavra.get(lemma);
        let candidatos: &Vec<&SignPose> =
            if chave_palavra != lemma && por_lema.is_some_and(|lista| !lista.is_empty()) {
                por_lema.expect("lista de lemas verificada acima")
            } else {
                por_chave?
            };
        if candidatos.is_empty() {
            return None;
        }
        if candidatos.len() == 1 {
            return Some(candidatos[0]);
        }
        let eh_qu = normalizado.tipo_pergunta == Some(TipoPergunta::Qu);
        candidatos
            .iter()
            .copied()
            .find(|sinal| {
                (eh_qu && sinal.categoria == Categoria::Pergunta)
                    || (!eh_qu && sinal.categoria != Categoria::Pergunta)
            })
            .or_else(|| candidatos.first().copied())
    }

    fn criar_token_de_sinal(
        &self,
        sinal: &SignPose,
        palavra_original: &str,
        intensidade_geral: f32,
    ) -> GlossToken {
        let base = match sinal.categoria {
            Categoria::Adjetivo => 0.5,
            Categoria::Negacao => 0.4,
            Categoria::Verbo => 0.2,
            Categoria::Pergunta => 0.35,
            _ => 0.1,
        };
        let intensidade = ((base + intensidade_geral * 0.5) * 1000.0).round() / 1000.0;
        let classificador = sinal.classificador.clone().or_else(|| {
            if sinal.categoria == Categoria::Substantivo {
                classificador_para_substantivo(&sinal.id, self.sinais)
            } else {
                None
            }
        });
        GlossToken {
            gloss: sinal.gloss.clone(),
            pose_id: sinal.id.clone(),
            palavra_original: palavra_original.to_string(),
            tipo: TokenTipo::from(sinal.categoria),
            intensidade: intensidade.min(1.0),
            classificador,
        }
    }

    fn tokens_de_datilologia(&self, palavra: &str) -> Vec<GlossToken> {
        let sem_acentos = remover_acentos(palavra).to_lowercase();
        let mut tokens = Vec::new();
        for letra in sem_acentos
            .chars()
            .filter(|caracter| caracter.is_ascii_lowercase())
        {
            // O lexicon usa ids minúsculos: `dedo-a` ... `dedo-z`.
            let pose_id = format!("dedo-{letra}");
            let sinal = self.por_id.get(pose_id.as_str()).copied();
            tokens.push(GlossToken {
                gloss: letra.to_ascii_uppercase().to_string(),
                pose_id,
                palavra_original: palavra.to_string(),
                tipo: TokenTipo::Dedo,
                intensidade: 0.1,
                classificador: sinal.and_then(|sinal| sinal.classificador.clone()),
            });
        }
        tokens
    }

    fn eh_tempo(&self, sinal: &SignPose, lemma: &str) -> bool {
        let chave_lemma = chave(lemma);
        TEMPO_LEMAS.contains(&chave_lemma.as_str())
            || (sinal.categoria == Categoria::Adverbio
                && sinal
                    .notas
                    .as_deref()
                    .is_some_and(|notas| notas.to_lowercase().contains("tempo")))
    }

    fn papel_do_sinal(
        &self,
        sinal: &SignPose,
        lemma: &str,
        em_condicao: bool,
        normalizado: &TextoNormalizado,
    ) -> Papel {
        if sinal.categoria == Categoria::Negacao {
            return Papel::Negacao;
        }
        if sinal.categoria == Categoria::Pergunta && normalizado.eh_pergunta {
            return Papel::Pergunta;
        }
        if em_condicao {
            return Papel::Condicao;
        }
        if self.eh_tempo(sinal, lemma) {
            return Papel::Tempo;
        }
        if sinal.categoria == Categoria::Verbo {
            return Papel::Verbo;
        }
        Papel::Objeto
    }

    fn montar_tokens(&self, normalizado: &TextoNormalizado) -> Vec<TokenInterno> {
        let mut internos = Vec::new();
        let mut em_condicao = false;
        let mut ordem = 0usize;
        let intensificadores: HashSet<String> = INTENSIFICADORES.iter().map(|p| chave(p)).collect();
        let eh_qu = normalizado.tipo_pergunta == Some(TipoPergunta::Qu);

        for token in &normalizado.tokens {
            let chave_token = chave(&token.texto);
            let chave_lemma = chave(&token.lemma);

            if token.pausa_antes {
                em_condicao = false;
            }
            if chave_token == "se" {
                em_condicao = true;
                continue;
            }
            if intensificadores.contains(&chave_token) || intensificadores.contains(&chave_lemma) {
                continue;
            }
            if (PALAVRAS_FUNCIONAIS.contains(&chave_token.as_str())
                || PALAVRAS_FUNCIONAIS.contains(&chave_lemma.as_str()))
                && !(eh_qu && chave_token == "que")
            {
                continue;
            }

            match self.resolver_sinal(&chave_token, &chave_lemma, normalizado) {
                None => {
                    for dedo in self.tokens_de_datilologia(&token.original) {
                        let duracao_ms = self
                            .por_id
                            .get(dedo.pose_id.as_str())
                            .map_or(300, |sinal| sinal.duracao_ms as u64);
                        internos.push(TokenInterno {
                            token: dedo,
                            papel: Papel::Objeto,
                            ordem,
                            duracao_ms,
                            eh_substantivo: true,
                        });
                        ordem += 1;
                    }
                }
                Some(sinal) => {
                    let papel = self.papel_do_sinal(sinal, &token.lemma, em_condicao, normalizado);
                    let gloss_token =
                        self.criar_token_de_sinal(sinal, &token.original, normalizado.intensidade);
                    internos.push(TokenInterno {
                        eh_substantivo: matches!(
                            sinal.categoria,
                            Categoria::Substantivo | Categoria::Frase | Categoria::Datilologia
                        ) || gloss_token.tipo == TokenTipo::Dedo,
                        token: gloss_token,
                        papel,
                        ordem,
                        duracao_ms: sinal.duracao_ms as u64,
                    });
                    ordem += 1;
                }
            }
        }
        internos
    }

    fn reordenar(
        &self,
        mut internos: Vec<TokenInterno>,
        normalizado: &TextoNormalizado,
    ) -> Vec<TokenInterno> {
        let indice_verbo = internos.iter().position(|item| item.papel == Papel::Verbo);
        let mut sujeito_atribuido = false;

        for (indice, item) in internos.iter_mut().enumerate() {
            if !item.eh_substantivo {
                continue;
            }
            if matches!(
                item.papel,
                Papel::Condicao | Papel::Tempo | Papel::Pergunta | Papel::Negacao
            ) {
                continue;
            }
            let eh_pronome = PRONOMES_SUJEITO.contains(&item.token.pose_id.as_str())
                || PRONOMES_SUJEITO.contains(&chave(&item.token.palavra_original).as_str());
            if !sujeito_atribuido
                && (eh_pronome || indice_verbo.is_none() || indice < indice_verbo.unwrap())
            {
                item.papel = Papel::Sujeito;
                sujeito_atribuido = true;
            } else {
                item.papel = Papel::Objeto;
            }
        }

        if normalizado.tipo_pergunta == Some(TipoPergunta::SimNao) {
            if let Some(marcador) = self.por_id.get("pergunta-simnao") {
                internos.push(TokenInterno {
                    token: GlossToken {
                        gloss: marcador.gloss.clone(),
                        pose_id: marcador.id.clone(),
                        palavra_original: "?".into(),
                        tipo: TokenTipo::Pergunta,
                        intensidade: ((0.3 + normalizado.intensidade * 0.4) * 1000.0).round()
                            / 1000.0,
                        classificador: None,
                    },
                    papel: Papel::Pergunta,
                    ordem: usize::MAX,
                    duracao_ms: marcador.duracao_ms as u64,
                    eh_substantivo: false,
                });
            }
        }

        internos.sort_by(|a, b| a.papel.cmp(&b.papel).then_with(|| a.ordem.cmp(&b.ordem)));
        internos
    }

    fn converter(&self, texto: &str, normalizado: &TextoNormalizado) -> GlossResult {
        let ordenados = self.reordenar(self.montar_tokens(normalizado), normalizado);
        let tokens: Vec<GlossToken> = ordenados.iter().map(|item| item.token.clone()).collect();

        let intensidade = tokens
            .iter()
            .fold(normalizado.intensidade, |atual, token| {
                atual.max(token.intensidade)
            })
            .clamp(0.0, 1.0);
        let (sobrancelha, cabeca_padrao) = normalizado.expressao();
        let cabeca = if normalizado.tem_negacao {
            crate::contracts::Cabeca::Balancando
        } else {
            cabeca_padrao
        };

        GlossResult {
            duracao_total_ms: ordenados.iter().map(|item| item.duracao_ms).sum(),
            tokens,
            expressao: Expressao {
                sobrancelha,
                cabeca,
                intensidade,
            },
            texto_original: texto.to_string(),
        }
    }
}

/// Converte texto em `GlossResult` usando um léxico explicitamente fornecido.
///
/// Esta é a API de integração do backend: `text_to_gloss(&texto, &state.lexicon.sinais)`.
pub fn text_to_gloss(texto: &str, sinais: &[SignPose]) -> GlossResult {
    let normalizado = normalizar(texto);
    Conversor::novo(sinais).converter(texto, &normalizado)
}

/// Versão em pt-BR de `text_to_gloss`, com `TextoNormalizado` já calculado.
pub fn texto_para_gloss_com_entrada(
    texto: &str,
    normalizado: &TextoNormalizado,
    sinais: &[SignPose],
) -> GlossResult {
    Conversor::novo(sinais).converter(texto, normalizado)
}

/// Converte texto em `GlossResult` com o léxico canônico embutido (535 sinais).
pub fn texto_para_gloss(texto: &str) -> GlossResult {
    text_to_gloss(texto, &lexicon_embedido().sinais)
}

/// Alias semântico para integradores.
pub fn converter_texto_para_gloss(texto: &str) -> GlossResult {
    texto_para_gloss(texto)
}

/// Conversor sem estado, pronto para ser colocado no `AppState` do axum.
pub struct LexiconConverter;

impl LexiconConverter {
    pub fn name(&self) -> &'static str {
        "libraslive-nlp-rust-0.1"
    }

    pub fn to_gloss(&self, texto: &str, sinais: &[SignPose]) -> GlossResult {
        text_to_gloss(texto, sinais)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexicon_embutido_tem_535_sinais_validos() {
        let lexico = lexicon_embedido();
        assert!(lexico.sinais.len() >= 300);
        assert_eq!(lexico.sinais.len(), 535);
        assert!(lexico
            .sinais
            .iter()
            .all(|sinal| sinal.duracao_ms >= 250 && sinal.duracao_ms <= 2000));
    }
}
