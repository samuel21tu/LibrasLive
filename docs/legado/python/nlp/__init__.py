"""Contrato e conversor texto->gloss usado pelo WebSocket."""

from .gloss_contract import GlossConverter, load_external_converter
from .fallback_gloss import fallback_text_to_gloss, build_gloss_converter

__all__ = ["GlossConverter", "load_external_converter", "fallback_text_to_gloss", "build_gloss_converter"]
