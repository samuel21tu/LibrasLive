#!/usr/bin/env node
/**
 * LibrasLive — validador determinístico do contrato de dados (spec seção 6).
 *
 * Uso:
 *   node scripts/verify-lexicon.mjs
 *   node scripts/verify-lexicon.mjs --lexicon caminho/para/libras.json
 *   node scripts/verify-lexicon.mjs --tokens saida-do-conversor.json
 *   node scripts/verify-lexicon.mjs --json
 *
 * Exit code: 0 = válido, 1 = inválido (ou arquivo ausente/ilegível).
 * Este arquivo também exporta as funções de validação para os testes de contrato.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Caminho canônico (spec: árvore Rust/Tauri). */
export const LEXICON_PATH = join(PROJECT_ROOT, "lexicon", "libras.json");
/** Caminho transitório enquanto o lexicon é movido pelo Trama. */
export const LEXICON_PATH_FALLBACK = join(PROJECT_ROOT, "src", "lexicon", "libras.json");

/**
 * Resolve o lexicon: argumento explícito > canônico > fallback legado.
 * Sem nenhum dos dois presentes, devolve o canônico para a mensagem de erro
 * apontar o destino final da migração.
 */
export function resolverCaminhoLexicon(caminhoExplicito = null) {
  if (caminhoExplicito) return resolve(caminhoExplicito);
  if (existsSync(LEXICON_PATH)) return LEXICON_PATH;
  if (existsSync(LEXICON_PATH_FALLBACK)) return LEXICON_PATH_FALLBACK;
  return LEXICON_PATH;
}

/** Seção 6.1 — categorias aceitas de SignPose. */
export const CATEGORIAS = Object.freeze([
  "substantivo",
  "verbo",
  "adjetivo",
  "advérbio",
  "frase",
  "pergunta",
  "negação",
  "classificador",
  "datilologia",
]);

/** Seção 6.1 — ossos obrigatórios (quaternion [x, y, z, w]). */
export const BONES = Object.freeze([
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
]);

/** Seção 6.1 — morph targets ARKit obrigatórios (valores 0..1). */
export const BLENDSHAPES = Object.freeze([
  "browInnerUp",
  "browOuterUp_L",
  "browOuterUp_R",
  "browDown_L",
  "browDown_R",
  "eyeBlink_L",
  "eyeBlink_R",
  "mouthSmile_L",
  "mouthSmile_R",
  "mouthFrown_L",
  "mouthFrown_R",
  "jawOpen",
  "cheekPuff",
  "noseSneer_L",
  "noseSneer_R",
]);

export const EXPRESSAO_SOBRANCELHA = Object.freeze(["neutra", "erguida", "franzida"]);
export const EXPRESSAO_CABECA = Object.freeze(["neutra", "inclinada", "balancando"]);

const RE_DURO = /^dedo-\p{L}$/u;
const RE_GLOSS = /^[\p{Lu}\p{N}\d\s\-_.?!,:;()]+$/u;
const TEM_MAIUSCULA = /\p{Lu}/u;

const ehObjeto = (valor) => valor !== null && typeof valor === "object" && !Array.isArray(valor);
const ehNumero = (valor) => typeof valor === "number" && Number.isFinite(valor);
const ehTexto = (valor) => typeof valor === "string" && valor.trim().length > 0;

function falha(colecao, contexto, mensagem) {
  colecao.push(`[${contexto}] ${mensagem}`);
}

function textoUppercase(valor) {
  return ehTexto(valor) && valor === valor.trim() && valor === valor.toUpperCase();
}

/**
 * Valida um item de `sinais` contra o SignPose da seção 6.1.
 * @returns {{ok: boolean, erros: string[], avisos: string[]}}
 */
