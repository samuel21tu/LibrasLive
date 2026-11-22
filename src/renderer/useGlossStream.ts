/**
 * Ponte renderer ↔ backend (spec seção 6.3 / 6.4).
 *
 * WebSocket: ws://127.0.0.1:8000/stream
 *   servidor → cliente (JSON texto): partial | final | gloss
 *   cliente → servidor (binário PCM16): via `sendAudio` — FONTE OPCIONAL
 *
 * A captura pode ser iniciada no lado Rust (axum/whisper-rs). Nesse caso o
 * servidor empurra os eventos para o WebSocket mesmo sem nenhum chunk enviado
 * pelo renderer; `sendAudio` continua disponível apenas para alimentar o STT
 * quando a captura roda no navegador.
 *
 * Se o backend não estiver rodando, entra em MODO DEMO: emite um GlossResult
 * de exemplo a cada ~2,5s e tenta reconectar com backoff exponencial. O modo
 * demo também tenta carregar o lexicon de `GET /lexicon` (axum) e, em dev, do
 * arquivo canônico `lexicon/libras.json` servido estaticamente em
 * `/lexicon/libras.json`. Sem nenhuma das duas fontes, o mapa segue sendo o
 * fixture embutido em `avatar/fixtures.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { GlossResult, SignPose } from "./types";
import { DEMO_GLOSSES, DEMO_POSE_MAP } from "./avatar/fixtures";

export type StreamStatus = "connecting" | "online" | "demo";

export type GlossStream = {
  /** gloss mais recente entregue pelo backend ou gerado no modo demo */
  gloss: GlossResult | null;
  status: StreamStatus;
  /** transcrição parcial (evento "partial") */
  partial: string;
  /** última transcrição final (evento "final") */
  textoFinal: string;
  latencyMs: number | null;
  /** mapa id/gloss → SignPose usado pelo retarget */
  poses: Record<string, SignPose>;
  /** versão do lexicon reportada pelo backend */
  versaoLexicon: string | null;
  /**
   * Envia um chunk PCM16 mono 16 kHz ao backend; no-op quando desconectado.
   * Opcional: com captura iniciada no Rust, os eventos chegam sem enviar áudio.
   */
  sendAudio: (chunk: ArrayBuffer | Uint16Array) => boolean;
};

const WS_URL = "ws://127.0.0.1:8000/stream";
const HTTP_BASE = "http://127.0.0.1:8000";
const DEMO_INTERVAL_MS = 2500;
const DEMO_FIRST_DELAY_MS = 650;
const CONNECT_TIMEOUT_MS = 1500;
const MAX_RETRY_DELAY_MS = 30000;

type BackendMessage = {
  type?: string;
  text?: string;
  gloss?: GlossResult;
  latency_ms?: number;
};

function ehGlossResult(valor: unknown): valor is GlossResult {
  if (!valor || typeof valor !== "object") return false;
  const candidato = valor as Partial<GlossResult>;
  return Array.isArray(candidato.tokens) && Boolean(candidato.expressao);
}

function normalizarLexicon(dados: unknown): { versao: string; sinais: SignPose[] } | null {
  if (!dados || typeof dados !== "object") return null;
  const objeto = dados as { versao?: unknown; sinais?: unknown };
  if (Array.isArray(objeto.sinais)) {
    if (typeof objeto.versao !== "string") return null;
    return { versao: objeto.versao, sinais: objeto.sinais as SignPose[] };
  }
  if (Array.isArray(dados)) return { versao: "local", sinais: dados as SignPose[] };
  return null;
}

