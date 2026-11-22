/**
 * FIXTURE DE DEMO — APENAS PARA O OVERLAY FUNCIONAR SEM BACKEND.
 *
 * Estes sinais NÃO substituem o lexicon canônico (`lexicon/libras.json`,
 * >= 300 sinais, validado por `scripts/verify-lexicon.mjs`). Assim que o
 * backend servir `GET /lexicon`, `useGlossStream` substitui este mapa.
 *
 * As rotações são quaternions derivados de Euler (radianos) apenas para
 * produzir movimentos plausíveis na demo visual.
 */

import type {
  Blendshapes,
  BoneName,
  GlossResult,
  GlossToken,
  SignPose,
} from "../types";
import { neutralBlendshapes, neutralBones, quatFromEuler } from "./retarget";

const d = (graus: number): number => (graus * Math.PI) / 180;

type Euler = [number, number, number];

function makePose(
  id: string,
  gloss: string,
  palavras: string[],
  categoria: SignPose["categoria"],
  duracao_ms: number,
  rotacoes: Partial<Record<BoneName, Euler>>,
  blendshapes: Partial<Blendshapes> = {},
  classificador: string | null = null,
): SignPose {
  const bones = neutralBones();
  for (const [osso, euler] of Object.entries(rotacoes) as [BoneName, Euler][]) {
    bones[osso] = quatFromEuler(d(euler[0]), d(euler[1]), d(euler[2]));
  }
  const shapes: Blendshapes = neutralBlendshapes();
  for (const [chave, valor] of Object.entries(blendshapes)) {
    if (typeof valor === "number") shapes[chave] = valor;
  }
  return {
    id,
    gloss,
    palavras,
    categoria,
    duracao_ms,
    bones,
    blendshapes: shapes,
    classificador,
    notas: "Fixture de demo — substituir pelo lexicon real.",
  };
}

export const DEMO_POSES: SignPose[] = [
  makePose("ola", "OLA", ["olá", "ola", "oi"], "frase", 900, {
    RightArm: [0, -12, -62],
    RightForeArm: [0, -18, -22],
    RightHand: [4, -24, -8],
    Head: [0, 0, 6],
  }, { mouthSmile_L: 0.75, mouthSmile_R: 0.75, browInnerUp: 0.3 }),

  makePose("nao", "NAO", ["não", "nao"], "negação", 620, {
    Head: [0, 0, 0],
    Neck: [0, 0, 0],
    RightHand: [0, 35, 12],
    RightForeArm: [0, 0, -38],
    LeftHand: [0, 20, -8],
  }, { mouthFrown_L: 0.55, mouthFrown_R: 0.55, browDown_L: 0.4, browDown_R: 0.4 }),

  makePose("sim", "SIM", ["sim"], "frase", 520, {
    Head: [6, 0, 0],
    RightHand: [0, 10, -55],
    RightForeArm: [0, 0, -30],
  }, { mouthSmile_L: 0.4, mouthSmile_R: 0.4 }),

  makePose("onde", "ONDE", ["onde"], "pergunta", 780, {
    Head: [-4, 0, -8],
    RightArm: [0, -25, -45],
    RightForeArm: [0, -20, -20],
    RightHand: [0, 40, 0],
    Chest: [0, 12, 0],
  }, { browDown_L: 0.65, browDown_R: 0.65, browInnerUp: 0.2 }),

  makePose("voce", "VOCE", ["você", "voce"], "substantivo", 520, {
    RightArm: [0, -10, -38],
    RightHand: [0, 55, 0],
    Head: [0, 8, 0],
  }),

  makePose("esta", "ESTA", ["está", "esta", "estar"], "verbo", 620, {
    LeftArm: [0, 14, 42],
    LeftForeArm: [0, 0, 28],
    Head: [0, -6, 0],
  }),

  makePose("sei", "SEI", ["sei", "saber"], "verbo", 560, {
    Head: [0, 0, 10],
    RightHand: [0, 50, 18],
    RightForeArm: [0, 0, -22],
  }, { browInnerUp: 0.35 }),

  makePose("eu", "EU", ["eu"], "substantivo", 460, {
    RightHand: [0, 0, -20],
    RightArm: [0, 8, -14],
    Chest: [0, -5, 0],
  }),

  makePose("muito", "MUITO", ["muito", "bem", "super"], "adjetivo", 720, {
    RightArm: [0, -18, -70],
    RightForeArm: [0, -28, -18],
    RightHand: [0, -30, 0],
    Chest: [0, 10, 0],
  }, { browInnerUp: 0.6, mouthSmile_L: 0.6, mouthSmile_R: 0.6, cheekPuff: 0.25 }),

  makePose("obrigado", "OBRIGADO", ["obrigado", "obrigada", "valeu"], "frase", 980, {
    RightHand: [0, 0, -68],
    RightArm: [0, -12, -24],
    Head: [8, 0, 0],
    Chest: [0, 6, 0],
  }, { mouthSmile_L: 0.85, mouthSmile_R: 0.85, eyeBlink_L: 0.25, eyeBlink_R: 0.25 }),

  makePose("bom", "BOM", ["bom", "boa"], "adjetivo", 540, {
    RightHand: [0, 25, -18],
    RightArm: [0, -6, -20],
  }, { mouthSmile_L: 0.4, mouthSmile_R: 0.4 }),

  makePose("dia", "DIA", ["dia"], "substantivo", 500, {
    RightArm: [0, -10, -48],
    RightForeArm: [0, -30, 0],
    Head: [0, 0, 5],
  }),

  makePose("casa", "CASA", ["casa", "lar"], "substantivo", 700, {
    LeftArm: [0, 20, 48],
    RightArm: [0, -20, -48],
    Head: [0, 0, 0],
  }, {}, "mao-plana"),

  makePose("trabalho", "TRABALHO", ["trabalho", "trabalhar"], "substantivo", 860, {
    LeftArm: [0, 14, 40],
    RightForeArm: [0, -20, -40],
    RightHand: [0, 30, 0],
    Chest: [0, -8, 0],
  }),

  makePose("agora", "AGORA", ["agora", "já"], "advérbio", 560, {
    Head: [0, 0, -10],
    RightHand: [0, -40, 0],
    RightArm: [0, -16, -35],
  }, { browInnerUp: 0.3 }),

  makePose("amor", "AMOR", ["amor", "amo"], "substantivo", 760, {
    RightHand: [0, 0, -14],
    LeftHand: [0, 0, 14],
    RightArm: [0, -8, -28],
    LeftArm: [0, 8, 28],
    Head: [0, 0, 8],
  }, { mouthSmile_L: 0.7, mouthSmile_R: 0.7, cheekPuff: 0.15 }),
];

