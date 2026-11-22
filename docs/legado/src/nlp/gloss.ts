/**
 * Conversor texto pt-BR → gloss LIBRAS (Master Spec § 4 e § 6.2).
 *
 * Regras aplicadas:
 *  - tempo/condição primeiro, sujeito, objeto, verbo, negação/pergunta no fim;
 *  - pergunta SIM/NÃO → sobrancelhas erguidas + cabeça inclinada;
 *  - pergunta QU- → sobrancelhas franzidas;
 *  - negação → cabeça balançando + sinal NÃO;
 *  - intensidade → amplitude maior + expressão reforçada;
 *  - classificadores → configuração de mão para objetos;
 *  - palavra desconhecida → datilologia `dedo-<letra>` (nunca inventar sinal).
 */
import lexiconData from "../lexicon/libras.json";
import {
  INTENSIFICADORES,
  normalizar,
  removerAcentos,
  type TextoNormalizado,
} from "./normalize";
import type { GlossResult, GlossToken, SignPose } from "./contracts";

export type { GlossResult, GlossToken, SignPose, CategoriaSinal } from "./contracts";

const SINAIS = lexiconData.sinais as unknown as SignPose[];

export const SIGN_BY_ID = new Map<string, SignPose>();
const WORD_TO_SIGNS = new Map<string, SignPose[]>();
const CLASSIFICADOR_IDS = new Set<string>();

for (const sinal of SINAIS) {
  SIGN_BY_ID.set(sinal.id, sinal);
  if (sinal.categoria === "classificador" && sinal.classificador) {
    CLASSIFICADOR_IDS.add(sinal.classificador);
  }
  for (const palavra of sinal.palavras) {
    const chave = chaveDePalavra(palavra);
    if (!chave) continue;
    const candidatos = WORD_TO_SIGNS.get(chave) ?? [];
    if (!candidatos.includes(sinal)) candidatos.push(sinal);
    WORD_TO_SIGNS.set(chave, candidatos);
  }
}

/** Desambigue palavras com mais de um sentido ("como" pergunta vs. verbo comer). */
function resolverSinal(chave: string, lemma: string, normalizado: TextoNormalizado): SignPose | undefined {
  const porChave = WORD_TO_SIGNS.get(chave) ?? [];
  const porLemma = WORD_TO_SIGNS.get(lemma) ?? [];
  const candidatos = chave !== lemma && porLemma.length > 0 ? porLemma : porChave;
  if (candidatos.length === 0) return undefined;
  if (candidatos.length === 1) return candidatos[0];
  if (normalizado.tipoPergunta === "qu") {
    return candidatos.find((sinal) => sinal.categoria === "pergunta") ?? candidatos[0];
  }
  return candidatos.find((sinal) => sinal.categoria !== "pergunta") ?? candidatos[0];
}

function chaveDePalavra(palavra: string): string {
  return removerAcentos(palavra).toLocaleLowerCase("pt-BR").trim();
}

const PALAVRAS_FUNCIONAIS = new Set([
  "de", "a", "o", "as", "os", "do", "da", "dos", "das", "no", "na", "nos", "nas",
  "em", "para", "por", "com", "sem", "ao", "aos", "a", "e", "mas", "ou", "se",
  "lhe", "lhes", "me", "te", "vos", "que", "num", "numa", "numas", "numos",
]);

const INTENSIFICADOR_IDS = new Set(INTENSIFICADORES.map(chaveDePalavra));

const TEMPO_LEMAS = new Set([
  "hoje", "ontem", "amanha", "agora", "depois", "antes", "sempre", "ja", "ainda",
  "logo", "cedo", "tarde", "as-vezes", "primeiramente", "finalmente",
  "domingo", "segunda", "segunda-feira", "terca", "terca-feira",
  "quarta", "quarta-feira", "quinta", "quinta-feira", "sexta", "sexta-feira",
  "sabado", "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  "dia", "noite", "manha", "semana", "mes", "ano",
]);

const PRONOMES_SUJEITO = new Set([
  "eu", "voce", "ele", "ela", "nos", "eles", "elas", "mim", "ti",
  "isto", "este", "aquele", "quem", "alguem",
]);

const CLASSIFICADORES_POR_SUBSTANTIVO: Array<[RegExp, string]> = [
  [/cachorro|gato|passaro|peixe|cavalo|vaca|porco|galinha|animal|ave/i, "garra"],
  [/homem|mulher|menino|menina|crianca|pessoa|amigo|familia|mae|pai|irmão|filho|professor|aluno|medico|enfermeiro|bebe/i, "pino"],
  [/casa|escola|livro|mesa|cadeira|porta|janela|carro|bicicleta|aviao|onibus|trem|prato|copo|celular|computador|cama|sofa|armario|geladeira|fogao|televisao|telefone|mochila|mala/i, "mao-plana"],
  [/lapis|caneta|faca|garfo|colher|escova|chave/i, "dedo-indicador"],
  [/agua|cafe|leite|suco|vinho|cerveja|refrigerante|sopa/i, "concha"],
];