export function useGlossStream(): GlossStream {
  const [gloss, setGloss] = useState<GlossResult | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [partial, setPartial] = useState("");
  const [textoFinal, setTextoFinal] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [poses, setPoses] = useState<Record<string, SignPose>>({ ...DEMO_POSE_MAP });
  const [versaoLexicon, setVersaoLexicon] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const demoTimerRef = useRef<number | null>(null);
  const firstDemoRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const retryRef = useRef(0);
  const mountedRef = useRef(true);
  const demoIndexRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const carregarLexicon = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Primária: axum. Secundária (dev): lexicon canônico servido pelo Vite.
    // Nenhuma das duas respondeu → mantém o fixture embutido já em `poses`.
    const fontes = [`${HTTP_BASE}/lexicon`, "/lexicon/libras.json"];

    for (const url of fontes) {
      try {
        const resposta = await fetch(url, { signal: controller.signal });
        if (!resposta.ok) continue;
        const dados: unknown = await resposta.json();
        const normalizado = normalizarLexicon(dados);
        if (!normalizado || normalizado.sinais.length === 0) continue;
        if (!mountedRef.current || controller.signal.aborted) return;

        const mapa: Record<string, SignPose> = { ...DEMO_POSE_MAP };
        for (const sinal of normalizado.sinais) {
          if (!sinal || typeof sinal.id !== "string") continue;
          mapa[sinal.id] = sinal;
          if (typeof sinal.gloss === "string") mapa[sinal.gloss] = sinal;
        }
        setPoses(mapa);
        setVersaoLexicon(normalizado.versao);
        return;
      } catch {
        // tenta a próxima fonte
      }
    }
  }, []);

  const emitirDemo = useCallback(() => {
    if (!mountedRef.current) return;
    const item = DEMO_GLOSSES[demoIndexRef.current % DEMO_GLOSSES.length];
    demoIndexRef.current += 1;
    setGloss(item);
    setTextoFinal(item.textoOriginal);
    setPartial("");
    setLatencyMs(null);
  }, []);

  const iniciarDemo = useCallback(() => {
    if (demoTimerRef.current !== null) return;
    setStatus("demo");
    demoTimerRef.current = window.setInterval(emitirDemo, DEMO_INTERVAL_MS);
    firstDemoRef.current = window.setTimeout(emitirDemo, DEMO_FIRST_DELAY_MS);
  }, [emitirDemo]);

  const pararDemo = useCallback(() => {
    if (demoTimerRef.current !== null) {
      window.clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    if (firstDemoRef.current !== null) {
      window.clearTimeout(firstDemoRef.current);
      firstDemoRef.current = null;
    }
  }, []);

  const agendarReconexao = useCallback(() => {
    if (reconnectTimerRef.current !== null || !mountedRef.current) return;
    retryRef.current += 1;
    const atraso = Math.min(MAX_RETRY_DELAY_MS, 1000 * Math.pow(2, retryRef.current - 1));
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      conectarRef.current();
    }, atraso);
  }, []);

  const conectarRef = useRef<() => void>(() => {});

  conectarRef.current = () => {
    if (!mountedRef.current) return;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      iniciarDemo();
      void carregarLexicon();
      agendarReconexao();
      return;
    }
    socketRef.current = socket;

    const timeout = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) socket.close();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      window.clearTimeout(timeout);
      retryRef.current = 0;
      pararDemo();
      setStatus("online");
      void carregarLexicon();
    };

    socket.onmessage = (evento: MessageEvent) => {
      if (typeof evento.data !== "string") return;
      let mensagem: BackendMessage;
      try {
        mensagem = JSON.parse(evento.data) as BackendMessage;
      } catch {
        return;
      }
      if (typeof mensagem.latency_ms === "number") setLatencyMs(mensagem.latency_ms);

      if (mensagem.type === "partial" && typeof mensagem.text === "string") {
        setPartial(mensagem.text);
      } else if (mensagem.type === "final" && typeof mensagem.text === "string") {
        setTextoFinal(mensagem.text);
        setPartial("");
      } else if (mensagem.type === "gloss" && ehGlossResult(mensagem.gloss)) {
        setGloss(mensagem.gloss);
        setTextoFinal(mensagem.gloss.textoOriginal ?? "");
        setPartial("");
      }
    };

    socket.onerror = () => {
      // onclose trata a queda para evitar dupla entrada em modo demo.
    };

    socket.onclose = () => {
      window.clearTimeout(timeout);
      if (socketRef.current === socket) socketRef.current = null;
      if (!mountedRef.current) return;
      iniciarDemo();
      void carregarLexicon();
      agendarReconexao();
    };
  };

  useEffect(() => {
    mountedRef.current = true;
    conectarRef.current();
    void carregarLexicon();

    return () => {
      mountedRef.current = false;
      pararDemo();
      abortRef.current?.abort();
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
      socketRef.current = null;
    };
  }, [carregarLexicon, pararDemo]);

  const sendAudio = useCallback((chunk: ArrayBuffer | Uint16Array): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      const buffer = chunk instanceof Uint16Array ? chunk.buffer : chunk;
      const offset = chunk instanceof Uint16Array ? chunk.byteOffset : 0;
      const length = chunk instanceof Uint16Array ? chunk.byteLength : buffer.byteLength;
      socket.send(buffer.slice(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  }, []);

  return {
    gloss,
    status,
    partial,
    textoFinal,
    latencyMs,
    poses,
    versaoLexicon,
    sendAudio,
  };
}
