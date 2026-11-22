"""Contrato 6.2 (espelho) — interface esperada do conversor de NLP.

O backend NÃO implementa a lógica definitiva de LIBRAS: ele delega ao módulo do
agente de NLP. Assinatura esperada (qualquer um dos dois formatos):

    # python/nlp/gloss.py  (arquivo do agente de NLP, quando existir)
    def text_to_gloss(texto: str, sinais: list[dict] | None = None) -> dict: ...
    # ou, mais simples:
    def text_to_gloss(texto: str) -> dict: ...

O retorno deve ser exatamente um `GlossResult` da spec 6.2:
    {
      "tokens": [{"gloss","poseId","palavraOriginal","tipo","intensidade","classificador"}],
      "expressao": {"sobrancelha","cabeca","intensidade"},
      "duracao_total_ms": int,
      "textoOriginal": str,
    }

O caminho do módulo pode ser trocado por LIBRASLIVE_GLOSS_MODULE.
Se nenhum módulo existir, server.py usa `fallback_gloss.py` (implementação real
e completa das regras da spec, inclusive datilologia) e avisa no log.
"""

from __future__ import annotations

import importlib
from functools import wraps
from typing import Any, Callable, Optional

GlossConverter = Callable[[str, Optional[list[dict[str, Any]]]], dict[str, Any]]


def load_external_converter(module_path: Optional[str] = None) -> Optional[GlossConverter]:
    candidates = [module_path, "nlp.gloss", "nlp.converter"]
    for name in candidates:
        if not name:
            continue
        try:
            module = importlib.import_module(name)
        except Exception:
            continue
        function = getattr(module, "text_to_gloss", None)
        if callable(function):
            @wraps(function)
            def adapter(texto: str, sinais: Optional[list[dict[str, Any]]] = None, _fn: Any = function) -> dict[str, Any]:
                try:
                    return _fn(texto, sinais)
                except TypeError:
                    return _fn(texto)

            return adapter
    return None