export function validarSignPose(sinal, posicao = "sinal") {
  const erros = [];
  const avisos = [];
  const ctx = `sinais[${posicao}]`;

  if (!ehObjeto(sinal)) {
    falha(erros, ctx, "deve ser um objeto SignPose");
    return { ok: false, erros, avisos };
  }

  if (!ehTexto(sinal.id)) falha(erros, ctx, "id ausente ou vazio");
  else if (/\s/.test(sinal.id)) falha(erros, ctx, `id não pode conter espaços: ${JSON.stringify(sinal.id)}`);

  if (!textoUppercase(sinal.gloss)) {
    falha(erros, ctx, `gloss deve ser texto em MAIÚSCULAS sem espaços nas bordas: ${JSON.stringify(sinal.gloss)}`);
  } else if (!RE_GLOSS.test(sinal.gloss) || !TEM_MAIUSCULA.test(sinal.gloss)) {
    falha(erros, ctx, `gloss contém caracteres inválidos: ${JSON.stringify(sinal.gloss)}`);
  }

  if (!Array.isArray(sinal.palavras) || sinal.palavras.length === 0) {
    falha(erros, ctx, "palavras deve ser um array não vazio de strings");
  } else {
    sinal.palavras.forEach((palavra, i) => {
      if (!ehTexto(palavra)) falha(erros, ctx, `palavras[${i}] deve ser string não vazia`);
    });
  }

  if (!CATEGORIAS.includes(sinal.categoria)) {
    falha(erros, ctx, `categoria "${String(sinal.categoria)}" não está em ${CATEGORIAS.join(", ")}`);
  }

  if (!ehNumero(sinal.duracao_ms) || sinal.duracao_ms < 250 || sinal.duracao_ms > 2000) {
    falha(erros, ctx, `duracao_ms deve estar entre 250 e 2000 (recebido: ${JSON.stringify(sinal.duracao_ms)})`);
  } else if (!Number.isInteger(sinal.duracao_ms)) {
    falha(avisos, ctx, `duracao_ms não é inteiro: ${sinal.duracao_ms}`);
  }

  if (!ehObjeto(sinal.bones)) {
    falha(erros, ctx, "bones deve ser um Record<string, [number, number, number, number]>");
  } else {
    for (const osso of BONES) {
      const quaternion = sinal.bones[osso];
      if (!Array.isArray(quaternion) || quaternion.length !== 4) {
        falha(erros, ctx, `bones.${osso} deve ser quaternion [x,y,z,w] com 4 números`);
        continue;
      }
      if (!quaternion.every(ehNumero)) {
        falha(erros, ctx, `bones.${osso} contém valor não numérico/infinito`);
        continue;
      }
      const norma = Math.hypot(...quaternion);
      if (Math.abs(norma - 1) > 0.05) {
        falha(erros, ctx, `bones.${osso} não é quaternion unitário (norma=${norma.toFixed(4)})`);
      }
    }
    const extras = Object.keys(sinal.bones).filter((chave) => !BONES.includes(chave));
    if (extras.length) {
      falha(avisos, ctx, `bones com chaves fora do contrato: ${extras.join(", ")}`);
    }
  }

  if (!ehObjeto(sinal.blendshapes)) {
    falha(erros, ctx, "blendshapes deve ser um Record<string, number>");
  } else {
    for (const chave of BLENDSHAPES) {
      const valor = sinal.blendshapes[chave];
      if (!ehNumero(valor)) {
        falha(erros, ctx, `blendshapes.${chave} deve ser número (recebido: ${JSON.stringify(valor)})`);
      } else if (valor < 0 || valor > 1) {
        falha(erros, ctx, `blendshapes.${chave} fora de 0..1 (recebido: ${valor})`);
      }
    }
    const extras = Object.keys(sinal.blendshapes).filter((chave) => !BLENDSHAPES.includes(chave));
    if (extras.length) {
      falha(avisos, ctx, `blendshapes com chaves fora do contrato: ${extras.join(", ")}`);
    }
  }

  if (sinal.classificador !== null && !ehTexto(sinal.classificador)) {
    falha(erros, ctx, "classificador deve ser string não vazia ou null");
  }

  if (sinal.notas !== undefined && typeof sinal.notas !== "string") {
    falha(erros, ctx, "notas, quando presente, deve ser string");
  }

  return { ok: erros.length === 0, erros, avisos };
}

