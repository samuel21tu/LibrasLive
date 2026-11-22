/**
 * LibrasLive — captura de loopback de áudio do sistema operacional.
 * Dono: agente de Áudio/STT ("Eco").
 *
 * ============================ CONTRATO 1 — CHUNK DE ÁUDIO ============================
 * Formato exato entregue ao VAD/STT (seção 6.3 da spec):
 *   - sample rate: 16000 Hz
 *   - canais: 1 (mono)
 *   - formato: PCM little-endian assinado de 16 bits (s16le / Int16Array)
 *   - tamanho de frame: 320 amostras = 640 bytes = 20 ms
 *   - ordem dos bytes: little-endian (x86/ARM Windows e Linux)
 * Evento emitido: `chunk` com `AudioChunk` (pcm, sampleRate, channels, timestampMs, sequence).
 * `timestampMs` é monotônico (performance.now()) — NÃO é epoch.
 *
 * Backends tentados em ordem (detecção automática de plataforma):
 *   Linux     : `pactl get-default-sink` -> `<sink>.monitor` -> ffmpeg -f pulse
 *               fallback: ffmpeg -f pulse -i default
 *   Windows   : `ffmpeg -list_devices -f dshow` -> device de loopback/Stereo Mix/virtual cable
 *               fallback: "virtual-audio-capturer", "Stereo Mix", "Mixagem estéreo"
 *   Universal : override via LIBRASLIVE_FFMPEG_ARGS / opção `candidates`
 *
 * Offline: usa apenas binários locais (ffmpeg, pactl). Nenhuma rede.
 * Tratamento de erro: falha de spawn/timeout no probe -> próximo candidato;
 * morte do processo após conexão -> emit `error` + reinício automático com fallback.
 * =====================================================================================
 */

import { EventEmitter } from "node:events";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_FORMAT = "s16le";
export const FRAME_SAMPLES = 320;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

export interface AudioChunk {
  /** PCM16 LE, mono, 16 kHz, exatamente 320 amostras (640 bytes). */
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
  /** Monotônico, ms (performance.now()). */
  timestampMs: number;
  /** Número sequencial do frame desde o início da captura. */
  sequence: number;
}

export type CaptureBackend =
  | "override"
  | "linux-pulse-monitor"
  | "linux-pulse-default"
  | "windows-dshow"
  | "windows-dshow-virtual";

export interface CaptureCandidate {
  backend: CaptureBackend;
  command: string;
  args: string[];
  /** Rótulo legível para logs. */
  description: string;
}

export interface CaptureOptions {
  /** Tempo máximo esperando o primeiro frame de cada candidato (ms). Padrão 2500. */
  probeTimeoutMs?: number;
  /** Quantos reinícios automáticos após o ffmpeg morrer. Padrão 3. */
  maxRestarts?: number;
  /** Delay antes de cada reinício (ms). Padrão 1000. */
  restartDelayMs?: number;
  /** Substitui a detecção automática (útil para testes e dispositivos exóticos). */
  candidates?: CaptureCandidate[];
  onLog?: (message: string) => void;
}

type ExecResult = { stdout: string; stderr: string };
const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<ExecResult>;

