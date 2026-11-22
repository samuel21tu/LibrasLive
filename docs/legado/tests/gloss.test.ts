import { describe, expect, it } from "vitest";
import lexicon from "../src/lexicon/libras.json";
import { textoParaGloss } from "../src/nlp/gloss";
import type { GlossResult, SignPose } from "../src/nlp/contracts";

const SINAIS = lexicon.sinais as unknown as SignPose[];
const IDS = new Set(SINAIS.map((sinal) => sinal.id));

const glossos = (resultado: GlossResult) => resultado.tokens.map((token) => token.gloss);
const poseIds = (resultado: GlossResult) => resultado.tokens.map((token) => token.poseId);

describe("conversor texto → gloss LIBRAS", () => {
  it("ordena sujeito → objeto → verbo (SVO visual)", () => {
    const r = textoParaGloss("Eu como maçã");
    expect(glossos(r)).toEqual(["EU", "MACA", "COMER"]);
    expect(r.textoOriginal).toBe("Eu como maçã");
  });

  it("coloca advérbio de tempo no início", () => {
    expect(glossos(textoParaGloss("Amanhã eu vou para casa"))).toEqual([
      "AMANHA", "EU", "CASA", "IR",
    ]);
    expect(glossos(textoParaGloss("Hoje ele estuda"))[0]).toBe("HOJE");
  });

  it("coloca a condição antes do sujeito da oração principal", () => {
    const r = textoParaGloss("Se você vem amanhã, eu fico");
    const indiceVoce = glossos(r).indexOf("VOCE");
    const indiceEu = glossos(r).indexOf("EU");
    expect(indiceVoce).toBeGreaterThanOrEqual(0);
    expect(indiceEu).toBeGreaterThan(indiceVoce);
    expect(glossos(r).slice(-1)).toEqual(["FICAR"]);
  });

  it("coloca a negação no fim e balança a cabeça", () => {
    const r = textoParaGloss("Eu não quero café");
    expect(glossos(r)).toEqual(["EU", "CAFE", "QUERER", "NAO"]);
    expect(r.expressao.cabeca).toBe("balancando");
    expect(r.tokens.at(-1)?.poseId).toBe("nao");
  });

  it("marca pergunta SIM/NÃO com sobrancelha erguida e cabeça inclinada", () => {
    const r = textoParaGloss("Você está bem?");
    expect(r.expressao.sobrancelha).toBe("erguida");
    expect(r.expressao.cabeca).toBe("inclinada");
    expect(r.tokens.at(-1)?.poseId).toBe("pergunta-simnao");
    expect(glossos(r)).toEqual(["VOCE", "ESTAR", "PERGUNTA SIM NAO"]);
  });

  it("marca pergunta QU- com sobrancelha franzida e sinal no fim", () => {
    const r = textoParaGloss("Onde você mora?");
    expect(r.expressao.sobrancelha).toBe("franzida");
    expect(r.tokens.at(-1)?.gloss).toBe("ONDE");
    expect(glossos(r)).toEqual(["VOCE", "MORAR", "ONDE"]);

    const quem = textoParaGloss("Quem fez isso?");
    expect(quem.expressao.sobrancelha).toBe("franzida");
    expect(quem.tokens.at(-1)?.gloss).toBe("QUEM");
  });

  it("reforça expressão e amplitude em caso de intensidade", () => {
    const r = textoParaGloss("Muito obrigado!");
    expect(glossos(r)).toEqual(["OBRIGADO"]);
    expect(r.expressao.intensidade).toBeGreaterThan(0.5);
    expect(r.tokens[0].intensidade).toBeGreaterThan(0.1);

    const neutro = textoParaGloss("obrigado");
    expect(neutro.expressao.intensidade).toBeLessThan(r.expressao.intensidade);
  });

  it("atribui classificador de mão a objetos", () => {
    const r = textoParaGloss("Eu vi cachorro");
    const cachorro = r.tokens.find((token) => token.poseId === "cachorro");
    expect(cachorro?.classificador).toBe("garra");
    expect(IDS.has(cachorro!.classificador!)).toBe(true);

    const livro = textoParaGloss("Eu li livro");
    expect(livro.tokens.find((t) => t.poseId === "livro")?.classificador).toBe("mao-plana");
  });

  it("usa datilologia dedo-<letra> para palavras desconhecidas", () => {
    const r = textoParaGloss("Eu gosto de whisky");
    const dedos = r.tokens.filter((token) => token.tipo === "dedo");
    expect(dedos.map((token) => token.poseId)).toEqual([
      "dedo-w", "dedo-h", "dedo-i", "dedo-s", "dedo-k", "dedo-y",
    ]);
    expect(dedos.every((token) => IDS.has(token.poseId))).toBe(true);
    expect(r.tokens.every((token) => IDS.has(token.poseId))).toBe(true);
  });

  it("nunca inventa sinal: desconhecida gera apenas datilologia", () => {
    const r = textoParaGloss("favicon");
    expect(r.tokens.length).toBeGreaterThan(0);
    expect(r.tokens.every((token) => token.poseId.startsWith("dedo-"))).toBe(true);
    expect(r.tokens.every((token) => r.tokens.some((t) => t.gloss === token.gloss))).toBe(true);
  });

  it("respeita o contrato GlossResult", () => {
    const r = textoParaGloss("Amanhã eu não compro carro");
    expect(Object.keys(r).sort()).toEqual([
      "duracao_total_ms", "expressao", "textoOriginal", "tokens",
    ]);
    expect(Object.keys(r.expressao).sort()).toEqual(["cabeca", "intensidade", "sobrancelha"]);
    for (const token of r.tokens) {
      expect(Object.keys(token).sort()).toEqual([
        "classificador", "gloss", "intensidade", "palavraOriginal", "poseId", "tipo",
      ]);
      expect(token.intensidade).toBeGreaterThanOrEqual(0);
      expect(token.intensidade).toBeLessThanOrEqual(1);
    }
    expect(r.duracao_total_ms).toBeGreaterThan(0);
  });

  it("todo poseId gerado existe no lexicon", () => {
    const frases = [
      "Olá, tudo bem?",
      "Eu gosto de café e pão",
      "Onde você trabalha?",
      "Nunca vou à praia amanhã",
      "Ele comprou três livros muito caros",
      "Se chover, eu fico em casa",
      "Quem é a médica?",
      "Eu não entendi essa palavra esquisita",
    ];
    for (const frase of frases) {
      for (const id of poseIds(textoParaGloss(frase))) {
        expect(IDS.has(id), `poseId ausente no lexicon: ${id} (frase: ${frase})`).toBe(true);
      }
    }
  });

  it("entrada vazia não quebra", () => {
    const r = textoParaGloss("");
    expect(r.tokens).toEqual([]);
    expect(r.duracao_total_ms).toBe(0);
    expect(r.expressao.sobrancelha).toBe("neutra");
  });
});

