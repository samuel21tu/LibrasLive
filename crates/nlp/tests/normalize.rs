use libraslive_nlp::{
    expandir_abreviacoes, lematizar, normalizar, numero_por_extenso, numeros_por_extenso,
    remover_acentos, TipoPergunta,
};

#[test]
fn minusculas_pontuacao_e_tokenizacao() {
    let resultado = normalizar("Olá, MUNDO! Tudo bem?");
    assert_eq!(resultado.texto_normalizado, "olá mundo tudo bem");
    let textos: Vec<&str> = resultado
        .tokens
        .iter()
        .map(|token| token.texto.as_str())
        .collect();
    assert_eq!(textos, ["olá", "mundo", "tudo", "bem"]);
    assert_eq!(resultado.tokens[0].indice, 0);
    assert!(resultado.tokens[1].pausa_antes);
    assert_eq!(resultado.texto_original, "Olá, MUNDO! Tudo bem?");
}

#[test]
fn expande_abreviacoes_comuns() {
    assert_eq!(
        expandir_abreviacoes("vc obg tm pq"),
        "você obrigado também por que"
    );
    assert_eq!(
        normalizar("vc n foi pra escola").texto_normalizado,
        "você não foi para escola"
    );
}

#[test]
fn numeros_inteiros_e_decimais_por_extenso() {
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
    assert!(normalizar("eu tenho 3 gatos")
        .tokens
        .iter()
        .any(|token| token.texto == "três"));
}

#[test]
fn lematiza_formas_irregulares_e_regulares() {
    assert_eq!(lematizar("cães"), "cachorro");
    assert_eq!(lematizar("vi"), "ver");
    assert_eq!(lematizar("falamos"), "falar");
    assert_eq!(lematizar("cantando"), "cantar");
    assert_eq!(lematizar("meninas"), "menina");
    assert_eq!(lematizar("casas"), "casa");
    let normalizado = normalizar("eu vi cães");
    let lemas: Vec<&str> = normalizado
        .tokens
        .iter()
        .map(|token| token.lemma.as_str())
        .collect();
    assert_eq!(lemas, ["eu", "ver", "cachorro"]);
}

#[test]
fn detecta_pergunta_sim_nao_e_qu() {
    assert_eq!(
        normalizar("Você está bem?").tipo_pergunta,
        Some(TipoPergunta::SimNao)
    );
    assert_eq!(
        normalizar("Onde você mora?").tipo_pergunta,
        Some(TipoPergunta::Qu)
    );
    assert_eq!(
        normalizar("Quem fez isso?").tipo_pergunta,
        Some(TipoPergunta::Qu)
    );
    assert_eq!(normalizar("Ele foi embora").tipo_pergunta, None);
    assert_eq!(
        normalizar("pq você foi?").tipo_pergunta,
        Some(TipoPergunta::Qu)
    );
}

#[test]
fn detecta_negacao_e_intensidade() {
    assert!(normalizar("Eu não quero café").tem_negacao);
    assert!(normalizar("nunca mais").tem_negacao);
    assert!(!normalizar("Eu quero café").tem_negacao);
    assert!(normalizar("muito obrigado!").intensidade > 0.5);
    assert_eq!(normalizar("obrigado").intensidade, 0.0);
}

#[test]
fn remove_acentos_de_pt_br() {
    assert_eq!(
        remover_acentos("Amanhã, coração, ação"),
        "Amanha, coracao, acao"
    );
}

#[test]
fn normalizador_e_deterministico() {
    let primeira = normalizar("Olá, MUNDO! Tudo bem?");
    let segunda = normalizar("Olá, MUNDO! Tudo bem?");
    assert_eq!(primeira, segunda);
    assert_eq!(primeira.expressao().0, libraslive_nlp::Sobrancelha::Erguida);
}