function ffmpegTail(): string[] {
  return ["-ac", String(AUDIO_CHANNELS), "-ar", String(AUDIO_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", AUDIO_FORMAT, "pipe:1"];
}

function pulseCandidate(source: string, backend: CaptureBackend, description: string): CaptureCandidate {
  return {
    backend,
    command: "ffmpeg",
    args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "pulse", "-i", source, ...ffmpegTail()],
    description,
  };
}

function dshowCandidate(device: string): CaptureCandidate {
  return {
    backend: device.toLowerCase().includes("virtual") ? "windows-dshow-virtual" : "windows-dshow",
    command: "ffmpeg",
    args: [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "dshow", "-i", `audio=${device}`, ...ffmpegTail(),
    ],
    description: `WASAPI/dshow loopback: ${device}`,
  };
}

async function runProbe(command: string, args: string[], timeout: number): Promise<ExecResult | null> {
  try {
    return await execFileAsync(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Descobre o monitor source do PulseAudio/PipeWire (pipewire-pulse expõe a mesma API). */
async function linuxCandidates(): Promise<CaptureCandidate[]> {
  const out: CaptureCandidate[] = [];
  const sinkResult = await runProbe("pactl", ["get-default-sink"], 3000);
  const sourcesResult = await runProbe("pactl", ["list", "short", "sources"], 3000);
  const sink = sinkResult?.stdout.trim() ?? "";
  const sources = sourcesResult?.stdout ?? "";

  let monitor = sink ? `${sink}.monitor` : "";
  if (monitor && !sources.includes(monitor)) {
    // Nem sempre o nome é exatamente <sink>.monitor; pega o primeiro monitor disponível.
    const anyMonitor = sources
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((cols) => cols[1]?.includes(".monitor"));
    monitor = anyMonitor?.[1] ?? "";
  }

  if (monitor) {
    out.push(pulseCandidate(monitor, "linux-pulse-monitor", `PipeWire/Pulse monitor: ${monitor}`));
  }
  out.push(pulseCandidate("default", "linux-pulse-default", "Pulse source padrão (pode ser microfone)"));
  return out;
}

async function windowsCandidates(): Promise<CaptureCandidate[]> {
  const out: CaptureCandidate[] = [];
  const probe = await runProbe(
    "ffmpeg",
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    6000,
  );
  const listing = `${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`;
  const names: string[] = [];
  const regex = /\[dshow[^\]]*\]\s+"([^"]+)"\s*\(audio\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(listing)) !== null) names.push(match[1]);

  const preferred = names.filter((n) => /loopback|stereo mix|mixagem|virtual|cable|wasapi/i.test(n));
  const seen = new Set<string>();
  for (const name of [...preferred, ...names, "virtual-audio-capturer", "Stereo Mix", "Mixagem estéreo"]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dshowCandidate(name));
  }
  return out;
}

/** Lista os candidatos na ordem em que serão tentados. Exportado para diagnóstico. */
export async function listCaptureCandidates(): Promise<CaptureCandidate[]> {
  const override = process.env.LIBRASLIVE_FFMPEG_ARGS?.trim();
  if (override) {
    return [{
      backend: "override",
      command: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...override.split(/\s+/), ...ffmpegTail()],
      description: `LIBRASLIVE_FFMPEG_ARGS: ${override}`,
    }];
  }
  if (process.platform === "win32") return windowsCandidates();
  return linuxCandidates();
}

export class LoopbackCapture extends EventEmitter {
  private running = false;
  private process: ChildProcess | null = null;
  private pending = Buffer.alloc(0);
  private activeBackend: CaptureBackend | null = null;
  private sequence = 0;
  private restartCount = 0;
  private readonly options: Required<Omit<CaptureOptions, "candidates" | "onLog">> & Pick<CaptureOptions, "candidates" | "onLog">;

  constructor(options: CaptureOptions = {}) {
    super();
    this.options = {
      probeTimeoutMs: options.probeTimeoutMs ?? 2500,
      maxRestarts: options.maxRestarts ?? 3,
      restartDelayMs: options.restartDelayMs ?? 1000,
      candidates: options.candidates,
      onLog: options.onLog,
    };
  }

