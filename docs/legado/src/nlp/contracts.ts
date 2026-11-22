/**
 * Contratos de dados compartilhados (Master Spec § 6.1 e § 6.2).
 * Exportados daqui para que avatar, backend e NLP usem exatamente a mesma forma.
 */

export type CategoriaSinal =
  | "substantivo"
  | "verbo"
  | "adjetivo"
  | "advérbio"
  | "frase"
  | "pergunta"
  | "negação"
  | "classificador"
  | "datilologia";

/** § 6.1 — entrada do avatar, um item de `lexicon/libras.json`. */
export type SignPose = {
  id: string;
  gloss: string;
  palavras: string[];
  categoria: CategoriaSinal;
  duracao_ms: number;
  bones: Record<string, [number, number, number, number]>;
  blendshapes: Record<string, number>;
  classificador: string | null;
  notas?: string;
};

/** § 6.2 — um token da frase em LIBRAS. */
export type GlossToken = {
  gloss: string;
  poseId: string;
  palavraOriginal: string;
  tipo: CategoriaSinal | "dedo";
  intensidade: number;
  classificador: string | null;
};

/** § 6.2 — resultado completo do conversor texto → gloss. */
export type GlossResult = {
  tokens: GlossToken[];
  expressao: {
    sobrancelha: "neutra" | "erguida" | "franzida";
    cabeca: "neutra" | "inclinada" | "balancando";
    intensidade: number;
  };
  duracao_total_ms: number;
  textoOriginal: string;
};

/** Envelope devolvido por `GET /lexicon` (§ 6.3). */
export type LexiconResponse = {
  versao: string;
  sinais: SignPose[];
};
