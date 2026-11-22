/**
 * Contrato de dados do LibrasLive — Master Spec seção 6.1 / 6.2.
 *
 * ESTE ARQUIVO É A FONTE CANÔNICA dos tipos compartilhados entre renderer,
 * conversor texto→gloss, lexicon e backend axum/Rust. A forma é idêntica à
 * especificação; não adicione campos obrigatórios novos aqui.
 */

/** Seção 6.1 — pose de um sinal, presente em cada item do lexicon. */
export type SignPose = {
  id: string;
  gloss: string;
  palavras: string[];
  categoria:
    | "substantivo"
    | "verbo"
    | "adjetivo"
    | "advérbio"
    | "frase"
    | "pergunta"
    | "negação"
    | "classificador"
    | "datilologia";
  duracao_ms: number;
  /** chaves: Hips, Spine, Chest, Neck, Head, LeftArm, LeftForeArm, LeftHand, RightArm, RightForeArm, RightHand */
  bones: Record<string, [number, number, number, number]>;
  /** chaves ARKit, valores 0..1 */
  blendshapes: Record<string, number>;
  classificador: string | null;
  notas?: string;
};

/** Seção 6.2 — token produzido pelo conversor texto→gloss. */
export type GlossToken = {
  gloss: string;
  poseId: string;
  palavraOriginal: string;
  tipo: SignPose["categoria"] | "dedo";
  intensidade: number;
  classificador: string | null;
};

/** Seção 6.2 — resultado completo do conversor. */
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

/** Alias usado pelo renderizador para a expressão global de uma frase. */
export type ExpressionState = GlossResult["expressao"];

/** Ossos nomeados do rig (contrato 6.1). */
export type BoneName =
  | "Hips"
  | "Spine"
  | "Chest"
  | "Neck"
  | "Head"
  | "LeftArm"
  | "LeftForeArm"
  | "LeftHand"
  | "RightArm"
  | "RightForeArm"
  | "RightHand";

/** Quaternion de rotação relativa no formato do contrato: [x, y, z, w]. */
export type BoneQuat = [number, number, number, number];

/** Morph targets ARKit do contrato 6.1 (valores 0..1). */
export type BlendshapeName =
  | "browInnerUp"
  | "browOuterUp_L"
  | "browOuterUp_R"
  | "browDown_L"
  | "browDown_R"
  | "eyeBlink_L"
  | "eyeBlink_R"
  | "mouthSmile_L"
  | "mouthSmile_R"
  | "mouthFrown_L"
  | "mouthFrown_R"
  | "jawOpen"
  | "cheekPuff"
  | "noseSneer_L"
  | "noseSneer_R";

export type Blendshapes = Record<string, number>;

/** Preferências persistidas do painel overlay. */
export type PanelConfig = {
  tamanho: number;
  opacidade: number;
  canto: "superior-direito" | "superior-esquerdo" | "inferior-direito" | "inferior-esquerdo";
  alwaysOnTop: boolean;
};
