/**
 * LibrasLive — cliente de streaming STT (dono: agente de Áudio/STT "Eco").
 *
 * ============================ CONTRATO 3 — WEBSOCKET (spec 6.3) ============================
 * Endpoint padrão: ws://127.0.0.1:8000/stream
 * Cliente -> servidor: BINÁRIO, PCM16 mono 16 kHz, 320 amostras (640 bytes) por frame.
 * Servidor -> cliente (JSON texto):
 *   {"type":"partial","text":"...","latency_ms":n}
 *   {"type":"final","text":"...","latency_ms":n}
 *   {"type":"gloss","gloss": GlossResult, "latency_ms":n}   (GlossResult = contrato 6.2)
 * Evento de erro (extensão documentada deste módulo): {"type":"error","message":"...","latency_ms":n}
 *
 * ============================ CONTRATO 2 — EVENTOS DE TEXTO ============================
 * `WhisperStreamClient` emite `partial`, `final`, `gloss` e `error` via EventEmitter,
 * com o payload exato acima. `GlossResultLike` é espelho estrutural de 6.2 —
 * sincronizar com `src/nlp/gloss.ts` quando o agente de NLP o criar.
 *
 * Offline: conecta somente ao backend local. Modelo small-pt carregado una vez no Python.
 * Latência alvo < 1.5s obtida com transcrições parciais periódicas no servidor.
 * =====================================================================================
 */

import { EventEmitter } from "node:events";

export interface GlossResultLike {
  tokens: Array<{
    gloss: string;
    poseId: string;
    palavraOriginal: string;
    tipo: string;
    intensidade: number;
    classificador: string | null;
  }>;
  expressao: {
    sobrancelha: "neutra" | "erguida" | "franzida";
    cabeca: "neutra" | "inclinada" | "balancando";
    intensidade: number;
  };
  duracao_total_ms: number;
  textoOriginal: string;
}

export interface StreamEventBase {
  latency_ms: number;
}
export interface PartialEvent extends StreamEventBase {
  type: "partial";
  text: string;
}
export interface FinalEvent extends StreamEventBase {
  type: "final";
  text: string;
}
export interface GlossEvent extends StreamEventBase {
  type: "gloss";
  gloss: GlossResultLike;
}
export interface StreamErrorEvent extends StreamEventBase {
  type: "error";
  message: string;
}
export type StreamEvent = PartialEvent | FinalEvent | GlossEvent | StreamErrorEvent;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface WhisperClientOptions {
  url?: string;
  /** Reconecta automaticamente após queda. Padrão true. */
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  /** Frames enfileirados enquanto conecta (padrão 50). */
  maxQueuedChunks?: number;
  /** Injeta um WebSocket próprio (útil no renderer/Electron). */
  webSocketFactory?: (url: string) => Promise<WebSocketLike> | WebSocketLike;
  onLog?: (message: string) => void;
}

const CONNECTING = 0;
const OPEN = 1;

async function defaultWebSocketFactory(url: string): Promise<WebSocketLike> {
  const globalWs = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof globalWs === "function") return new globalWs(url);
  const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
  const module = await dynamicImport("ws");
  const Ws = module.default ?? module.WebSocket ?? module;
  return new Ws(url) as WebSocketLike;
}

/** Converte JSON recebido em evento tipado. Retorna null para mensagens desconhecidas. */
export function parseStreamMessage(data: unknown): StreamEvent | null {
  let raw: string;
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    raw = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } else return null;

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!message || typeof message.type !== "string") return null;
  const latency = typeof message.latency_ms === "number" ? message.latency_ms : 0;

  switch (message.type) {
    case "partial":
      if (typeof message.text !== "string") return null;
      return { type: "partial", text: message.text, latency_ms: latency };
    case "final":
      if (typeof message.text !== "string") return null;
      return { type: "final", text: message.text, latency_ms: latency };
    case "gloss":
      if (!message.gloss || typeof message.gloss !== "object") return null;
      return { type: "gloss", gloss: message.gloss as GlossResultLike, latency_ms: latency };
    case "error":
      return { type: "error", message: String(message.message ?? "erro desconhecido"), latency_ms: latency };
    default:
      return null;
  }
}

export class WhisperStreamClient extends EventEmitter {
  readonly url: string;
  private socket: WebSocketLike | null = null;
  private outbox: ArrayBuffer[] = [];
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: Required<Pick<WhisperClientOptions, "autoReconnect" | "reconnectDelayMs" | "maxQueuedChunks">> & WhisperClientOptions;

  constructor(options: WhisperClientOptions = {}) {
    super();
    this.url = options.url ?? "ws://127.0.0.1:8000/stream";
    this.options = {
      url: this.url,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? 1500,
      maxQueuedChunks: options.maxQueuedChunks ?? 50,
      webSocketFactory: options.webSocketFactory,
      onLog: options.onLog,
    };
  }

  get isConnected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  async connect(): Promise<void> {
    if (this.socket && (this.socket.readyState === CONNECTING || this.socket.readyState === OPEN)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.manualClose = false;
    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const socket = await factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.log(`conectado em ${this.url}`);
      this.emit("open");
      this.flushOutbox();
    };
    socket.onmessage = (event) => {
      const parsed = parseStreamMessage(event.data);
      if (!parsed) return;
      this.emit(parsed.type, parsed);
      this.emit("event", parsed);
    };
    socket.onerror = (event) => {
      this.log(`erro do websocket: ${String(event)}`);
      this.emit("socket-error", event);
    };
    socket.onclose = (event) => {
      this.socket = null;
      this.log(`desconectado de ${this.url}`);
      this.emit("close", event);
      if (!this.manualClose && this.options.autoReconnect) this.scheduleReconnect();
    };
  }

  /** Envia um frame PCM16. Retorna false se descartado (fila cheia). */
  sendChunk(pcm: Int16Array): boolean {
    const view = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const buffer = view.slice().buffer as ArrayBuffer; // cópia exata, sem bytes extras
    if (this.socket?.readyState === OPEN) {
      this.socket.send(buffer);
      return true;
    }
    if (this.outbox.length < this.options.maxQueuedChunks) {
      this.outbox.push(buffer);
      return true;
    }
    return false;
  }

  /** Atalho para enviar vários frames de uma vez. */
  sendChunks(chunks: Int16Array[]): number {
    let sent = 0;
    for (const chunk of chunks) if (this.sendChunk(chunk)) sent += 1;
    return sent;
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.outbox = [];
    if (socket) socket.close(1000, "cliente encerrado");
  }

  onPartial(listener: (event: PartialEvent) => void): this {
    return this.on("partial", listener);
  }
  onFinal(listener: (event: FinalEvent) => void): this {
    return this.on("final", listener);
  }
  onGloss(listener: (event: GlossEvent) => void): this {
    return this.on("gloss", listener);
  }
  onErrorEvent(listener: (event: StreamErrorEvent) => void): this {
    return this.on("error", listener);
  }
  onAnyEvent(listener: (event: StreamEvent) => void): this {
    return this.on("event", listener);
  }

  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const buffer of queued) this.socket?.send(buffer);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) void this.connect().catch((error: unknown) => this.emit("socket-error", error));
    }, this.options.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private log(message: string): void {
    this.options.onLog?.(`[whisper] ${message}`);
  }
}