export const DEMO_POSE_MAP: Record<string, SignPose> = Object.freeze(
  DEMO_POSES.reduce<Record<string, SignPose>>((mapa, pose) => {
    mapa[pose.id] = pose;
    mapa[pose.gloss] = pose;
    return mapa;
  }, {}),
);

function token(
  gloss: string,
  poseId: string,
  palavraOriginal: string,
  tipo: GlossToken["tipo"],
  intensidade: number,
  classificador: string | null = null,
): GlossToken {
  return { gloss, poseId, palavraOriginal, tipo, intensidade, classificador };
}

function frase(
  textoOriginal: string,
  tokens: GlossToken[],
  sobrancelha: GlossResult["expressao"]["sobrancelha"],
  cabeca: GlossResult["expressao"]["cabeca"],
  intensidade: number,
): GlossResult {
  const duracao_total_ms = tokens.reduce((soma, item) => soma + (DEMO_POSE_MAP[item.poseId]?.duracao_ms ?? 260), 0);
  return {
    tokens,
    expressao: { sobrancelha, cabeca, intensidade },
    duracao_total_ms,
    textoOriginal,
  };
}

/** Sequência de frases usadas pelo modo demo do `useGlossStream`. */
export const DEMO_GLOSSES: GlossResult[] = [
  frase("Olá!", [token("OLA", "ola", "olá", "frase", 0.85)], "neutra", "neutra", 0.5),

  frase(
    "Eu não sei.",
    [
      token("EU", "eu", "eu", "substantivo", 0.6),
      token("NAO", "nao", "não", "negação", 0.9),
      token("SEI", "sei", "sei", "verbo", 0.55),
    ],
    "franzida",
    "balancando",
    0.75,
  ),

  frase(
    "Onde você está?",
    [
      token("ONDE", "onde", "onde", "pergunta", 0.8),
      token("VOCE", "voce", "você", "substantivo", 0.5),
      token("ESTA", "esta", "está", "verbo", 0.6),
    ],
    "franzida",
    "neutra",
    0.65,
  ),

  frase(
    "Muito obrigado!",
    [
      token("MUITO", "muito", "muito", "adjetivo", 1),
      token("OBRIGADO", "obrigado", "obrigado", "frase", 0.9),
    ],
    "erguida",
    "inclinada",
    0.9,
  ),

  frase(
    "Agora trabalho em casa.",
    [
      token("AGORA", "agora", "agora", "advérbio", 0.7),
      token("TRABALHO", "trabalho", "trabalho", "substantivo", 0.7),
      token("CASA", "casa", "casa", "substantivo", 0.65),
    ],
    "neutra",
    "neutra",
    0.5,
  ),

  frase(
    "SILVA",
    "SILVA".split("").map((letra) => token(letra, `dedo-${letra}`, letra, "dedo", 0.6)),
    "neutra",
    "neutra",
    0.4,
  ),

  frase(
    "Você é bom, sim!",
    [
      token("VOCE", "voce", "você", "substantivo", 0.55),
      token("BOM", "bom", "bom", "adjetivo", 0.95),
      token("SIM", "sim", "sim", "frase", 0.9),
    ],
    "erguida",
    "inclinada",
    0.85,
  ),

  frase(
    "Bom dia, meu amor.",
    [
      token("BOM", "bom", "bom", "adjetivo", 0.7),
      token("DIA", "dia", "dia", "substantivo", 0.6),
      token("AMOR", "amor", "amor", "substantivo", 0.9),
    ],
    "erguida",
    "neutra",
    0.8,
  ),
];
