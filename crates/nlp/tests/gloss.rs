use std::collections::HashSet;

use libraslive_nlp::{
    lexicon_embedido, text_to_gloss, texto_para_gloss, Categoria, GlossResult, SignPose,
};

fn glossos(resultado: &GlossResult) -> Vec<&str> {
    resultado
        .tokens
        .iter()
        .map(|token| token.gloss.as_str())
        .collect()
}

fn pose_ids(resultado: &GlossResult) -> Vec<&str> {
    resultado
        .tokens
        .iter()
        .map(|token| token.pose_id.as_str())
        .collect()
}

fn ids_do_lexicon() -> HashSet<&'static str> {
    lexicon_embedido()
        .sinais
        .iter()
        .map(|sinal| sinal.id.as_str())
        .collect()
}

#[test]
fn ordena_sujeito_objeto_verbo_svo_visual() {
    let resultado = texto_para_gloss("Eu como maçã");
    assert_eq!(glossos(&resultado), ["EU", "MACA", "COMER"]);
    assert_eq!(resultado.texto_original, "Eu como maçã");
}

#[test]
fn adverbio_de_tempo_vem_primeiro() {
    assert_eq!(
        glossos(&texto_para_gloss("Amanhã eu vou para casa")),
        ["AMANHA", "EU", "CASA", "IR"]
    );
    assert_eq!(glossos(&texto_para_gloss("Hoje ele estuda"))[0], "HOJE");
}

#[test]
fn condicao_vem_antes_da_oracao_principal() {
    let resultado = texto_para_gloss("Se você vem amanhã, eu fico");
    let glossos = glossos(&resultado);
    let indice_voce = glossos.iter().position(|gloss| *gloss == "VOCE").unwrap();
    let indice_eu = glossos.iter().position(|gloss| *gloss == "EU").unwrap();
    assert!(indice_eu > indice_voce);
    assert_eq!(*glossos.last().unwrap(), "FICAR");
}

#[test]
fn negacao_no_fim_com_cabeca_balancando() {
    let resultado = texto_para_gloss("Eu não quero café");
    assert_eq!(glossos(&resultado), ["EU", "CAFE", "QUERER", "NAO"]);
    assert_eq!(
        resultado.expressao.cabeca,
        libraslive_nlp::Cabeca::Balancando
    );
    assert_eq!(resultado.tokens.last().unwrap().pose_id, "nao");
}

#[test]
fn pergunta_sim_nao_com_sobrancelha_erguida_e_cabeca_inclinada() {
    let resultado = texto_para_gloss("Você está bem?");
    assert_eq!(
        resultado.expressao.sobrancelha,
        libraslive_nlp::Sobrancelha::Erguida
    );
    assert_eq!(
        resultado.expressao.cabeca,
        libraslive_nlp::Cabeca::Inclinada
    );
    assert_eq!(resultado.tokens.last().unwrap().pose_id, "pergunta-simnao");
    assert_eq!(glossos(&resultado), ["VOCE", "ESTAR", "PERGUNTA SIM NAO"]);
}

#[test]
fn pergunta_qu_com_sobrancelha_franzida_e_sinal_no_fim() {
    let resultado = texto_para_gloss("Onde você mora?");
    assert_eq!(
        resultado.expressao.sobrancelha,
        libraslive_nlp::Sobrancelha::Franzida
    );
    assert_eq!(glossos(&resultado), ["VOCE", "MORAR", "ONDE"]);

    let quem = texto_para_gloss("Quem fez isso?");
    assert_eq!(
        quem.expressao.sobrancelha,
        libraslive_nlp::Sobrancelha::Franzida
    );
    assert_eq!(quem.tokens.last().unwrap().gloss, "QUEM");
}

#[test]
fn intensidade_reforca_expressao_e_amplitude() {
    let reforcado = texto_para_gloss("Muito obrigado!");
    assert_eq!(glossos(&reforcado), ["OBRIGADO"]);
    assert!(reforcado.expressao.intensidade > 0.5);
    assert!(reforcado.tokens[0].intensidade > 0.1);

    let neutro = texto_para_gloss("obrigado");
    assert!(neutro.expressao.intensidade < reforcado.expressao.intensidade);
}

#[test]
fn classificador_de_mao_em_objetos() {
    let ids = ids_do_lexicon();
    let cachorro = texto_para_gloss("Eu vi cachorro");
    let sinal = cachorro
        .tokens
        .iter()
        .find(|token| token.pose_id == "cachorro")
        .unwrap();
    assert_eq!(sinal.classificador.as_deref(), Some("garra"));
    assert!(ids.contains(sinal.classificador.as_deref().unwrap()));

    let livro = texto_para_gloss("Eu li livro");
    assert_eq!(
        livro
            .tokens
            .iter()
            .find(|token| token.pose_id == "livro")
            .unwrap()
            .classificador
            .as_deref(),
        Some("mao-plana")
    );
}

#[test]
fn palavra_desconhecida_usa_datilologia_dedo_letra() {
    let resultado = texto_para_gloss("Eu gosto de whisky");
    let dedos: Vec<&str> = resultado
        .tokens
        .iter()
        .filter(|token| token.tipo == libraslive_nlp::TokenTipo::Dedo)
        .map(|token| token.pose_id.as_str())
        .collect();
    assert_eq!(
        dedos,
        ["dedo-w", "dedo-h", "dedo-i", "dedo-s", "dedo-k", "dedo-y"]
    );
    let ids = ids_do_lexicon();
    assert!(dedos.iter().all(|id| ids.contains(id)));
    assert!(pose_ids(&resultado).iter().all(|id| ids.contains(id)));
}