  get backend(): CaptureBackend | null {
    return this.activeBackend;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Inicia a captura e resolve com o backend que funcionou. */
  async start(): Promise<CaptureBackend> {
    if (this.running) throw new Error("LoopbackCapture já está rodando");
    this.running = true;
    this.restartCount = 0;
    return this.startInternal();
  }

  private async startInternal(): Promise<CaptureBackend> {
    const candidates = this.options.candidates ?? (await listCaptureCandidates());
    if (candidates.length === 0) {
      this.running = false;
      throw new Error(
        "Nenhum backend de captura disponível. No Linux instale pavucontrol e habilite 'Monitor of <saída>'; " +
        "no Windows instale um virtual cable (VB-CABLE) ou Stereo Mix e use LIBRASLIVE_FFMPEG_ARGS.",
      );
    }

    for (const candidate of candidates) {
      if (!this.running) break;
      this.log(`tentando backend ${candidate.backend}: ${candidate.description}`);
      const ok = await this.tryCandidate(candidate);
      if (ok) {
        this.activeBackend = candidate.backend;
        this.log(`backend ativo: ${candidate.backend}`);
        return candidate.backend;
      }
    }

    this.running = false;
    throw new Error(`Todos os backends de captura falharam (${candidates.length} candidatos testados)`);
  }

  private tryCandidate(candidate: CaptureCandidate): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(candidate.command, candidate.args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        this.log(`spawn falhou para ${candidate.backend}: ${String(error)}`);
        resolve(false);
        return;
      }
      this.process = proc;
      this.pending = Buffer.alloc(0);

      let settled = false;
      let receivedFrame = false;
      let stderr = "";
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.log(`probe timeout em ${candidate.backend}`);
          if (this.process === proc) this.process = null;
          proc.kill("SIGTERM");
          resolve(false);
        }
      }, this.options.probeTimeoutMs);

      proc.on("error", (error: Error) => {
        stderr += error.message;
        this.log(`erro do ffmpeg (${candidate.backend}): ${error.message}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (this.process === proc) this.process = null;
          resolve(false);
        } else if (this.running) {
          this.emit("error", error);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString("utf8")).slice(-4000);
      });

      proc.stdout?.on("data", (data: Buffer) => {
        this.pending = this.pending.length === 0 ? Buffer.from(data) : Buffer.concat([this.pending, data]);
        while (this.pending.length >= FRAME_BYTES) {
          const frame = this.pending.subarray(0, FRAME_BYTES);
          this.pending = this.pending.subarray(FRAME_BYTES);
          if (!receivedFrame) {
            receivedFrame = true;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(true);
            }
          }
          this.emitFrame(frame);
        }
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (this.process === proc) this.process = null;
          this.log(`ffmpeg ${candidate.backend} fechou no probe (código ${code}): ${stderr.slice(-400)}`);
          resolve(false);
        } else if (this.running && this.process === proc) {
          this.emit("error", new Error(`ffmpeg (${candidate.backend}) encerrou (código ${code}): ${stderr.slice(-400)}`));
          this.scheduleRestart();
        }
      });
    });
  }

  private emitFrame(frame: Buffer): void {
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) pcm[i] = frame.readInt16LE(i * 2);
    const chunk: AudioChunk = {
      pcm,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      timestampMs: performance.now(),
      sequence: this.sequence++,
    };
    this.emit("chunk", chunk);
  }

  private scheduleRestart(): void {
    this.process = null;
    this.pending = Buffer.alloc(0);
    this.activeBackend = null;
    if (this.restartCount >= this.options.maxRestarts) {
      this.emit("error", new Error("Limite de reinícios da captura atingido"));
      this.stop();
      return;
    }
    this.restartCount += 1;
    this.log(`reiniciando captura em ${this.options.restartDelayMs}ms (tentativa ${this.restartCount})`);
    const timer = setTimeout(() => {
      if (this.running) void this.startInternal().catch((error: unknown) => this.emit("error", error));
    }, this.options.restartDelayMs);
    timer.unref?.();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const proc = this.process;
    this.process = null;
    this.pending = Buffer.alloc(0);
    this.activeBackend = null;
    if (proc) {
      proc.stdout?.removeAllListeners("data");
      proc.kill("SIGTERM");
    }
    this.emit("stopped");
  }

  private log(message: string): void {
    this.options.onLog?.(`[capture] ${message}`);
  }
}

/** Concatena frames em um único Int16Array — útil para alimentar o VAD/STT em lote. */
export function concatFrames(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}