/** Classificador de mão plausível para substantivos sem classificador explícito. */
export function classificadorParaSubstantivo(idOuPalavra: string): string | null {
  const chave = chaveDePalavra(idOuPalavra);
  for (const [padrao, classificador] of CLASSIFICADORES_POR_SUBSTANTIVO) {
    if (padrao.test(chave) && CLASSIFICADOR_IDS.has(classificador)) return classificador;
  }
  return null;
}

type Papel = "tempo" | "condicao" | "sujeito" | "objeto" | "verbo" | "negacao" | "pergunta";

type TokenInterno = {
  token: GlossToken;
  papel: Papel;
  ordem: number;
  duracao_ms: number;
  ehSubstantivo: boolean;
};

const ORDEM_PAPEL: Record<Papel, number> = {
  tempo: 0,
  condicao: 1,
  sujeito: 2,
  objeto: 3,
  verbo: 4,
  negacao: 5,
  pergunta: 6,
};

function intensidadeBase(categoria: SignPose["categoria"]): number {
  switch (categoria) {
    case "adjetivo": return 0.5;
    case "negação": return 0.4;
    case "verbo": return 0.2;
    case "pergunta": return 0.35;
    default: return 0.1;
  }
}

function ehTempo(sinal: SignPose, lemma: string): boolean {
  const chave = chaveDePalavra(lemma);
  return TEMPO_LEMAS.has(chave)
    || (sinal.categoria === "advérbio" && /tempo/i.test(sinal.notas ?? ""));
}

function criarTokenDeSinal(
  sinal: SignPose,
  palavraOriginal: string,
  intensidadeGeral: number,
  tipo: GlossToken["tipo"],
): GlossToken {
  const intensidade = Math.min(1, Number((intensidadeBase(sinal.categoria) + intensidadeGeral * 0.5).toFixed(3)));
  const classificador = sinal.classificador
    ?? (sinal.categoria === "substantivo" ? classificadorParaSubstantivo(sinal.id) : null);
  return {
    gloss: sinal.gloss,
    poseId: sinal.id,
    palavraOriginal,
    tipo,
    intensidade,
    classificador,
  };
}

function criarTokensDeDatilologia(palavra: string): GlossToken[] {
  const letras = chaveDePalavra(palavra).replace(/[^a-z]/g, "");
  const tokens: GlossToken[] = [];
  for (const letra of letras) {
    const poseId = `dedo-${letra}`;
    const sinal = SIGN_BY_ID.get(poseId);
    tokens.push({
      gloss: letra.toLocaleUpperCase("pt-BR"),
      poseId,
      palavraOriginal: palavra,
      tipo: "dedo",
      intensidade: 0.1,
      classificador: sinal?.classificador ?? null,
    });
  }
  return tokens;
}

function papelDoSinal(sinal: SignPose, lemma: string, emCondicao: boolean, ehPergunta: boolean): Papel {
  if (sinal.categoria === "negação") return "negacao";
  if (sinal.categoria === "pergunta" && ehPergunta) return "pergunta";
  if (emCondicao) return "condicao";
  if (ehTempo(sinal, lemma)) return "tempo";
  if (sinal.categoria === "verbo") return "verbo";
  return "objeto";
}

function montarTokens(normalizado: TextoNormalizado): TokenInterno[] {
  const internos: TokenInterno[] = [];
  let emCondicao = false;
  let ordem = 0;

  for (const token of normalizado.tokens) {
    const chave = chaveDePalavra(token.texto);
    const chaveLemma = chaveDePalavra(token.lemma);

    if (token.pausaAntes) emCondicao = false;
    if (chave === "se") {
      emCondicao = true;
      continue;
    }
    if (INTENSIFICADOR_IDS.has(chave) || INTENSIFICADOR_IDS.has(chaveLemma)) continue;
    if (PALAVRAS_FUNCIONAIS.has(chave) || PALAVRAS_FUNCIONAIS.has(chaveLemma)) {
      if (!(normalizado.tipoPergunta === "qu" && chave === "que")) continue;
    }

    const sinal = resolverSinal(chave, chaveLemma, normalizado);

    if (!sinal) {
      for (const dedo of criarTokensDeDatilologia(token.original)) {
        internos.push({
          token: dedo,
          papel: "objeto",
          ordem: ordem++,
          duracao_ms: SIGN_BY_ID.get(dedo.poseId)?.duracao_ms ?? 300,
          ehSubstantivo: true,
        });
      }
      continue;
    }

    const papel = papelDoSinal(sinal, token.lemma, emCondicao, normalizado.ehPergunta);
    const glossToken = criarTokenDeSinal(
      sinal,
      token.original,
      normalizado.intensidade,
      sinal.categoria === "datilologia" ? "datilologia" : sinal.categoria,
    );
    internos.push({
      token: glossToken,
      papel,
      ordem: ordem++,
      duracao_ms: sinal.duracao_ms,
      ehSubstantivo: sinal.categoria === "substantivo"
        || sinal.categoria === "frase"
        || sinal.categoria === "datilologia"
        || glossToken.tipo === "dedo",
    });
  }
  return internos;
}

