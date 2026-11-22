/**
 * Fila de animação sincronizada com `duracao_ms` de cada sinal.
 *
 * A fila é um objeto mutável de propósito: o Avatar lê `advance(deltaMs)` a
 * cada frame via `useFrame`, sem causar re-render do React. A UI se inscreve
 * em `subscribe` para receber progresso a cada ~90ms.
 */

import type { GlossResult, SignPose } from "../types";
import {
  buildClips,
  neutralFrame,
  sampleClip,
  type PoseFrame,
  type RetargetedClip,
} from "./retarget";

export type QueueProgress = {
  /** gloss do sinal atual (ou null se a fila estiver vazia) */
  gloss: string | null;
  /** 1-based; 0 quando vazia */
  index: number;
  /** quantidade de clipes restantes, incluindo o atual */
  restantes: number;
  /** progresso do clipe atual, 0..1 */
  clipProgress: number;
  isPlaying: boolean;
  textoOriginal: string;
};

type Listener = (progress: QueueProgress) => void;

const PROGRESS_INTERVAL_MS = 90;
const MAX_FRAME_DELTA_MS = 120;

export class AnimationQueue {
  private clips: RetargetedClip[] = [];
  private active = -1;
  private elapsed = 0;
  private lexicon: Record<string, SignPose> = {};
  private reducedMotion = false;
  private listeners = new Set<Listener>();
  private sinceNotify = 0;
  private finishHandler: (() => void) | null = null;
  private textoOriginal = "";
  private concludedThisTick = 0;

  /** Substitui o mapa de poses. Mescla com o fixture para nunca ficar vazia. */
  setLexicon(lexicon: Record<string, SignPose>): void {
    this.lexicon = lexicon ?? {};
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  onFinish(handler: (() => void) | null): void {
    this.finishHandler = handler;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.progress);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Enfileira todos os clipes de um GlossResult. Retorna a quantidade adicionada. */
  enqueue(resultado: GlossResult): number {
    if (!resultado || !Array.isArray(resultado.tokens)) return 0;
    const novos = buildClips(resultado, this.lexicon);
    if (novos.length === 0) return 0;
    this.clips.push(...novos);
    this.textoOriginal = resultado.textoOriginal ?? "";
    this.notify(true);
    return novos.length;
  }

  /** Pula o sinal atual e começa o próximo imediatamente. */
  next(): void {
    if (this.active >= 0 && this.active < this.clips.length) this.clips.splice(this.active, 1);
    this.elapsed = 0;
    if (this.active >= this.clips.length) this.active = -1;
    this.notify(true);
  }

  /** Limpa toda a fila e volta ao estado idle. */
  clear(): void {
    this.clips = [];
    this.active = -1;
    this.elapsed = 0;
    this.concludedThisTick = 0;
    this.textoOriginal = "";
    this.notify(true);
  }

  get isEmpty(): boolean {
    return this.clips.length === 0;
  }

  get progress(): QueueProgress {
    const restantes = Math.max(0, this.clips.length - Math.max(0, this.active));
    const ativo = this.active >= 0 ? this.clips[this.active] : undefined;
    return {
      gloss: ativo ? ativo.gloss : null,
      index: ativo ? this.active + 1 : 0,
      restantes,
      clipProgress: ativo ? Math.min(1, this.elapsed / ativo.duracao_ms) : 0,
      isPlaying: Boolean(ativo),
      textoOriginal: this.textoOriginal,
    };
  }

  /**
   * Avança a linha do tempo e devolve o frame já interpolado.
   * @param deltaMs milissegundos decorridos desde o último frame
   */
  advance(deltaMs: number): PoseFrame {
    const delta = Math.max(0, Math.min(deltaMs, MAX_FRAME_DELTA_MS));
    this.concludedThisTick = 0;

    if (this.active < 0 && this.clips.length > 0) {
      this.active = 0;
      this.elapsed = 0;
    }

    if (this.active < 0) {
      this.notify(false, delta);
      return neutralFrame();
    }

    let clip = this.clips[this.active];
    this.elapsed += delta;

    while (clip && this.elapsed >= Math.max(1, clip.duracao_ms)) {
      this.elapsed -= Math.max(1, clip.duracao_ms);
      this.concludedThisTick += 1;
      this.clips.splice(this.active, 1);
      if (this.active >= this.clips.length) {
        this.active = -1;
        break;
      }
      clip = this.clips[this.active];
    }

    if (this.active < 0 || !clip) {
      if (this.concludedThisTick > 0 && this.finishHandler) this.finishHandler();
      this.notify(true);
      return neutralFrame();
    }

    const t = Math.min(1, this.elapsed / clip.duracao_ms);
    const frame = sampleClip(clip, t, this.reducedMotion);
    this.notify(false, delta);
    return frame;
  }

  private notify(force: boolean, deltaMs = 0): void {
    this.sinceNotify += deltaMs;
    if (!force && this.sinceNotify < PROGRESS_INTERVAL_MS) return;
    this.sinceNotify = 0;
    const progress = this.progress;
    for (const listener of this.listeners) listener(progress);
  }
}
