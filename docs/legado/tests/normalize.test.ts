import { describe, expect, it } from "vitest";
import {
  expandirAbreviacoes,
  lematizar,
  normalizar,
  normalizarComSpaCy,
  numeroPorExtenso,
  numerosPorExtenso,
  removerAcentos,
} from "../src/nlp/normalize";

describe("normalizador pt-BR", () => {
  it("minúsculas, remove pontuação e tokeniza", () => {
    const r = normalizar("Olá, MUNDO! Tudo bem?");
    expect(r.textoNormalizado).toBe("olá mundo tudo bem");
    expect(r.tokens.map((t) => t.texto)).toEqual(["olá", "mundo", "tudo", "bem"]);
    expect(r.tokens[0].indice).toBe(0);
    expect(r.textoOriginal).toBe("Olá, MUNDO! Tudo bem?");
  });

  it("expande abreviações comuns", () => {
    expect(expandirAbreviacoes("vc obg tm pq")).toBe("você obrigado também por que");
    expect(normalizar("vc n foi pra escola").textoNormalizado).toBe("você não foi para escola");
  });

  it("converte números por extenso", () => {
    expect(numeroPorExtenso(0)).toBe("zero");
    expect(numeroPorExtenso(11)).toBe("onze");
    expect(numeroPorExtenso(21)).toBe("vinte e um");
    expect(numeroPorExtenso(100)).toBe("cem");
    expect(numeroPorExtenso(101)).toBe("cento e um");
    expect(numeroPorExtenso(2026)).toBe("dois mil e vinte e seis");
    expect(numerosPorExtenso("tenho 2 livros e 1,5 café")).toContain("dois livros e um vírgula cinco café");
    expect(normalizar("eu tenho 3 gatos").tokens.some((t) => t.texto === "três")).toBe(true);
  });

  it("lematiza formas irregulares e regulares", () => {
    expect(lematizar("cães")).toBe("cachorro");
    expect(lematizar("vi")).toBe("ver");
    expect(lematizar("falamos")).toBe("falar");
    expect(lematizar("cantando")).toBe("cantar");
    expect(lematizar("meninas")).toBe("menina");
    expect(lematizar("casas")).toBe("casa");
    expect(normalizar("eu vi cães").tokens.map((t) => t.lemma)).toEqual(["eu", "ver", "cachorro"]);
  });

  it("detecta pergunta SIM/NÃO e QU-", () => {
    expect(normalizar("Você está bem?").tipoPergunta).toBe("simnao");
    expect(normalizar("Onde você mora?").tipoPergunta).toBe("qu");
    expect(normalizar("Quem fez isso?").tipoPergunta).toBe("qu");
    expect(normalizar("Ele foi embora").tipoPergunta).toBeNull();
    expect(normalizar("pq você foi?").tipoPergunta).toBe("qu");
  });

  it("detecta negação e intensidade", () => {
    expect(normalizar("Eu não quero café").temNegacao).toBe(true);
    expect(normalizar("nunca mais").temNegacao).toBe(true);
    expect(normalizar("Eu quero café").temNegacao).toBe(false);
    expect(normalizar("muito obrigado!").intensidade).toBeGreaterThan(0.5);
    expect(normalizar("obrigado").intensidade).toBe(0);
  });

  it("remove acentos", () => {
    expect(removerAcentos("Amanhã, coração, ação")).toBe("Amanha, coracao, acao");
  });

  it("cai no fallback determinístico quando spaCy não está disponível", async () => {
    const r = await normalizarComSpaCy("eu vi cães", { python: "__python_inexistente_libraslive__" });
    expect(r.tokens.map((t) => t.lemma)).toEqual(["eu", "ver", "cachorro"]);
  });
});
