/** Declarações de tipos para scripts/verify-lexicon.mjs (usadas pelos testes em TS). */

export type ResultadoValidacao = {
  ok: boolean;
  erros: string[];
  avisos: string[];
};

export type SignPoseLike = {
  id: string;
  gloss: string;
  [chave: string]: unknown;
};

export type ResultadoLexicon = ResultadoValidacao & {
  quantidade: number;
  versao: string | null;
  mapaSinais: Map<string, SignPoseLike>;
};

export const PROJECT_ROOT: string;
/** Caminho canônico: lexicon/libras.json. */
export const LEXICON_PATH: string;
/** Fallback transitório: src/lexicon/libras.json. */
export const LEXICON_PATH_FALLBACK: string;
export function resolverCaminhoLexicon(caminhoExplicito?: string | null): string;
export const CATEGORIAS: readonly string[];
export const BONES: readonly string[];
export const BLENDSHAPES: readonly string[];
export const EXPRESSAO_SOBRANCELHA: readonly string[];
export const EXPRESSAO_CABECA: readonly string[];

export function validarSignPose(sinal: unknown, posicao?: string | number): ResultadoValidacao;
export function validarGlossToken(
  token: unknown,
  posicao?: string | number,
  mapaSinais?: Map<string, SignPoseLike>,
): ResultadoValidacao;
export function validarGlossResult(
  resultado: unknown,
  mapaSinais?: Map<string, SignPoseLike>,
  posicao?: string,
): ResultadoValidacao & { quantidade: number };
export function validarTokens(
  entrada: unknown,
  mapaSinais?: Map<string, SignPoseLike>,
): ResultadoValidacao & { quantidade: number };
export function validarLexicon(dados: unknown): ResultadoLexicon;
