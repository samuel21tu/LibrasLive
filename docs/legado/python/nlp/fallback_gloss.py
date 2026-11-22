"""Conversor texto -> GlossResult (contrato 6.2) usado enquanto o módulo de NLP
do colega não está disponível.

Implementação real das regras da spec seção 4:
  - advérbios de tempo primeiro, sujeito/objeto/verbo, negação no fim;
  - pergunta SIM/NÃO -> sobrancelha erguida + cabeça inclinada;
  - pergunta QU -> sobrancelha franzida;
  - negação -> cabeça balançando;
  - intensidade -> amplitude/expressão reforçadas;
  - palavra fora do léxico -> datilologia (dedo-<letra>), nunca sinal inventado.

Assim que `src/lexicon/libras.json` existir, ele é usado automaticamente.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Optional

from .gloss_contract import GlossConverter, load_external_converter
from .lexicon import load_lexicon

TIME_WORDS = {
    "hoje", "agora", "ontem", "amanha", "antes", "depois", "sempre", "manha",
    "tarde", "noite", "cedo", "logo", "ja", "ainda", "entao",
}
NEG_WORDS = {"nao", "nunca", "nada", "nem", "jamais"}
YESNO_WORDS = {
    "voce", "esta", "e", "tem", "pode", "quer", "gosta", "vai", "foi", "sera",
    "sabe", "aconteceu",
}
QUESTION_WORDS = {"onde", "quem", "como", "quando", "porque", "qual", "quanto", "quantos", "que", "oque"}
ALLOWED_TYPES = {
    "substantivo", "verbo", "adjetivo", "advérbio", "frase", "pergunta",
    "negação", "classificador", "datilologia",
}
DEFAULT_DURATION_MS = 500
GAP_MS = 100


def normalize(word: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", word).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]", "", ascii_text)


def _build_lexicon_map(sinais: list[dict[str, Any]]) -> dict[str, tuple[str, str, str, int, Optional[str]]]:
    mapping: dict[str, tuple[str, str, str, int, Optional[str]]] = {}
    for sign in sinais:
        gloss = str(sign.get("gloss", "")).upper()
        pose_id = str(sign.get("id", ""))
        category = str(sign.get("categoria", "substantivo"))
        duration = int(sign.get("duracao_ms", DEFAULT_DURATION_MS) or DEFAULT_DURATION_MS)
        classifier = sign.get("classificador")
        words = sign.get("palavras") or []
        for word in words:
            keys = [normalize(str(word))]
            if " " in str(word):
                keys.extend(normalize(part) for part in str(word).split())
            for key in keys:
                if key:
                    mapping.setdefault(key, (gloss, pose_id, category, duration, classifier))
    return mapping


def fallback_text_to_gloss(texto: str, sinais: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    if sinais is None:
        sinais = load_lexicon()["sinais"]
    lexmap = _build_lexicon_map(sinais)

    raw_tokens = re.findall(r"[^\W\d_]+|\d+", texto, flags=re.UNICODE)
    pairs = [(original, normalize(original)) for original in raw_tokens]
    pairs = [(original, key) for original, key in pairs if key]
    normalized_set = {key for _, key in pairs}

    ordered = (
        [pair for pair in pairs if pair[1] in TIME_WORDS]
        + [pair for pair in pairs if pair[1] not in TIME_WORDS and pair[1] not in NEG_WORDS]
        + [pair for pair in pairs if pair[1] in NEG_WORDS]
    )

    has_negation = bool(normalized_set & NEG_WORDS)
    is_question = "?" in texto or bool(normalized_set & QUESTION_WORDS)
    is_yesno = is_question and not (normalized_set & QUESTION_WORDS) and bool(normalized_set & YESNO_WORDS)

    if has_negation:
        sobrancelha, cabeca = "neutra", "balancando"
    elif is_yesno:
        sobrancelha, cabeca = "erguida", "inclinada"
    elif is_question:
        sobrancelha, cabeca = "franzida", "neutra"
    else:
        sobrancelha, cabeca = "neutra", "neutra"

    intensidade = 0.9 if "!" in texto else (0.7 if is_question or has_negation else 0.5)

    tokens: list[dict[str, Any]] = []
    total_ms = 0
    for original, key in ordered:
        entry = lexmap.get(key)
        if entry is not None:
            gloss, pose_id, category, duration, classifier = entry
            if category not in ALLOWED_TYPES:
                category = "substantivo"
            tokens.append({
                "gloss": gloss,
                "poseId": pose_id,
                "palavraOriginal": original,
                "tipo": category,
                "intensidade": round(intensidade, 2),
                "classificador": classifier,
            })
            total_ms += duration
        else:
            for char in original:
                if not char.isalpha():
                    continue
                letter = char.upper()
                tokens.append({
                    "gloss": letter,
                    "poseId": f"dedo-{letter}",
                    "palavraOriginal": original,
                    "tipo": "dedo",
                    "intensidade": round(intensidade, 2),
                    "classificador": None,
                })
                total_ms += 450

    total_ms += GAP_MS * max(0, len(tokens) - 1)
    return {
        "tokens": tokens,
        "expressao": {
            "sobrancelha": sobrancelha,
            "cabeca": cabeca,
            "intensidade": round(intensidade, 2),
        },
        "duracao_total_ms": int(total_ms),
        "textoOriginal": texto,
    }


def build_gloss_converter(settings: Any, logger: Any) -> tuple[GlossConverter, str]:
    """Retorna (conversor, nome). Prefere o módulo externo do agente de NLP."""
    external = load_external_converter(getattr(settings, "gloss_module", None))
    if external is not None:
        name = getattr(external, "__module__", "externo")
        logger.info("gloss_converter_external", extra={"backend": name})
        return external, name
    logger.warning(
        "gloss_converter_fallback",
        extra={"backend": "fallback-python-0.1", "expected": "nlp.gloss:text_to_gloss(texto, sinais)"},
    )
    return fallback_text_to_gloss, "fallback-python-0.1"