function reordenar(internos: TokenInterno[], normalizado: TextoNormalizado): TokenInterno[] {
  const indiceVerbo = internos.findIndex((item) => item.papel === "verbo");
  let sujeitoAtribuido = false;

  for (let i = 0; i < internos.length; i++) {
    const item = internos[i];
    if (!item.ehSubstantivo) continue;
    if (item.papel === "condicao" || item.papel === "tempo"
      || item.papel === "pergunta" || item.papel === "negacao") continue;
    const id = chaveDePalavra(item.token.poseId);
    const ehPronome = PRONOMES_SUJEITO.has(id) || PRONOMES_SUJEITO.has(chaveDePalavra(item.token.palavraOriginal));
    if (!sujeitoAtribuido && (ehPronome || indiceVerbo === -1 || i < indiceVerbo)) {
      item.papel = "sujeito";
      sujeitoAtribuido = true;
    } else {
      item.papel = "objeto";
    }
  }

  if (normalizado.tipoPergunta === "simnao") {
    const marcador = SIGN_BY_ID.get("pergunta-simnao");
    if (marcador) {
      internos.push({
        token: {
          gloss: marcador.gloss,
          poseId: marcador.id,
          palavraOriginal: "?",
          tipo: "pergunta",
          intensidade: Math.min(1, 0.3 + normalizado.intensidade * 0.4),
          classificador: null,
        },
        papel: "pergunta",
        ordem: Number.MAX_SAFE_INTEGER,
        duracao_ms: marcador.duracao_ms,
        ehSubstantivo: false,
      });
    }
  }

  return [...internos].sort((a, b) => {
    const diferenca = ORDEM_PAPEL[a.papel] - ORDEM_PAPEL[b.papel];
    return diferenca !== 0 ? diferenca : a.ordem - b.ordem;
  });
}

/** Converte texto pt-BR em `GlossResult`, respeitando todas as regras da § 4. */
export function textoParaGloss(texto: string): GlossResult {
  const normalizado = normalizar(texto);
  const ordenados = reordenar(montarTokens(normalizado), normalizado);
  const tokens = ordenados.map((item) => item.token);

  const intensidade = Math.min(
    1,
    Math.max(normalizado.intensidade, 0, ...tokens.map((token) => token.intensidade)),
  );

  const sobrancelha: GlossResult["expressao"]["sobrancelha"] =
    normalizado.tipoPergunta === "qu" ? "franzida"
      : normalizado.tipoPergunta === "simnao" ? "erguida"
        : "neutra";

  const cabeca: GlossResult["expressao"]["cabeca"] =
    normalizado.temNegacao ? "balancando"
      : normalizado.tipoPergunta === "simnao" ? "inclinada"
        : "neutra";

  return {
    tokens,
    expressao: { sobrancelha, cabeca, intensidade },
    duracao_total_ms: ordenados.reduce((total, item) => total + item.duracao_ms, 0),
    textoOriginal: texto,
  };
}

/** Alias semântico para chamadas do backend/renderer. */
export const converterTextoParaGloss = textoParaGloss;

/** Permite ao backend substituir o normalizador pelo spaCy sem acoplar módulos. */
export function textoParaGlossComEntrada(texto: string, normalizado: TextoNormalizado): GlossResult {
  const ordenados = reordenar(montarTokens(normalizado), normalizado);
  const tokens = ordenados.map((item) => item.token);
  return {
    tokens,
    expressao: {
      sobrancelha: normalizado.tipoPergunta === "qu" ? "franzida"
        : normalizado.tipoPergunta === "simnao" ? "erguida" : "neutra",
      cabeca: normalizado.temNegacao ? "balancando"
        : normalizado.tipoPergunta === "simnao" ? "inclinada" : "neutra",
      intensidade: Math.min(1, Math.max(normalizado.intensidade, 0, ...tokens.map((t) => t.intensidade))),
    },
    duracao_total_ms: ordenados.reduce((total, item) => total + item.duracao_ms, 0),
    textoOriginal: texto,
  };
}