describe("estrutura do lexicon (contrato SignPose § 6.1)", () => {
  it("tem no mínimo 300 sinais com ids únicos", () => {
    expect(SINAIS.length).toBeGreaterThanOrEqual(300);
    expect(IDS.size).toBe(SINAIS.length);
  });

  it("inclui as 26 letras para datilologia", () => {
    for (const letra of "abcdefghijklmnopqrstuvwxyz") {
      expect(IDS.has(`dedo-${letra}`)).toBe(true);
    }
  });

  it("cada sinal tem bones normalizados, blendshapes 0..1 e duração válida", () => {
    const ossos = [
      "Hips", "Spine", "Chest", "Neck", "Head",
      "LeftArm", "LeftForeArm", "LeftHand",
      "RightArm", "RightForeArm", "RightHand",
    ];
    for (const sinal of SINAIS) {
      expect(sinal.gloss, sinal.id).toBe(sinal.gloss.toUpperCase());
      expect(sinal.palavras.length, sinal.id).toBeGreaterThan(0);
      expect(sinal.duracao_ms, sinal.id).toBeGreaterThanOrEqual(250);
      expect(sinal.duracao_ms, sinal.id).toBeLessThanOrEqual(2000);
      for (const osso of ossos) {
        const q = sinal.bones[osso];
        expect(Array.isArray(q), `${sinal.id}.${osso}`).toBe(true);
        expect(q!, `${sinal.id}.${osso}`).toHaveLength(4);
        expect(Math.abs(Math.hypot(...q!) - 1), `${sinal.id}.${osso} quaternão não normalizado`).toBeLessThan(0.01);
      }
      for (const [chave, valor] of Object.entries(sinal.blendshapes)) {
        expect(valor, `${sinal.id}.${chave}`).toBeGreaterThanOrEqual(0);
        expect(valor, `${sinal.id}.${chave}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("poses são distintas o bastante para a demo visual", () => {
    const assinaturas = new Set(
      SINAIS.map((sinal) => JSON.stringify([sinal.bones.RightArm, sinal.blendshapes])),
    );
    expect(assinaturas.size).toBeGreaterThan(SINAIS.length * 0.9);
  });
});