/**
 * Valida um GlossToken da seção 6.2.
 * @param {unknown} token
 * @param {string|number} posicao
 * @param {Map<string, any>} mapaSinais mapa id -> SignPose
 */
export function validarGlossToken(token, posicao = "token", mapaSinais = new Map()) {
  const erros = [];
  const avisos = [];
  const ctx = `tokens[${posicao}]`;

  if (!ehObjeto(token)) {
    falha(erros, ctx, "deve ser um objeto GlossToken");
    return { ok: false, erros, avisos };
  }

  if (!textoUppercase(token.gloss)) {
    falha(erros, ctx, `gloss deve ser MAIÚSCULAS: ${JSON.stringify(token.gloss)}`);
  }

  if (!ehTexto(token.poseId)) {
    falha(erros, ctx, `poseId ausente ou vazio: ${JSON.stringify(token.poseId)}`);
  } else {
    const ehDedo = RE_DURO.test(token.poseId);
    const sinal = mapaSinais.get(token.poseId);
    if (!ehDedo && !sinal) {
      falha(erros, ctx, `poseId "${token.poseId}" não existe no lexicon nem segue o padrão dedo-<letra>`);
    }
    if (ehDedo && token.tipo !== "dedo" && token.tipo !== "datilologia") {
      falha(erros, ctx, `poseId de datilologia exige tipo "dedo" ou "datilologia" (recebido: ${JSON.stringify(token.tipo)})`);
    }
    if (!ehDedo && token.tipo === "dedo") {
      falha(erros, ctx, `tipo "dedo" exige poseId no padrão dedo-<letra> (recebido: ${token.poseId})`);
    }
    if (ehDedo) {
      const letra = token.poseId.slice(5).toUpperCase();
      if (sinal && token.gloss !== sinal.gloss) {
        falha(erros, ctx, `gloss "${token.gloss}" não bate com SignPose.gloss "${sinal.gloss}" de ${token.poseId}`);
      } else if (!sinal && token.gloss !== letra) {
        falha(erros, ctx, `gloss de datilologia deve ser a letra "${letra}" (recebido: ${JSON.stringify(token.gloss)})`);
      }
    } else if (sinal && token.gloss !== sinal.gloss) {
      falha(erros, ctx, `gloss "${token.gloss}" não bate com SignPose.gloss "${sinal.gloss}" de ${token.poseId}`);
    }
  }

  if (!ehTexto(token.palavraOriginal)) {
    falha(erros, ctx, "palavraOriginal deve ser string não vazia");
  }

  if (token.tipo !== "dedo" && !CATEGORIAS.includes(token.tipo)) {
    falha(erros, ctx, `tipo "${String(token.tipo)}" inválido`);
  }

  if (!ehNumero(token.intensidade) || token.intensidade < 0 || token.intensidade > 1) {
    falha(erros, ctx, `intensidade deve estar entre 0 e 1 (recebido: ${JSON.stringify(token.intensidade)})`);
  }

  if (token.classificador !== null && !ehTexto(token.classificador)) {
    falha(erros, ctx, "classificador deve ser string não vazia ou null");
  }

  return { ok: erros.length === 0, erros, avisos };
}

/**
 * Valida um GlossResult da seção 6.2 (ou um array de tokens).
 */
