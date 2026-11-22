/**
 * LibrasLive — VAD de voz (dono: agente de Áudio/STT "Eco").
 *
 * ============================ CONTRATO 1 (entrada) ============================
 * Recebe PCM16 mono 16 kHz (Int16Array de `capture.ts`, frames de 320 amostras).
 * Janela de análise do Silero: 512 amostras @ 16 kHz (32 ms). O segmentador
 * reagrupa os frames 320 -> janelas 512 e devolve segmentos de fala.
 *
 * ============================ CONTRATO 2 (saída) ============================
 * `VoiceActivitySegmenter.feed(chunk)` -> Promise<VadEvent[]>:
 *   { type: "speech-start", atSample, atMs }
 *   { type: "speech-end",   atSample, atMs, pcm: Int16Array, durationMs }
 * `pcm` é o áudio do segmento (inclui o silêncio de cauda) em PCM16 mono 16 kHz.
 *
 * Backend primário: Silero-VAD via onnxruntime-node (`models/silero_vad.onnx`).
 * Fallback real: VAD por energia RMS (dBFS), sem dependência de modelo.
 * O backend Python (python/server.py) roda o VAD autoritativo; este módulo é
 * opcional no cliente, usado para economizar banda (enviar só fala) e para
 *segmentação local. Sensibilidade totalmente configurável.
 * ============================================================================
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface VadConfig {
  sampleRate: number;
  /** Silero exige 512 amostras a 16 kHz. */
  windowSize: number;
  thresholdStart: number;
  thresholdEnd: number;
  /** Quantas janelas abaixo de thresholdEnd encerram o segmento (15 * 32ms = 480ms). */
  silenceWindowsToEnd: number;
  /** Mínimo de janelas faladas para aceitar um segmento. */
  minSpeechWindows: number;
  /** Usado apenas pelo fallback de energia: limiar em dBFS. */
  energyDbThreshold: number;
  /** Caminho do silero_vad.onnx (padrão: <cwd>/models/silero_vad.onnx). */
  modelPath?: string;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16_000,
  windowSize: 512,
  thresholdStart: 0.5,
  thresholdEnd: 0.35,
  silenceWindowsToEnd: 15,
  minSpeechWindows: 3,
  energyDbThreshold: -40,
};

export interface VadDetector {
  readonly name: string;
  /** Probabilidade de fala (0..1) para exatamente `windowSize` amostras float32. */
  probability(window: Float32Array): Promise<number>;
  dispose?(): void;
}

export type VadEvent =
  | { type: "speech-start"; atSample: number; atMs: number }
  | { type: "speech-end"; atSample: number; atMs: number; pcm: Int16Array; durationMs: number };

export interface CreateVadOptions {
  config?: Partial<VadConfig>;
  /** Força o fallback de energia mesmo com o modelo disponível. */
  forceEnergy?: boolean;
  onLog?: (message: string) => void;
}

/** VAD determinístico por energia — funciona sem baixar nenhum modelo. */
export class EnergyVad implements VadDetector {
  readonly name = "energy";
  constructor(private readonly thresholdDb: number = DEFAULT_VAD_CONFIG.energyDbThreshold) {}

  async probability(window: Float32Array): Promise<number> {
    let sum = 0;
    for (let i = 0; i < window.length; i++) sum += window[i] * window[i];
    const rms = Math.sqrt(sum / Math.max(1, window.length));
    const db = 20 * Math.log10(rms + 1e-9);
    const normalized = (db + 60) / 40; // -60 dBFS -> 0, -20 dBFS -> 1
    return Math.min(1, Math.max(0, normalized));
  }
}

/** Silero-VAD via onnxruntime-node. Modelo: silero_vad.onnx (v4/v5, entradas input/state/sr). */
export class SileroOnnxVad implements VadDetector {
  readonly name = "silero-onnx";
  private state = new Float32Array(2 * 1 * 128);
  private session: any;
  private ort: any;

  private constructor(session: any, ort: any) {
    this.session = session;
    this.ort = ort;
  }

  static async create(modelPath: string): Promise<SileroOnnxVad> {
    if (!fs.existsSync(modelPath)) throw new Error(`modelo Silero não encontrado: ${modelPath}`);
    // import() dinâmico via Function evita exigir a tipagem do onnxruntime-node no build.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
    const module = await dynamicImport("onnxruntime-node");
    const ort = module.default ?? module;
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
    return new SileroOnnxVad(session, ort);
  }

