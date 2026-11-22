//! Normalizador pt-BR determinístico e offline.
//!
//! Caminho principal: minúsculas, remoção de pontuação ruidosa, expansão de
//! abreviações, números por extenso, lematização por dicionário + regras.
//! Não exige modelo externo: o fallback é sempre disponível e determinístico.
//!
//! Modelo opcional: se quiser refinar os lemas com spaCy, instale
//! `python -m pip install spacy` e `python -m spacy download pt_core_news_md`
//! e use um subprocess Python na camada de aplicação; este crate permanece
//! puro (sem dependências nativas) e não muda de resultado conforme o ambiente.

use crate::contracts::{Cabeca, Sobrancelha};

/// Um token depois da normalização.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenNormalizado {
    /// Palavra como apareceu no texto (após quebra de abreviações/números).
    pub original: String,
    /// Minúsculas, acentos preservados.
    pub texto: String,
    /// Lema em minúsculas, acentos preservados.
    pub lemma: String,
    /// Posição (em bytes) no texto normalizado.
    pub indice: usize,
    /// Houve vírgula, ponto e vírgula, dois pontos ou travessão antes.
    pub pausa_antes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoPergunta {
    SimNao,
    Qu,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextoNormalizado {
    pub texto_original: String,
    pub texto_normalizado: String,
    pub tokens: Vec<TokenNormalizado>,
    pub eh_pergunta: bool,
    pub tipo_pergunta: Option<TipoPergunta>,
    pub tem_negacao: bool,
    /// Intensidade detectada por intensificadores e "!"; 0..1.
    pub intensidade: f32,
}

impl TextoNormalizado {
    pub fn expressao(&self) -> (Sobrancelha, Cabeca) {
        match self.tipo_pergunta {
            Some(TipoPergunta::Qu) => (Sobrancelha::Franzida, Cabeca::Neutra),
            Some(TipoPergunta::SimNao) => (Sobrancelha::Erguida, Cabeca::Inclinada),
            None => (Sobrancelha::Neutra, Cabeca::Neutra),
        }
    }
}

/// Remove acentos diacríticos do português (também maiúsculos).
pub fn remover_acentos(texto: &str) -> String {
    texto
        .chars()
        .map(|caracter| match caracter {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' => 'a',
            'é' | 'ê' | 'ë' | 'É' | 'Ê' | 'Ë' => 'e',
            'í' | 'î' | 'ï' | 'Í' | 'Î' | 'Ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ú' | 'û' | 'ü' | 'Ú' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'ñ' | 'Ñ' => 'n',
            outro => outro,
        })
        .collect()
}

const ABREVIACOES: &[(&str, &str)] = &[
    ("vcs", "vocês"),
    ("vc", "você"),
    ("obgd", "obrigado"),
    ("obg", "obrigado"),
    ("vlw", "valeu"),
    ("blz", "beleza"),
    ("tbm", "também"),
    ("tm", "também"),
    ("tb", "também"),
    ("msm", "mesmo"),
    ("cmg", "comigo"),
    ("pras", "para as"),
    ("pros", "para os"),
    ("pro", "para o"),
    ("pra", "para"),
    ("qd", "quando"),
    ("qto", "quanto"),
    ("qt", "quanto"),
    ("mto", "muito"),
    ("mt", "muito"),
    ("tds", "todos"),
    ("td", "tudo"),
    ("cmo", "como"),
    ("pq", "por que"),
    ("amanha", "amanhã"),
    ("agr", "agora"),
    ("eh", "é"),
    ("n", "não"),
    ("fone", "telefone"),
    ("cel", "celular"),
    ("pc", "computador"),
];

/// Expande abreviações comuns mantendo pontuação e espaços originais.
pub fn expandir_abreviacoes(texto: &str) -> String {
    let mut resultado = String::with_capacity(texto.len());
    let mut atual = String::new();

    for caracter in texto.chars().chain(std::iter::once('\0')) {
        if caracter != '\0' && caracter.is_alphanumeric() {
            atual.push(caracter);
            continue;
        }
        if !atual.is_empty() {
            let chave = atual.to_lowercase();
            let expandida = ABREVIACOES
                .iter()
                .find(|(abreviatura, _)| *abreviatura == chave)
                .map(|(_, cheia)| *cheia)
                .unwrap_or(&atual);
            resultado.push_str(expandida);
            atual.clear();
        }
        if caracter != '\0' {
            resultado.push(caracter);
        }
    }
    resultado
}

const UNIDADES: &[&str] = &[
    "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
];
const DEZENAS: &[&str] = &[
    "",
    "dez",
    "vinte",
    "trinta",
    "quarenta",
    "cinquenta",
    "sessenta",
    "setenta",
    "oitenta",
    "noventa",
];
const CENTENAS: &[&str] = &[
    "",
    "cem",
    "duzentos",
    "trezentos",
    "quatrocentos",
    "quinhentos",
    "seiscentos",
    "setecentos",
    "oitocentos",
    "novecentos",
];
const IRREGULARES_10_A_19: &[&str] = &[
    "dez",
    "onze",
    "doze",
    "treze",
    "catorze",
    "quinze",
    "dezesseis",
    "dezessete",
    "dezoito",
    "dezenove",
];

fn ate_novecentos(n: u64, partes: &mut Vec<String>) {
    let centena = (n / 100) as usize;
    let resto = (n % 100) as usize;
    if centena > 0 {
        if centena == 1 && resto > 0 {
            partes.push("cento".into());
        } else {
            partes.push(CENTENAS[centena].into());
        }
    }
    if resto > 0 {
        if resto < 10 {
            partes.push(UNIDADES[resto].into());
        } else if resto < 20 {
            partes.push(IRREGULARES_10_A_19[resto - 10].into());
        } else {
            let dezena = resto / 10;
            let unidade = resto % 10;
            if unidade > 0 {
                partes.push(format!("{} e {}", DEZENAS[dezena], UNIDADES[unidade]));
            } else {
                partes.push(DEZENAS[dezena].into());
            }
        }
    }
}

/// Inteiro não negativo por extenso (até 999.999).
pub fn numero_por_extenso(n: u64) -> String {
    if n == 0 {
        return "zero".into();
    }
    if n < 1000 {
        let mut partes = Vec::new();
        ate_novecentos(n, &mut partes);
        return partes.join(" e ");
    }
    let milhares = n / 1000;
    let resto = n % 1000;
    let prefixo = if milhares == 1 {
        "mil".into()
    } else {
        let mut partes = Vec::new();
        ate_novecentos(milhares, &mut partes);
        format!("{} mil", partes.join(" e "))
    };
    if resto > 0 {
        let mut partes = Vec::new();
        ate_novecentos(resto, &mut partes);
        format!("{prefixo} e {}", partes.join(" e "))
    } else {
        prefixo
    }
}

/// Substitui números (inclusive decimais com , ou .) por extenso.
pub fn numeros_por_extenso(texto: &str) -> String {
    let caracteres: Vec<char> = texto.chars().collect();
    let mut resultado = String::with_capacity(texto.len());
    let mut indice = 0usize;

    while indice < caracteres.len() {
        if caracteres[indice].is_ascii_digit() {
            let inicio = indice;
            while indice < caracteres.len() && caracteres[indice].is_ascii_digit() {
                indice += 1;
            }
            let inteiro: u64 = caracteres[inicio..indice]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            resultado.push_str(&numero_por_extenso(inteiro));

            if indice + 1 < caracteres.len()
                && (caracteres[indice] == ',' || caracteres[indice] == '.')
                && caracteres[indice + 1].is_ascii_digit()
            {
                indice += 1;
                resultado.push_str(" vírgula");
                while indice < caracteres.len() && caracteres[indice].is_ascii_digit() {
                    let digito = caracteres[indice].to_digit(10).unwrap_or(0) as usize;
                    resultado.push(' ');
                    resultado.push_str(UNIDADES[digito]);
                    indice += 1;
                }
            }
            continue;
        }
        resultado.push(caracteres[indice]);
        indice += 1;
    }
    resultado
}

const LEMAS_IRREGULARES: &[(&str, &str)] = &[
    ("sou", "ser"),
    ("és", "ser"),
    ("é", "ser"),
    ("somos", "ser"),
    ("são", "ser"),
    ("era", "ser"),
    ("foi", "ser"),
    ("será", "ser"),
    ("estou", "estar"),
    ("está", "estar"),
    ("estamos", "estar"),
    ("estão", "estar"),
    ("estava", "estar"),
    ("esteve", "estar"),
    ("vou", "ir"),
    ("vai", "ir"),
    ("vamos", "ir"),
    ("vão", "ir"),
    ("fui", "ir"),
    ("venho", "vir"),
    ("vem", "vir"),
    ("vimos", "vir"),
    ("vêm", "vir"),
    ("vim", "vir"),
    ("faço", "fazer"),
    ("faz", "fazer"),
    ("fez", "fazer"),
    ("fizeram", "fazer"),
    ("farei", "fazer"),
    ("como", "comer"),
    ("come", "comer"),
    ("comeu", "comer"),
    ("comi", "comer"),
    ("bebo", "beber"),
    ("bebe", "beber"),
    ("bebeu", "beber"),
    ("durmo", "dormir"),
    ("dorme", "dormir"),
    ("dormiu", "dormir"),
    ("vejo", "ver"),
    ("vê", "ver"),
    ("viu", "ver"),
    ("vi", "ver"),
    ("ouço", "ouvir"),
    ("ouve", "ouvir"),
    ("ouviu", "ouvir"),
    ("quero", "querer"),
    ("quer", "querer"),
    ("quis", "querer"),
    ("quiseram", "querer"),
    ("tenho", "ter"),
    ("tem", "ter"),
    ("teve", "ter"),
    ("tiveram", "ter"),
    ("há", "haver"),
    ("houve", "haver"),
    ("dou", "dar"),
    ("dá", "dar"),
    ("deu", "dar"),
    ("dei", "dar"),
    ("trago", "trazer"),
    ("traz", "trazer"),
    ("trouxe", "trazer"),
    ("sei", "saber"),
    ("soube", "saber"),
    ("entendo", "entender"),
    ("entendeu", "entender"),
    ("leio", "ler"),
    ("lê", "ler"),
    ("leu", "ler"),
    ("li", "ler"),
    ("escrevo", "escrever"),
    ("escreveu", "escrever"),
    ("sinto", "sentir"),
    ("sente", "sentir"),
    ("sentiu", "sentir"),
    ("penso", "pensar"),
    ("pensou", "pensar"),
    ("peço", "pedir"),
    ("pede", "pedir"),
    ("pediu", "pedir"),
    ("consigo", "conseguir"),
    ("consegue", "conseguir"),
    ("conseguiu", "conseguir"),
    ("escolho", "escolher"),
    ("escolhe", "escolher"),
    ("escolheu", "escolher"),
    ("agradeço", "agradecer"),
    ("agradece", "agradecer"),
    ("agradeceu", "agradecer"),
    ("começo", "começar"),
    ("começa", "começar"),
    ("começou", "começar"),
    ("dirijo", "dirigir"),
    ("dirige", "dirigir"),
    ("dirigiu", "dirigir"),
    ("rio", "rir"),
    ("ri", "rir"),
    ("riu", "rir"),
    ("sorrio", "sorrir"),
    ("sorri", "sorrir"),
    ("sorriu", "sorrir"),
    ("cães", "cachorro"),
    ("cão", "cachorro"),
    ("cachorros", "cachorro"),
    ("cachorra", "cachorro"),
    ("homens", "homem"),
    ("mulheres", "mulher"),
    ("crianças", "criança"),
    ("bebês", "bebê"),
    ("pessoas", "pessoa"),
    ("irmãos", "irmão"),
    ("irmãs", "irmão"),
    ("filhos", "filho"),
    ("filhas", "filho"),
    ("mãos", "mão"),
    ("pés", "pé"),
    ("olhos", "olho"),
    ("dentes", "dente"),
    ("corações", "coração"),
    ("avós", "avó"),
    ("pães", "pão"),
    ("árvores", "árvore"),
    ("flores", "flor"),
    ("cidades", "cidade"),
    ("horas", "hora"),
    ("dias", "dia"),
    ("noites", "noite"),
    ("melhores", "melhor"),
    ("piores", "pior"),
    ("maiores", "maior"),
    ("menores", "menor"),
    ("rápidamente", "rapidamente"),
    ("provávelmente", "provavelmente"),
];

const REGRAS_LEMA: &[(&str, &str)] = &[
    ("amentos", "amento"),
    ("imentos", "imento"),
    ("ando", "ar"),
    ("endo", "er"),
    ("indo", "ir"),
    ("amos", "ar"),
    ("emos", "er"),
    ("imos", "ir"),
    ("aram", "ar"),
    ("eram", "er"),
    ("iram", "ir"),
    ("aremos", "ar"),
    ("eremos", "er"),
    ("iremos", "ir"),
    ("ões", "ão"),
    ("ães", "ão"),
    ("ais", "al"),
    ("eis", "el"),
    ("ois", "ol"),
    ("uis", "ul"),
    ("ãs", "ã"),
    ("ês", "ê"),
    ("as", "a"),
    ("es", "e"),
    ("is", "i"),
    ("os", "o"),
    ("us", "u"),
];

/// Lematizador determinístico: dicionário irregular + regras sufixais.
pub fn lematizar(palavra: &str) -> String {
    let minuscula = palavra.to_lowercase();
    if let Some((_, lema)) = LEMAS_IRREGULARES
        .iter()
        .find(|(forma, _)| *forma == minuscula)
    {
        return (*lema).into();
    }
    if minuscula.chars().count() <= 3 {
        return minuscula;
    }
    for (sufixo, substituto) in REGRAS_LEMA {
        if minuscula.ends_with(sufixo) {
            let candidato = format!(
                "{}{}",
                &minuscula[..minuscula.len() - sufixo.len()],
                substituto
            );
            if candidato.chars().count() >= 3 {
                return candidato;
            }
        }
    }
    minuscula
}

pub const INTENSIFICADORES: &[&str] = &[
    "muito",
    "mt",
    "mto",
    "bem",
    "super",
    "demais",
    "extremamente",
    "totalmente",
    "bastante",
    "tão",
    "tanto",
    "mega",
    "ultra",
    "intensamente",
];

const QU_WORDS: &[&str] = &[
    "onde", "quem", "quando", "como", "qual", "quais", "quanto", "quanta", "quantos", "quantas",
    "que", "cujo", "cuja", "porque",
];
const QU_STARTS: &[&[&str]] = &[
    &["onde"],
    &["quem"],
    &["quando"],
    &["como"],
    &["qual"],
    &["quais"],
    &["quanto"],
    &["quanta"],
    &["quantos"],
    &["quantas"],
    &["por", "que"],
    &["porque"],
    &["de", "quem"],
    &["para", "que"],
    &["que", "horas"],
];
const NEGACAO_WORDS: &[&str] = &[
    "nao",
    "nunca",
    "jamais",
    "nada",
    "ninguem",
    "nem",
    "de jeito nenhum",
];

fn eh_alphanumerico(caracter: char) -> bool {
    caracter.is_alphanumeric()
}

fn eh_separador_token(caracter: char) -> bool {
    caracter == '\'' || caracter == '’' || caracter == '-'
}

/// Extrai sequências de letras/números, aceitando apóstrofo e hífen internos.
fn extrair_tokens(texto: &str) -> Vec<(usize, String)> {
    let caracteres: Vec<(usize, char)> = texto.char_indices().collect();
    let mut tokens = Vec::new();
    let mut inicio: Option<usize> = None;
    let mut fim = 0usize;
    let mut indice_caracter = 0usize;

    while indice_caracter < caracteres.len() {
        let (indice, caracter) = caracteres[indice_caracter];
        if eh_alphanumerico(caracter) {
            if inicio.is_none() {
                inicio = Some(indice);
            }
            fim = indice + caracter.len_utf8();
        } else if eh_separador_token(caracter)
            && inicio.is_some()
            && indice_caracter + 1 < caracteres.len()
            && eh_alphanumerico(caracteres[indice_caracter + 1].1)
        {
            // apóstrofo/hífen só fazem parte do token se houver letra depois.
            fim = indice + caracter.len_utf8();
        } else if let Some(i) = inicio.take() {
            tokens.push((i, texto[i..fim].to_string()));
        }
        indice_caracter += 1;
    }
    if let Some(i) = inicio {
        tokens.push((i, texto[i..fim].to_string()));
    }
    tokens
}

fn contem_sequencia(palavras: &[String], sequencia: &[&str]) -> bool {
    if sequencia.is_empty() || palavras.len() < sequencia.len() {
        return false;
    }
    palavras.windows(sequencia.len()).any(|janela| {
        janela
            .iter()
            .zip(sequencia.iter())
            .all(|(palavra, esperada)| palavra == esperada)
    })
}

fn arredondar(valor: f32) -> f32 {
    (valor * 1000.0).round() / 1000.0
}

/// Normaliza o texto e produz tokens com lema e marcas de pergunta/negação/intensidade.
pub fn normalizar(texto_original: &str) -> TextoNormalizado {
    let sem_quebras: String = texto_original
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let minusculas = sem_quebras.to_lowercase();
    let expandido = expandir_abreviacoes(&minusculas);
    let com_numeros = numeros_por_extenso(&expandido);

    let texto_normalizado = com_numeros
        .chars()
        .map(|caracter| {
            if caracter.is_alphanumeric()
                || caracter.is_whitespace()
                || eh_separador_token(caracter)
            {
                caracter
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let tokens_brutos = extrair_tokens(&com_numeros);
    let mut tokens = Vec::with_capacity(tokens_brutos.len());
    let mut fim_anterior = 0usize;
    for (indice, original) in &tokens_brutos {
        let pausa_antes = com_numeros[fim_anterior..*indice]
            .chars()
            .any(|caracter| matches!(caracter, ',' | ';' | ':' | '—'));
        let lemma = lematizar(original);
        tokens.push(TokenNormalizado {
            original: original.clone(),
            texto: original.clone(),
            lemma,
            indice: *indice,
            pausa_antes,
        });
        fim_anterior = indice + original.len();
    }

    let palavras: Vec<String> = extrair_tokens(&texto_normalizado)
        .into_iter()
        .map(|(_, palavra)| remover_acentos(&palavra).to_lowercase())
        .collect();

    let tem_interrogacao = texto_original.contains('?');
    let tem_qu = palavras
        .iter()
        .any(|palavra| QU_WORDS.contains(&palavra.as_str()))
        || contem_sequencia(&palavras, &["que", "horas"])
        || contem_sequencia(&palavras, &["de", "quem"])
        || contem_sequencia(&palavras, &["para", "que"]);
    let qu_no_inicio = QU_STARTS
        .iter()
        .any(|sequencia| contem_sequencia(&palavras, sequencia));
    let eh_qu = tem_qu && (tem_interrogacao || qu_no_inicio);
    let eh_pergunta = tem_interrogacao || eh_qu;
    let tipo_pergunta = if eh_qu {
        Some(TipoPergunta::Qu)
    } else if eh_pergunta {
        Some(TipoPergunta::SimNao)
    } else {
        None
    };
    let tem_negacao = palavras
        .iter()
        .any(|palavra| NEGACAO_WORDS.contains(&palavra.as_str()))
        || contem_sequencia(&palavras, &["de", "jeito", "nenhum"]);

    let quantos_intensificadores: usize = INTENSIFICADORES
        .iter()
        .map(|intensificador| {
            let chave = remover_acentos(intensificador).to_lowercase();
            palavras.iter().filter(|palavra| **palavra == chave).count()
        })
        .sum();
    let exclames = texto_original
        .chars()
        .filter(|caracter| *caracter == '!')
        .count();
    let mut intensidade = 0.0f32;
    if quantos_intensificadores > 0 {
        intensidade += 0.5 + (0.12 * (quantos_intensificadores.saturating_sub(1)) as f32).min(0.25);
    }
    if exclames > 0 {
        intensidade += (0.15 * exclames as f32).min(0.3);
    }

    TextoNormalizado {
        texto_original: texto_original.to_string(),
        texto_normalizado,
        tokens,
        eh_pergunta,
        tipo_pergunta,
        tem_negacao,
        intensidade: arredondar(intensidade.min(1.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_acentos() {
        assert_eq!(
            remover_acentos("Amanhã, coração, ação"),
            "Amanha, coracao, acao"
        );
    }

    #[test]
    fn expande_abreviacoes() {
        assert_eq!(
            expandir_abreviacoes("vc obg tm pq"),
            "você obrigado também por que"
        );
        assert_eq!(
            expandir_abreviacoes("vc n foi pra escola"),
            "você não foi para escola"
        );
    }

    #[test]
    fn numeros_por_extenso_cobrem_inteiros_e_decimais() {
        assert_eq!(numero_por_extenso(0), "zero");
        assert_eq!(numero_por_extenso(11), "onze");
        assert_eq!(numero_por_extenso(21), "vinte e um");
        assert_eq!(numero_por_extenso(100), "cem");
        assert_eq!(numero_por_extenso(101), "cento e um");
        assert_eq!(numero_por_extenso(2026), "dois mil e vinte e seis");
        assert_eq!(
            numeros_por_extenso("tenho 2 livros e 1,5 café"),
            "tenho dois livros e um vírgula cinco café"
        );
    }

    #[test]
    fn lematiza_irregulares_e_regulares() {
        assert_eq!(lematizar("cães"), "cachorro");
        assert_eq!(lematizar("vi"), "ver");
        assert_eq!(lematizar("falamos"), "falar");
        assert_eq!(lematizar("cantando"), "cantar");
        assert_eq!(lematizar("meninas"), "menina");
        assert_eq!(lematizar("casas"), "casa");
    }
}