export function validarGlossResult(resultado, mapaSinais = new Map(), posicao = "gloss") {
  const erros = [];
  const avisos = [];
  const ctx = `[${posicao}]`;

  if (Array.isArray(resultado)) {
    resultado.forEach((token, i) => {
      const r = validarGlossToken(token, i, mapaSinais);
      erros.push(...r.erros);
      avisos.push(...r.avisos);
    });
    return { ok: erros.length === 0, erros, avisos, quantidade: resultado.length };
  }

  if (!ehObjeto(resultado)) {
    falha(erros, ctx, "GlossResult deve ser objeto");
    return { ok: false, erros, avisos, quantidade: 0 };
  }

  if (!Array.isArray(resultado.tokens)) {
    falha(erros, ctx, "tokens deve ser um array");
  } else {
    resultado.tokens.forEach((token, i) => {
      const r = validarGlossToken(token, i, mapaSinais);
      erros.push(...r.erros);
      avisos.push(...r.avisos);
    });
  }

  const expressao = resultado.expressao;
  if (!ehObjeto(expressao)) {
    falha(erros, ctx, "expressao deve ser objeto");
  } else {
    if (!EXPRESSAO_SOBRANCELHA.includes(expressao.sobrancelha)) {
      falha(erros, ctx, `expressao.sobrancelha inválida: ${JSON.stringify(expressao.sobrancelha)}`);
    }
    if (!EXPRESSAO_CABECA.includes(expressao.cabeca)) {
      falha(erros, ctx, `expressao.cabeca inválida: ${JSON.stringify(expressao.cabeca)}`);
    }
    if (!ehNumero(expressao.intensidade) || expressao.intensidade < 0 || expressao.intensidade > 1) {
      falha(erros, ctx, `expressao.intensidade fora de 0..1: ${JSON.stringify(expressao.intensidade)}`);
    }
  }

  if (!ehNumero(resultado.duracao_total_ms) || resultado.duracao_total_ms < 0) {
    falha(erros, ctx, `duracao_total_ms deve ser número >= 0: ${JSON.stringify(resultado.duracao_total_ms)}`);
  }
  if (typeof resultado.textoOriginal !== "string") {
    falha(erros, ctx, "textoOriginal deve ser string");
  }

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    quantidade: Array.isArray(resultado.tokens) ? resultado.tokens.length : 0,
  };
}

/** Aceita GlossResult, array de GlossResult, array de GlossToken ou array misto. */
export function validarTokens(entrada, mapaSinais = new Map()) {
  const itens = Array.isArray(entrada) ? entrada : [entrada];
  const erros = [];
  const avisos = [];
  let quantidade = 0;
  itens.forEach((item, i) => {
    const resultado = validarGlossResult(item, mapaSinais, `item[${i}]`);
    erros.push(...resultado.erros);
    avisos.push(...resultado.avisos);
    quantidade += resultado.quantidade;
  });
  return { ok: erros.length === 0, erros, avisos, quantidade };
}

/**
 * Valida o payload de GET /lexicon: { versao: string, sinais: SignPose[] }.
 * @returns {{ok: boolean, erros: string[], avisos: string[], quantidade: number, versao: string|null, mapaSinais: Map}}
 */
export function validarLexicon(dados) {
  const erros = [];
  const avisos = [];
  const mapaSinais = new Map();
  const indices = new Map();

  if (!ehObjeto(dados)) {
    return { ok: false, erros: ["[lexicon] payload deve ser objeto { versao, sinais }"], avisos, quantidade: 0, versao: null, mapaSinais };
  }

  if (!ehTexto(dados.versao)) falha(erros, "lexicon", "versao deve ser string não vazia");

  if (!Array.isArray(dados.sinais)) {
    falha(erros, "lexicon", "sinais deve ser um array");
    return { ok: false, erros, avisos, quantidade: 0, versao: dados.versao ?? null, mapaSinais };
  }

  if (dados.sinais.length < 300) {
    falha(erros, "lexicon", `sinais deve ter >= 300 itens (recebido: ${dados.sinais.length})`);
  }

  dados.sinais.forEach((sinal, i) => {
    const r = validarSignPose(sinal, i);
    erros.push(...r.erros);
    avisos.push(...r.avisos);
    if (ehTexto(sinal.id)) {
      if (mapaSinais.has(sinal.id)) falha(erros, "lexicon", `id duplicado: ${sinal.id} (índices ${indices.get(sinal.id)} e ${i})`);
      else {
        mapaSinais.set(sinal.id, sinal);
        indices.set(sinal.id, i);
      }
    }
  });

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    quantidade: dados.sinais.length,
    versao: typeof dados.versao === "string" ? dados.versao : null,
    mapaSinais,
  };
}