  async probability(window: Float32Array): Promise<number> {
    const input = new this.ort.Tensor("float32", new Float32Array(window), [1, window.length]);
    const state = new this.ort.Tensor("float32", this.state, [2, 1, 128]);
    const sr = new this.ort.Tensor("int64", [BigInt(DEFAULT_VAD_CONFIG.sampleRate)], [1]);
    const output = await this.session.run({ input, state, sr });
    const probability = Number(output.output?.data?.[0] ?? 0);
    if (output.hn?.data) this.state = new Float32Array(output.hn.data);
    return Number.isFinite(probability) ? probability : 0;
  }

  dispose(): void {
    this.session = null;
    this.ort = null;
  }
}

/** Fábrica: tenta Silero, cai para energia com log se o modelo não estiver instalado. */
export async function createVad(options: CreateVadOptions = {}): Promise<VadDetector> {
  const config = { ...DEFAULT_VAD_CONFIG, ...options.config };
  const log = options.onLog ?? (() => undefined);
  if (!options.forceEnergy) {
    const modelPath = config.modelPath ?? path.join(process.cwd(), "models", "silero_vad.onnx");
    try {
      const detector = await SileroOnnxVad.create(modelPath);
      log(`[vad] Silero ONNX ativo: ${modelPath}`);
      return detector;
    } catch (error) {
      log(`[vad] Silero indisponível (${String(error)}); usando VAD por energia`);
    }
  }
  return new EnergyVad(config.energyDbThreshold);
}

/** Segmentador incremental com histerese (start/end thresholds + silêncio de cauda). */
export class VoiceActivitySegmenter {
  private carry = new Int16Array(0);
  private totalSamples = 0;
  private active = false;
  private silenceWindows = 0;
  private speechWindows = 0;
  private segment: number[] = [];
  private readonly config: VadConfig;

  constructor(private readonly detector: VadDetector, config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  get isSpeechActive(): boolean {
    return this.active;
  }

  get detectorName(): string {
    return this.detector.name;
  }

  /** Alimenta com chunks PCM16 arbitrários; devolve eventos completados nesta chamada. */
  async feed(chunk: Int16Array): Promise<VadEvent[]> {
    const merged = new Int16Array(this.carry.length + chunk.length);
    merged.set(this.carry, 0);
    merged.set(chunk, this.carry.length);

    const events: VadEvent[] = [];
    let offset = 0;
    while (merged.length - offset >= this.config.windowSize) {
      const windowI16 = merged.subarray(offset, offset + this.config.windowSize);
      const sampleIndex = this.totalSamples;
      offset += this.config.windowSize;
      this.totalSamples += this.config.windowSize;

      const floatWindow = new Float32Array(windowI16.length);
      for (let i = 0; i < windowI16.length; i++) floatWindow[i] = windowI16[i] / 32768;
      const probability = await this.detector.probability(floatWindow);

      if (!this.active && probability >= this.config.thresholdStart) {
        this.active = true;
        this.silenceWindows = 0;
        this.speechWindows = 1;
        this.segment = Array.from(windowI16);
        events.push({ type: "speech-start", atSample: sampleIndex, atMs: this.toMs(sampleIndex) });
      } else if (this.active) {
        this.speechWindows += 1;
        for (let i = 0; i < windowI16.length; i++) this.segment.push(windowI16[i]);
        if (probability < this.config.thresholdEnd) this.silenceWindows += 1;
        else this.silenceWindows = 0;

        if (
          this.silenceWindows >= this.config.silenceWindowsToEnd &&
          this.speechWindows >= this.config.minSpeechWindows
        ) {
          events.push(this.buildEndEvent(sampleIndex + windowI16.length));
          this.active = false;
          this.silenceWindows = 0;
          this.segment = [];
        }
      }
    }

    this.carry = merged.slice(offset);
    return events;
  }

  /** Encerra o segmento atual (ex.: ao parar a captura). */
  forceEnd(): VadEvent | null {
    if (!this.active || this.segment.length === 0) return null;
    const event = this.buildEndEvent(this.totalSamples);
    this.active = false;
    this.silenceWindows = 0;
    this.segment = [];
    return event;
  }

  reset(): void {
    this.carry = new Int16Array(0);
    this.totalSamples = 0;
    this.active = false;
    this.silenceWindows = 0;
    this.speechWindows = 0;
    this.segment = [];
  }

  /** Cópia do áudio do segmento em andamento (usado para transcrições parciais). */
  currentSegment(): Int16Array | null {
    if (!this.active || this.segment.length === 0) return null;
    return Int16Array.from(this.segment);
  }

  private buildEndEvent(atSample: number): VadEvent {
    const pcm = Int16Array.from(this.segment);
    return {
      type: "speech-end",
      atSample,
      atMs: this.toMs(atSample),
      pcm,
      durationMs: (pcm.length / this.config.sampleRate) * 1000,
    };
  }

  private toMs(sample: number): number {
    return (sample / this.config.sampleRate) * 1000;
  }
}
