/**
 * Retarget SignPose → keyframes, sem dependência de Three.js.
 *
 * Responsabilidades:
 *  - matemática de quaternion (slerp, composição, Euler→quaternion);
 *  - geração de curvas de animação com easing easeInOutCubic;
 *  - escala de amplitude por `GlossToken.intensidade`;
 *  - resolução das expressões de pergunta/negação da spec seção 4;
 *  - datilologia para tokens sem sinal no lexicon (nunca inventar sinal).
 *
 * As funções são puras: o mesmo `GlossResult` + lexicon geram sempre os mesmos
 * clipes. Isso permite testar o retarget fora do navegador.
 */

import type {
  Blendshapes,
  BoneName,
  BoneQuat,
  ExpressionState,
  GlossResult,
  GlossToken,
  SignPose,
} from "../types";

export const BONE_NAMES: readonly BoneName[] = [
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
] as const;

export const ARKIT_KEYS: readonly string[] = [
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
] as const;

const IDENTITY: BoneQuat = [0, 0, 0, 1];
const DEG = Math.PI / 180;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function quatNormalize(q: BoneQuat): BoneQuat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length < 1e-9) return [...IDENTITY];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Interpolação esférica entre duas rotações relativas. */
export function quatSlerp(a: BoneQuat, b: BoneQuat, t: number): BoneQuat {
  const x = clamp01(t);
  let [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  // Quaternions q e -q representam a mesma rotação; escolhe o arco curto.
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  if (dot > 0.9995) {
    return quatNormalize([
      lerp(ax, bx, x),
      lerp(ay, by, x),
      lerp(az, bz, x),
      lerp(aw, bw, x),
    ]);
  }

  const theta = Math.acos(clamp(dot, -1, 1));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - x) * theta) / sinTheta;
  const wb = Math.sin(x * theta) / sinTheta;
  return quatNormalize([
    wa * ax + wb * bx,
    wa * ay + wb * by,
    wa * az + wb * bz,
    wa * aw + wb * bw,
  ]);
}

/** Escala a amplitude de uma rotação: fator 0 = neutro, 1 = pose cheia. */
export function quatScale(q: BoneQuat, factor: number): BoneQuat {
  return quatSlerp(IDENTITY, q, clamp(factor, 0, 1.35));
}

