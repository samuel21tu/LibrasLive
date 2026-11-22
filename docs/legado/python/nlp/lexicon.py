"""Carregador do léxico (contrato 6.1 — SignPose).

Fonte preferencial: `src/lexicon/libras.json` (arquivo do agente de NLP, >= 300 sinais).
Enquanto o arquivo não existe, devolve um léxico mínimo VÁLIDO (todos os campos
do SignPose preenchidos) para que /lexicon e o conversor funcionem offline.
Este módulo apenas LÊ o arquivo do colega — nunca o modifica.
"""

from __future__ import annotations

import json
from typing import Any

from config import LEXICON_PATH

BONE_KEYS = (
    "Hips", "Spine", "Chest", "Neck", "Head",
    "LeftArm", "LeftForeArm", "LeftHand",
    "RightArm", "RightForeArm", "RightHand",
)

BLENDSHAPE_KEYS = (
    "browInnerUp", "browOuterUp_L", "browOuterUp_R",
    "browDown_L", "browDown_R",
    "eyeBlink_L", "eyeBlink_R",
    "mouthSmile_L", "mouthSmile_R", "mouthFrown_L", "mouthFrown_R",
    "jawOpen", "cheekPuff", "noseSneer_L", "noseSneer_R",
)


def _bones(**overrides: tuple[float, float, float, float]) -> dict[str, list[float]]:
    result: dict[str, list[float]] = {key: [0.0, 0.0, 0.0, 1.0] for key in BONE_KEYS}
    for key, value in overrides.items():
        if key in result:
            result[key] = list(value)
    return result


def _blendshapes(**overrides: float) -> dict[str, float]:
    result: dict[str, float] = {key: 0.0 for key in BLENDSHAPE_KEYS}
    for key, value in overrides.items():
        if key in result:
            result[key] = float(value)
    return result


def _sign(
    sign_id: str,
    gloss: str,
    palavras: list[str],
    categoria: str,
    duracao_ms: int,
    bones: dict[str, list[float]] | None = None,
    blendshapes: dict[str, float] | None = None,
    classificador: str | None = None,
    notas: str | None = None,
) -> dict[str, Any]:
    sign: dict[str, Any] = {
        "id": sign_id,
        "gloss": gloss,
        "palavras": palavras,
        "categoria": categoria,
        "duracao_ms": duracao_ms,
        "bones": bones or _bones(),
        "blendshapes": blendshapes or _blendshapes(),
        "classificador": classificador,
    }
    if notas:
        sign["notas"] = notas
    return sign


BUILTIN_SIGNS: list[dict[str, Any]] = [
    _sign("ola", "OLA", ["ola", "oi", "saudacao"], "frase", 500,
          bones=_bones(RightHand=(0.0, 0.38, 0.0, 0.92)),
          blendshapes=_blendshapes(mouthSmile_L=0.6, mouthSmile_R=0.6),
          notas="Sinal de saudação — mão dominante na testa."),
    _sign("nao", "NAO", ["nao", "nunca", "jamais"], "negação", 450,
          bones=_bones(Head=(0.0, 0.42, 0.0, 0.91), RightHand=(0.0, 0.25, 0.0, 0.97)),
          blendshapes=_blendshapes(browDown_L=0.5, browDown_R=0.5),
          notas="Balanço da cabeça + mão plana."),
    _sign("sim", "SIM", ["sim", "certo", "ok"], "frase", 400,
          bones=_bones(RightHand=(0.0, 0.35, 0.0, 0.94))),
    _sign("obrigado", "OBRIGADO", ["obrigado", "obrigada", "valeu"], "frase", 650,
          bones=_bones(RightHand=(0.0, 0.45, 0.0, 0.89)),
          blendshapes=_blendshapes(mouthSmile_L=0.5, mouthSmile_R=0.5)),
    _sign("por-favor", "POR FAVOR", ["por favor", "favor"], "frase", 600,
          bones=_bones(Chest=(0.0, 0.12, 0.0, 0.99))),
    _sign("onde", "ONDE", ["onde"], "pergunta", 500,
          bones=_bones(browInnerUp=(0.0, 0.0, 0.0, 1.0)),
          blendshapes=_blendshapes(browDown_L=0.7, browDown_R=0.7),
          notas="Pergunta QU — sobrancelhas franzidas."),
    _sign("quem", "QUEM", ["quem"], "pergunta", 450,
          blendshapes=_blendshapes(browDown_L=0.7, browDown_R=0.7)),
    _sign("hoje", "HOJE", ["hoje", "agora"], "advérbio", 450,
          bones=_bones(RightArm=(0.0, 0.3, 0.0, 0.95))),
    _sign("eu", "EU", ["eu", "mim"], "substantivo", 350,
          bones=_bones(RightHand=(0.0, 0.2, 0.0, 0.98))),
    _sign("voce", "VOCE", ["voce", "você", "tu"], "substantivo", 350,
          bones=_bones(LeftHand=(0.0, 0.2, 0.0, 0.98))),
    _sign("bom-dia", "BOM DIA", ["bom dia", "dia"], "frase", 600,
          blendshapes=_blendshapes(mouthSmile_L=0.4, mouthSmile_R=0.4)),
    _sign("classificador-plano", "CLASSIFICADOR PLANO", ["plano"], "classificador", 500,
          classificador="mao-plana"),
]


def load_lexicon() -> dict[str, Any]:
    """Devolve `{"versao": str, "sinais": SignPose[]}`."""
    if LEXICON_PATH.exists():
        try:
            data = json.loads(LEXICON_PATH.read_text(encoding="utf-8"))
            signs = data.get("sinais") if isinstance(data, dict) else data
            if isinstance(signs, list) and signs:
                return {
                    "versao": str(data.get("versao", "1.0.0")) if isinstance(data, dict) else "1.0.0",
                    "sinais": signs,
                }
        except (OSError, json.JSONDecodeError):
            pass
    return {"versao": "fallback-0.1.0", "sinais": BUILTIN_SIGNS}