#[test]
fn nunca_inventa_sinal() {
    let resultado = texto_para_gloss("favicon");
    assert!(!resultado.tokens.is_empty());
    assert!(resultado
        .tokens
        .iter()
        .all(|token| token.pose_id.starts_with("dedo-")));
    assert!(resultado.tokens.iter().all(|token| lexicon_embedido()
        .sinais
        .iter()
        .any(|s| s.id == token.pose_id)));
}

#[test]
fn contrato_6_2_e_respeitado_na_seriacao() {
    let resultado = texto_para_gloss("Amanhã eu não compro carro");
    let json = serde_json::to_value(&resultado).unwrap();
    let mut chaves: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    chaves.sort_unstable();
    assert_eq!(
        chaves,
        ["duracao_total_ms", "expressao", "textoOriginal", "tokens"]
    );
    let mut chaves_expressao: Vec<&str> = json["expressao"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    chaves_expressao.sort_unstable();
    assert_eq!(chaves_expressao, ["cabeca", "intensidade", "sobrancelha"]);

    for token in &resultado.tokens {
        let token_json = serde_json::to_value(token).unwrap();
        let mut chaves_token: Vec<&str> = token_json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        chaves_token.sort_unstable();
        assert_eq!(
            chaves_token,
            [
                "classificador",
                "gloss",
                "intensidade",
                "palavraOriginal",
                "poseId",
                "tipo"
            ]
        );
        assert!((0.0..=1.0).contains(&token.intensidade));
    }
    assert!(resultado.duracao_total_ms > 0);
}

#[test]
fn todo_pose_id_gerado_existe_no_lexicon() {
    let ids = ids_do_lexicon();
    for frase in [
        "Olá, tudo bem?",
        "Eu gosto de café e pão",
        "Onde você trabalha?",
        "Nunca vou à praia amanhã",
        "Ele comprou três livros muito caros",
        "Se chover, eu fico em casa",
        "Quem é a médica?",
        "Eu não entendi essa palavra esquisita",
        "Você pode me ajudar com isso?",
        "Por que você foi embora?",
    ] {
        for id in pose_ids(&texto_para_gloss(frase)) {
            assert!(
                ids.contains(id),
                "poseId ausente no lexicon: {id} (frase: {frase})"
            );
        }
    }
}

#[test]
fn lexicon_tem_ids_unicos_26_dedos_e_poses_validas() {
    let sinais = &lexicon_embedido().sinais;
    let ids: HashSet<&str> = sinais.iter().map(|sinal| sinal.id.as_str()).collect();
    assert!(sinais.len() >= 300);
    assert_eq!(ids.len(), sinais.len());

    for letra in 'a'..='z' {
        assert!(ids.contains(format!("dedo-{letra}").as_str()));
    }

    let ossos = [
        "Hips",
        "Spine",
        "Chest",
        "Neck",
        "Head",
        "LeftArm",
        "LeftForeArm",
        "LeftHand",
        "RightArm",
        "RightForeArm",
        "RightHand",
    ];
    for sinal in sinais {
        assert_eq!(sinal.gloss, sinal.gloss.to_uppercase(), "{}", sinal.id);
        assert!(!sinal.palavras.is_empty(), "{}", sinal.id);
        assert!((250..=2000).contains(&sinal.duracao_ms), "{}", sinal.id);
        for osso in ossos {
            let quaternion = sinal
                .bones
                .get(osso)
                .unwrap_or_else(|| panic!("{}.{osso}", sinal.id));
            let norma = quaternion
                .iter()
                .map(|valor| valor * valor)
                .sum::<f32>()
                .sqrt();
            assert!((norma - 1.0).abs() < 0.01, "{}.{osso}", sinal.id);
        }
        for (chave, valor) in &sinal.blendshapes {
            assert!((0.0..=1.0).contains(valor), "{}.{chave}", sinal.id);
        }
    }
}

#[test]
fn api_publica_aceita_lexicon_externo_do_backend() {
    let sinais: Vec<SignPose> = vec![libraslive_nlp::SignPose {
        id: "ola".into(),
        gloss: "OLA".into(),
        palavras: vec!["olá".into(), "ola".into()],
        categoria: Categoria::Frase,
        duracao_ms: 500,
        bones: Default::default(),
        blendshapes: Default::default(),
        classificador: None,
        notas: None,
    }];
    let resultado = text_to_gloss("olá", &sinais);
    assert_eq!(resultado.tokens[0].pose_id, "ola");
    assert_eq!(resultado.tokens[0].tipo, libraslive_nlp::TokenTipo::Frase);
    assert_eq!(resultado.duracao_total_ms, 500);

    let conversor = libraslive_nlp::LexiconConverter;
    assert_eq!(conversor.name(), "libraslive-nlp-rust-0.1");
    assert_eq!(conversor.to_gloss("olá", &sinais), resultado);
}

#[test]
fn entrada_vazia_nao_quebra() {
    let resultado = texto_para_gloss("");
    assert!(resultado.tokens.is_empty());
    assert_eq!(resultado.duracao_total_ms, 0);
    assert_eq!(
        resultado.expressao.sobrancelha,
        libraslive_nlp::Sobrancelha::Neutra
    );
}