/** Composição de rotações: resultado = a ∘ b (aplica b depois de a). */
export function quatMultiply(a: BoneQuat, b: BoneQuat): BoneQuat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return quatNormalize([
    aw * bx + bw * ax + ay * bz - az * by,
    aw * by + bw * ay + az * bx - ax * bz,
    aw * bz + bw * az + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

/** Euler XYZ em radianos → quaternion [x,y,z,w]. */
export function quatFromEuler(x: number, y: number, z: number): BoneQuat {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return quatNormalize([
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]);
}

export function neutralBones(): Record<BoneName, BoneQuat> {
  const result = {} as Record<BoneName, BoneQuat>;
  for (const name of BONE_NAMES) result[name] = [...IDENTITY];
  return result;
}

export function neutralBlendshapes(): Blendshapes {
  const result: Blendshapes = {};
  for (const key of ARKIT_KEYS) result[key] = 0;
  return result;
}

export type PoseKeyframe = {
  /** posição normalizada dentro do clipe, 0..1 */
  t: number;
  bones: Partial<Record<BoneName, BoneQuat>>;
  blendshapes: Blendshapes;
};

export type RetargetedClip = {
  poseId: string;
  gloss: string;
  palavraOriginal: string;
  duracao_ms: number;
  keyframes: PoseKeyframe[];
  classificador: string | null;
  /** configuração de dedo para datilologia; quando presente, sobrescreve o classificador */
  dedo: string | null;
  expressao: ExpressionState;
  amplitude: number;
};

export type PoseFrame = {
  bones: Record<BoneName, BoneQuat>;
  blendshapes: Blendshapes;
  expressao: ExpressionState;
  /** fase dentro do clipe atual, 0..1 */
  phase: number;
  gloss: string;
  poseId: string;
  classificador: string | null;
  dedo: string | null;
  /** true quando a fila está vazia e o avatar deve fazer movimento idle */
  isIdle: boolean;
};

const NEUTRAL_EXPRESSION: ExpressionState = {
  sobrancelha: "neutra",
  cabeca: "neutra",
  intensidade: 0,
};

export function neutralFrame(): PoseFrame {
  return {
    bones: neutralBones(),
    blendshapes: neutralBlendshapes(),
    expressao: { ...NEUTRAL_EXPRESSION },
    phase: 0,
    gloss: "",
    poseId: "",
    classificador: null,
    dedo: null,
    isIdle: true,
  };
}

/**
 * Spec seção 4: pergunta SIM/NÃO → sobrancelha erguida + cabeça inclinada;
 * pergunta QU → sobrancelha franzida; negação → cabeça balançando.
 * A expressão vinda do conversor (`global`) tem precedência; o token só a
 * preenche quando o conversor não decidiu (estado neutro).
 */
export function resolveExpression(token: GlossToken, global: ExpressionState): ExpressionState {
  let sobrancelha = global.sobrancelha;
  let cabeca = global.cabeca;

  if (sobrancelha === "neutra" || cabeca === "neutra") {
    if (token.tipo === "pergunta" || token.gloss.endsWith("?")) {
      const palavra = token.palavraOriginal.toLowerCase();
      const ehQu = /^(onde|quem|quando|como|qual|quanto|quantos|quantas|por\s*que|porque)\b/.test(palavra);
      if (sobrancelha === "neutra") sobrancelha = ehQu ? "franzida" : "erguida";
      if (cabeca === "neutra") cabeca = ehQu ? "neutra" : "inclinada";
    }

    const ehNegacao = token.tipo === "negação" || token.poseId === "nao" || token.gloss === "NAO";
    if (ehNegacao) {
      if (cabeca === "neutra") cabeca = "balancando";
      if (sobrancelha === "neutra") sobrancelha = "franzida";
    }
  }

  return {
    sobrancelha,
    cabeca,
    intensidade: clamp01(Math.max(global.intensidade, token.intensidade)),
  };
}

/** Blendshapes de expressão facial que se somam ao sinal. */
function expressionBlendshapes(expressao: ExpressionState, tipo: GlossToken["tipo"]): Blendshapes {
  const shapes = neutralBlendshapes();
  const forca = 0.55 + 0.45 * expressao.intensidade;

  if (expressao.sobrancelha === "erguida") {
    shapes.browInnerUp = 0.85 * forca;
    shapes.browOuterUp_L = 0.7 * forca;
    shapes.browOuterUp_R = 0.7 * forca;
  } else if (expressao.sobrancelha === "franzida") {
    shapes.browDown_L = 0.8 * forca;
    shapes.browDown_R = 0.8 * forca;
    shapes.browInnerUp = 0.18 * forca;
  } else {
    shapes.browInnerUp = 0.08;
    shapes.browOuterUp_L = 0.06;
    shapes.browOuterUp_R = 0.06;
  }

  if (tipo === "negação") {
    shapes.mouthFrown_L = 0.6 * forca;
    shapes.mouthFrown_R = 0.6 * forca;
    shapes.jawOpen = 0.18 * forca;
  } else if (tipo === "pergunta") {
    shapes.mouthSmile_L = 0.14 * forca;
    shapes.mouthSmile_R = 0.14 * forca;
    shapes.jawOpen = 0.12 * forca;
  }

  if (expressao.intensidade > 0.65) {
    shapes.cheekPuff = (expressao.intensidade - 0.65) * 0.8;
    shapes.noseSneer_L = (expressao.intensidade - 0.65) * 0.5;
    shapes.noseSneer_R = (expressao.intensidade - 0.65) * 0.5;
  }

  return shapes;
}

function blendWithExpression(base: Blendshapes, expression: Blendshapes, peso: number): Blendshapes {
  const result: Blendshapes = {};
  for (const key of ARKIT_KEYS) {
    result[key] = clamp01(lerp(base[key] ?? 0, expression[key] ?? 0, peso));
  }
  return result;
}

/** Constrói as curvas: neutro → ápice do sinal → retorno parcial. */
export function retargetSignPose(
  pose: SignPose,
  token: GlossToken,
  global: ExpressionState,
): RetargetedClip {
  const expressao = resolveExpression(token, global);
  const amplitude = clamp(0.55 + 0.45 * token.intensidade + 0.15 * global.intensidade, 0.35, 1.25);

  const targetBones = {} as Record<BoneName, BoneQuat>;
  for (const name of BONE_NAMES) {
    const rotation = pose.bones[name] ?? IDENTITY;
    targetBones[name] = quatScale(rotation, amplitude);
  }

  const expressionShapes = expressionBlendshapes(expressao, token.tipo);
  const targetShapes: Blendshapes = {};
  for (const key of ARKIT_KEYS) {
    targetShapes[key] = clamp01((pose.blendshapes[key] ?? 0) * amplitude + expressionShapes[key]);
  }

  const holdBones = {} as Record<BoneName, BoneQuat>;
  for (const name of BONE_NAMES) holdBones[name] = quatScale(targetBones[name], 0.18);

  const duracao_ms = clamp(pose.duracao_ms, 250, 2000);

  return {
    poseId: pose.id,
    gloss: pose.gloss,
    palavraOriginal: token.palavraOriginal,
    duracao_ms,
    amplitude,
    classificador: token.classificador ?? pose.classificador,
    dedo: null,
    expressao,
    keyframes: [
      { t: 0, bones: neutralBones(), blendshapes: blendWithExpression(neutralBlendshapes(), expressionShapes, 0.25) },
      { t: 0.5, bones: targetBones, blendshapes: targetShapes },
      { t: 0.82, bones: targetBones, blendshapes: targetShapes },
      { t: 1, bones: holdBones, blendshapes: blendWithExpression(neutralBlendshapes(), expressionShapes, 0.65) },
    ],
  };
}

/**
 * Spec seção 4: palavra desconhecida → datilologia, nunca inventar sinal.
 * Cada letra vira um clipe curto com uma configuração de mão distinta.
 */
function retargetDatilologia(token: GlossToken, global: ExpressionState): RetargetedClip[] {
  const letras = (token.palavraOriginal || token.gloss)
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 14);
  const sequencia = letras.length > 0 ? letras : "A";
  const expressao: ExpressionState = {
    ...global,
    intensidade: clamp01(Math.max(global.intensidade, token.intensidade, 0.45)),
  };

  return sequencia.split("").map((letra, indice) => {
    const inclinacao = ((letra.charCodeAt(0) - 65) % 7) - 3;
    const side = indice % 2 === 0 ? 1 : -1;
    const mao = side > 0 ? "RightHand" : "LeftHand";
    const antebraco = side > 0 ? "RightForeArm" : "LeftForeArm";
    const braco = side > 0 ? "RightArm" : "LeftArm";

    const bones = neutralBones();
    bones[braco] = quatFromEuler(-0.08, 0, inclinacao * 0.06);
    bones[antebraco] = quatFromEuler(0, inclinacao * 0.22 * -side, 0.1);
    bones[mao] = quatFromEuler(inclinacao * 0.1, inclinacao * 0.18, inclinacao * 0.12);

    const shapes = neutralBlendshapes();
    shapes.browInnerUp = 0.22;

    return {
      poseId: `dedo-${letra}`,
      gloss: letra,
      palavraOriginal: letra,
      duracao_ms: 240,
      amplitude: 1,
      classificador: null,
      dedo: letra,
      expressao,
      keyframes: [
        { t: 0, bones: neutralBones(), blendshapes: neutralBlendshapes() },
        { t: 0.5, bones, blendshapes: shapes },
        { t: 0.8, bones, blendshapes: shapes },
        { t: 1, bones: neutralBones(), blendshapes: neutralBlendshapes() },
      ],
    };
  });
}

/** Converte um GlossResult inteiro em uma sequência de clipes para a fila. */
export function buildClips(
  resultado: GlossResult,
  lexicon: Record<string, SignPose>,
): RetargetedClip[] {
  if (!resultado || !Array.isArray(resultado.tokens) || resultado.tokens.length === 0) return [];
  const global: ExpressionState = resultado.expressao ?? NEUTRAL_EXPRESSION;
  const clips: RetargetedClip[] = [];

  for (const token of resultado.tokens) {
    if (token.tipo === "dedo" || token.poseId.startsWith("dedo-")) {
      clips.push(...retargetDatilologia(token, global));
      continue;
    }

    const pose = lexicon[token.poseId] ?? lexicon[token.gloss];
    if (pose) {
      clips.push(retargetSignPose(pose, token, global));
    } else {
      // Nenhum sinal no lexicon: soletra (spec seção 4 — nunca inventar sinal).
      clips.push(...retargetDatilologia(token, global));
    }
  }

  return clips;
}

/** Amostra um clipe no tempo normalizado `t` (0..1), com easing e slerp. */
export function sampleClip(clip: RetargetedClip, t: number, reducedMotion = false): PoseFrame {
  const tempo = clamp01(t);
  const keyframes = clip.keyframes;
  let indice = 0;
  while (indice < keyframes.length - 2 && keyframes[indice + 1].t <= tempo) indice += 1;
  const atual = keyframes[indice];
  const proximo = keyframes[Math.min(indice + 1, keyframes.length - 1)];
  const span = proximo.t - atual.t;
  const u = span > 0 ? (tempo - atual.t) / span : 0;
  const fator = easeInOutCubic(u);

  const bones = neutralBones();
  for (const name of BONE_NAMES) {
    bones[name] = quatSlerp(
      atual.bones[name] ?? IDENTITY,
      proximo.bones[name] ?? IDENTITY,
      fator,
    );
  }

  const blendshapes: Blendshapes = {};
  for (const key of ARKIT_KEYS) {
    blendshapes[key] = clamp01(lerp(atual.blendshapes[key] ?? 0, proximo.blendshapes[key] ?? 0, fator));
  }

  const expressao: ExpressionState = { ...clip.expressao, intensidade: clamp01(clip.expressao.intensidade) };

  if (!reducedMotion) {
    if (expressao.cabeca === "balancando") {
      const oscilacao = Math.sin(tempo * Math.PI * 6) * 18 * DEG * (0.6 + 0.4 * expressao.intensidade);
      bones.Head = quatMultiply(bones.Head, quatFromEuler(0, oscilacao, 0));
      bones.Neck = quatMultiply(bones.Neck, quatFromEuler(0, oscilacao * 0.35, 0));
    } else if (expressao.cabeca === "inclinada") {
      const inclinacao = 16 * DEG;
      const pitch = -5 * DEG;
      bones.Head = quatMultiply(bones.Head, quatFromEuler(pitch, 0, inclinacao));
      bones.Neck = quatMultiply(bones.Neck, quatFromEuler(pitch * 0.4, 0, inclinacao * 0.4));
    }
  }

  return {
    bones,
    blendshapes,
    expressao,
    phase: tempo,
    gloss: clip.gloss,
    poseId: clip.poseId,
    classificador: clip.classificador,
    dedo: clip.dedo,
    isIdle: false,
  };
}
