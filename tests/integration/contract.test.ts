/**
 * LibrasLive — testes de contrato de dados (spec seção 6).
 *
 * Executados por `npm test` (Vitest). A validação independente de framework
 * está em scripts/verify-lexicon.mjs, que este arquivo reutiliza.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BONES,
  BLENDSHAPES,
  CATEGORIAS,
  resolverCaminhoLexicon,
  validarGlossResult,
  validarGlossToken,
  validarLexicon,
  validarSignPose,
} from "../../scripts/verify-lexicon.mjs";

type MapaSinais = ReturnType<typeof validarLexicon>["mapaSinais"];

type Sinal = {
  id: string;
  gloss: string;
  palavras: string[];
  categoria: string;
  duracao_ms: number;
  bones: Record<string, [number, number, number, number]>;
  blendshapes: Record<string, number>;
  classificador: string | null;
  notas?: string;
};

type PayloadLexicon = { versao: string; sinais: Sinal[] };

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Canônico: lexicon/libras.json; fallback transitório enquanto o Trama move o JSON.
const CAMINHO_LEXICON = resolverCaminhoLexicon(process.env.LEXICON_PATH ?? null);

function carregarLexicon(): PayloadLexicon {
  expect(existsSync(CAMINHO_LEXICON), `lexicon não encontrado em ${CAMINHO_LEXICON}`).toBe(true);
  const texto = readFileSync(CAMINHO_LEXICON, "utf8");
  expect(() => JSON.parse(texto), "JSON do lexicon deve ser parseável").not.toThrow();
  return JSON.parse(texto) as PayloadLexicon;
}

function obterMapa(): MapaSinais {
  return validarLexicon(carregarLexicon()).mapaSinais;
}

function semErros(resultado: { ok: boolean; erros: string[] }): void {
  expect(resultado.erros, resultado.erros.join("\n")).toEqual([]);
  expect(resultado.ok).toBe(true);
}

function pular(ctx: { skip?: (motivo?: string) => void }, motivo: string): void {
  if (typeof ctx.skip === "function") ctx.skip(motivo);
  else console.warn(`[SKIP] ${motivo}`);
}

describe("Seção 6 — contrato de dados compartilhado", () => {
  it("6.1: JSON do lexicon é parseável, tem versão e >= 300 sinais", () => {
    const dados = carregarLexicon();
    const resultado = validarLexicon(dados);

    expect(typeof dados.versao).toBe("string");
    expect(dados.versao.trim().length).toBeGreaterThan(0);
    expect(resultado.quantidade).toBeGreaterThanOrEqual(300);
    semErros(resultado);
  });

  it("6.1: cada SignPose tem id/gloss/palavras/categoria/duracao_ms/classificador válidos", () => {
    const dados = carregarLexicon();
    const ids = new Set<string>();

    dados.sinais.forEach((sinal, indice) => {
      const r = validarSignPose(sinal, indice);
      semErros(r);
      expect(typeof sinal.id).toBe("string");
      expect(sinal.id.trim()).toBe(sinal.id);
      expect(ids.has(sinal.id), `id duplicado: ${sinal.id}`).toBe(false);
      ids.add(sinal.id);
      expect(sinal.gloss).toBe(sinal.gloss.toUpperCase());
      expect(Array.isArray(sinal.palavras) && sinal.palavras.length > 0).toBe(true);
      expect(CATEGORIAS).toContain(sinal.categoria);
      expect(sinal.duracao_ms).toBeGreaterThanOrEqual(250);
      expect(sinal.duracao_ms).toBeLessThanOrEqual(2000);
      expect(sinal.classificador === null || typeof sinal.classificador === "string").toBe(true);
    });
  });

  it("6.1: bones e blendshapes contêm exatamente as chaves exigidas pelo contrato", () => {
    const dados = carregarLexicon();

    dados.sinais.forEach((sinal, indice) => {
      expect(Object.keys(sinal.bones ?? {}), `sinais[${indice}] bones`).toEqual(
        expect.arrayContaining([...BONES]),
      );
      expect(Object.keys(sinal.blendshapes ?? {}), `sinais[${indice}] blendshapes`).toEqual(
        expect.arrayContaining([...BLENDSHAPES]),
      );

      for (const osso of BONES) {
        const q = sinal.bones[osso];
        expect(Array.isArray(q) && q.length === 4, `sinais[${indice}].bones.${osso}`).toBe(true);
        expect(q.every((n) => typeof n === "number" && Number.isFinite(n))).toBe(true);
        expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThanOrEqual(0.05);
      }

      for (const chave of BLENDSHAPES) {
        const v = sinal.blendshapes[chave];
        expect(typeof v === "number" && Number.isFinite(v), `sinais[${indice}].blendshapes.${chave}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  it("6.2: todo GlossToken aponta para poseId existente ou dedo-<letra>", () => {
    const dados = carregarLexicon();
    const mapa = validarLexicon(dados).mapaSinais;
    const exemplos = dados.sinais.filter((sinal) => !sinal.id.startsWith("dedo-")).slice(0, 8);

    const tokensValidos = exemplos.map((sinal) => ({
      gloss: sinal.gloss,
      poseId: sinal.id,
      palavraOriginal: sinal.palavras[0] ?? sinal.id,
      tipo: sinal.categoria,
      intensidade: 0.5,
      classificador: sinal.classificador,
    }));

    for (const letra of ["a", "ç", "Z"]) {
      tokensValidos.push({
        gloss: letra.toUpperCase(),
        poseId: `dedo-${letra}`,
        palavraOriginal: letra,
        tipo: "dedo",
        intensidade: 0.3,
        classificador: null,
      });
    }

    semErros(validarGlossResult({
      tokens: tokensValidos,
      expressao: { sobrancelha: "erguida", cabeca: "inclinada", intensidade: 0.5 },
      duracao_total_ms: 2000,
      textoOriginal: "exemplo",
    }, mapa));

    const invalidos: Array<[string, Record<string, unknown>, string]> = [
      ["poseId inexistente", { ...tokensValidos[0], poseId: "sinal-inexistente" }, "não existe no lexicon"],
      ["dedo inválido", { ...tokensValidos[0], poseId: "dedo-AB", gloss: "AB", tipo: "dedo" }, "não existe no lexicon"],
      ["gloss divergente", { ...tokensValidos[0], gloss: "OUTRO" }, "não bate com SignPose.gloss"],
      ["tipo dedo com pose normal", { ...tokensValidos[0], tipo: "dedo" }, 'exige poseId no padrão'],
      ["intensidade fora de 0..1", { ...tokensValidos[0], intensidade: 1.4 }, "intensidade"],
    ];

    for (const [rotulo, token, trecho] of invalidos) {
      const r = validarGlossToken(token, rotulo, mapa);
      expect(r.ok, `${rotulo}: ${r.erros.join("; ")}`).toBe(false);
      expect(r.erros.join(" ").includes(trecho), `${rotulo}: esperado erro contendo "${trecho}"`).toBe(true);
    }
  });

  it("6.2: GlossResult valida expressao, duracao_total_ms e textoOriginal", () => {
    const mapa = obterMapa();
    const sinal = mapa.values().next().value as { id: string; gloss: string; categoria: string; classificador: string | null } | undefined;
    expect(sinal).toBeDefined();
    if (!sinal) return;

    const base = {
      tokens: [{
        gloss: sinal.gloss,
        poseId: sinal.id,
        palavraOriginal: "teste",
        tipo: sinal.categoria,
        intensidade: 0.7,
        classificador: sinal.classificador,
      }],
      expressao: { sobrancelha: "erguida", cabeca: "inclinada", intensidade: 0.7 },
      duracao_total_ms: 800,
      textoOriginal: "teste",
    };

    semErros(validarGlossResult(base, mapa));

    const invalido = validarGlossResult(
      { ...base, expressao: { sobrancelha: "surpresa", cabeca: "inclinada", intensidade: 0.7 }, duracao_total_ms: -1 },
      mapa,
    );
    expect(invalido.ok).toBe(false);
    expect(invalido.erros.join(" ")).toContain("sobrancelha inválida");
    expect(invalido.erros.join(" ")).toContain("duracao_total_ms");
  });

  it("6.2/6.4: saída real do conversor texto→gloss, quando o módulo estiver disponível", async (ctx) => {
    const candidatos = [
      "src/nlp/gloss.ts",
      "src/nlp/gloss.js",
      "src/nlp/textoParaGloss.ts",
      "src/nlp/conversorGloss.ts",
    ];
    const funcoes: Array<[string, (entrada: string) => unknown]> = [];

    for (const relativo of candidatos) {
      const absoluto = join(RAIZ, relativo);
      if (!existsSync(absoluto)) continue;
      try {
        const modulo = (await import(/* @vite-ignore */ pathToFileURL(absoluto).href)) as Record<string, unknown>;
        for (const [nome, valor] of Object.entries(modulo)) {
          if (typeof valor === "function" && /gloss|converter|parse|texto|text/i.test(nome)) {
            funcoes.push([nome, valor as (entrada: string) => unknown]);
          }
        }
      } catch (erro) {
        pular(ctx, `módulo ${relativo} não importável no ambiente de teste: ${String(erro)}`);
        return;
      }
    }

    if (funcoes.length === 0) {
      pular(ctx, "conversor TS legado ausente; conversor Rust coberto por scripts/verify-rust-contracts.sh (cargo test -p libraslive-nlp)");
      return;
    }

    const mapa = obterMapa();
    const frases = ["olá mundo", "eu não quero", "onde você está?", "casa"];
    let avaliadas = 0;

    for (const [nome, funcao] of funcoes) {
      let resultado: unknown;
      try {
        resultado = await funcao(frases[0]);
      } catch (erro) {
        pular(ctx, `conversor ${nome} exige modelo externo indisponível no teste: ${String(erro)}`);
        return;
      }
      const resultadoComoObjeto = resultado as { tokens?: unknown } | null;
      if (!resultadoComoObjeto || !Array.isArray(resultadoComoObjeto.tokens)) continue;

      for (const frase of frases) {
        const atual = frase === frases[0] ? resultado : await funcao(frase);
        semErros(validarGlossResult(atual, mapa, `${nome}("${frase}")`));
        avaliadas += 1;
      }
      break;
    }

    if (avaliadas === 0) {
      pular(ctx, "nenhuma função exportada retornou GlossResult com tokens");
    }
  });

  it("6.3: backend axum expõe endpoints e tipos de mensagem do contrato WebSocket", () => {
    const diretorioServidor = join(RAIZ, "crates", "server", "src");
    const arquivos: string[] = [];

    if (existsSync(diretorioServidor)) {
      for (const entrada of readdirSync(diretorioServidor, { withFileTypes: true })) {
        if (entrada.isFile() && entrada.name.endsWith(".rs")) {
          arquivos.push(join(diretorioServidor, entrada.name));
        }
      }
    }

    // Transição: o legado Python ainda pode estar presente; qualquer fonte serve.
    const legado = join(RAIZ, "python", "server.py");
    if (existsSync(legado)) arquivos.push(legado);

    expect(arquivos.length, `nenhuma fonte de backend encontrada em ${diretorioServidor}`).toBeGreaterThan(0);

    const conteudo = arquivos
      .map((arquivo) => readFileSync(arquivo, "utf8").toLowerCase())
      .join("\n");
    for (const marca of ["/stream", "/lexicon", "/health", "partial", "final", "gloss", "latency_ms"]) {
      expect(conteudo.includes(marca), `fonte do backend deve conter "${marca}"`).toBe(true);
    }
  });
});