function ajuda() {
  console.log(`Validador do lexicon LibrasLive (contrato seção 6)

Uso: node scripts/verify-lexicon.mjs [opções]

Opções:
  --lexicon <caminho>   JSON do lexicon (padrão: lexicon/libras.json,
                        fallback transitório: src/lexicon/libras.json)
  --tokens <caminho>    JSON com GlossResult/GlossToken para validar também
  --json                imprime resultado em JSON
  -h, --help            mostra esta ajuda

Exit code 0 = válido, 1 = inválido.`);
}

function lerJson(caminho, rotulo) {
  if (!existsSync(caminho)) throw new Error(`${rotulo} não encontrado: ${caminho}`);
  try {
    return JSON.parse(readFileSync(caminho, "utf8"));
  } catch (erro) {
    throw new Error(`${rotulo} inválido (${caminho}): ${erro.message}`);
  }
}

function principal() {
  const args = process.argv.slice(2);
  let caminhoExplicito = null;
  let tokensPath = null;
  let sairJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      ajuda();
      return 0;
    }
    if (arg === "--json") {
      sairJson = true;
    } else if (arg === "--lexicon" || arg === "--tokens") {
      const valor = args[i + 1];
      if (!valor || valor.startsWith("--")) {
        console.error(`ERRO: ${arg} exige um caminho`);
        return 1;
      }
      if (arg === "--lexicon") caminhoExplicito = resolve(valor);
      else tokensPath = resolve(valor);
      i += 1;
    } else {
      console.error(`ERRO: opção desconhecida: ${arg}`);
      return 1;
    }
  }

  const lexiconPath = resolverCaminhoLexicon(caminhoExplicito);
  let lexicon;
  let tokens = null;
  try {
    if (!existsSync(lexiconPath) && !caminhoExplicito) {
      throw new Error(`lexicon não encontrado; procurado ${LEXICON_PATH} e ${LEXICON_PATH_FALLBACK}`);
    }
    lexicon = lerJson(lexiconPath, "lexicon");
    if (tokensPath) tokens = lerJson(tokensPath, "tokens");
  } catch (erro) {
    if (sairJson) console.log(JSON.stringify({ ok: false, erros: [erro.message], avisos: [], quantidade: 0 }));
    else console.error(`ERRO: ${erro.message}`);
    return 1;
  }

  const resultadoLexicon = validarLexicon(lexicon);
  const resultadosTokens = tokens === null ? null : validarTokens(tokens, resultadoLexicon.mapaSinais);
  const erros = [...resultadoLexicon.erros, ...(resultadosTokens?.erros ?? [])];
  const avisos = [...resultadoLexicon.avisos, ...(resultadosTokens?.avisos ?? [])];
  const ok = erros.length === 0;

  if (sairJson) {
    console.log(JSON.stringify({
      ok,
      lexicon: lexiconPath,
      versao: resultadoLexicon.versao,
      sinais: resultadoLexicon.quantidade,
      tokens: resultadosTokens?.quantidade ?? null,
      erros,
      avisos,
    }, null, 2));
    return ok ? 0 : 1;
  }

  console.log(`LEXICON: ${lexiconPath}`);
  console.log(`VERSÃO: ${resultadoLexicon.versao ?? "(ausente)"}`);
  console.log(`SINAIS: ${resultadoLexicon.quantidade} ${resultadoLexicon.quantidade >= 300 ? "(OK, >= 300)" : "(INVÁLIDO: esperado >= 300)"}`);
  if (resultadosTokens) console.log(`TOKENS VALIDADOS: ${resultadosTokens.quantidade}`);
  console.log(`ERROS: ${erros.length}`);
  erros.forEach((erro) => console.log(`  ❌ ${erro}`));
  console.log(`AVISOS: ${avisos.length}`);
  avisos.forEach((aviso) => console.log(`  ⚠️  ${aviso}`));
  console.log(ok ? "RESULTADO: VÁLIDO" : "RESULTADO: INVÁLIDO");

  return ok ? 0 : 1;
}

const executadoDiretamente =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (executadoDiretamente) {
  process.exitCode = principal();
}
