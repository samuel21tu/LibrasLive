/**
 * Ponte renderer ↔ shell Tauri 2 (substitui o antigo `window.electronAPI`).
 *
 * Comandos Rust expostos em `src-tauri/src/lib.rs` (via `invoke_handler`):
 *   get_state, move_corner, cycle_corner, resize_window, drag_window,
 *   set_opacity, set_ignore_mouse, set_always_on_top, get_config,
 *   set_config, minimize, close_window, start_backend.
 *
 * Ordem de resolução de cada chamada:
 *   1. `invoke()` do @tauri-apps/api quando rodando dentro do Tauri;
 *   2. bridge legado `window.electronAPI` (index.html) quando presente;
 *   3. no-op seguro (demo no navegador, sem shell e sem bridge).
 *
 * Nenhuma chamada lança exceção para o renderer: falhas de IPC são engolidas
 * e viram `null`/no-op, mantendo a demo visual funcional.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PanelConfig } from "./types";

/** Espelho do `OverlayState` serializado por `src-tauri/src/lib.rs`. */
export type OverlayState = {
  corner: PanelConfig["canto"];
  size: { width: number; height: number };
  alwaysOnTop: boolean;
  ignoreMouse: boolean;
  opacity: number;
  platform: string;
  backendRunning: boolean;
};

export type LibrasHost = {
  /** true quando o invoke do Tauri está disponível */
  readonly isTauri: boolean;
  getConfig(): Promise<PanelConfig | null>;
  setConfig(config: PanelConfig): void;
  setAlwaysOnTop(value: boolean): void;
  setOpacity(opacity: number): void;
  resize(width: number, height: number): void;
  moveCorner(corner: PanelConfig["canto"]): void;
  cycleCorner(): void;
  setIgnoreMouse(ignore: boolean): void;
  getState(): Promise<OverlayState | null>;
  minimize(): void;
  close(): void;
  drag(deltaX: number, deltaY: number): void;
  startBackend(): void;
};

/** Bridge legada do index.html, usada apenas fora do Tauri. */
type LegacyBridge = {
  getConfig?: () => Promise<Partial<PanelConfig> | null>;
  setConfig?: (config: PanelConfig) => void;
  setAlwaysOnTop?: (value: boolean) => void;
  minimize?: () => void;
  close?: () => void;
  drag?: (deltaX: number, deltaY: number) => void;
};

function legado(): LegacyBridge | undefined {
  return (escopo as Window & { electronAPI?: LegacyBridge }).electronAPI;
}

export const CONFIG_PADRAO: PanelConfig = {
  tamanho: 1,
  opacidade: 0.96,
  canto: "superior-direito",
  alwaysOnTop: true,
};

const CANTOS: readonly PanelConfig["canto"][] = [
  "superior-direito",
  "superior-esquerdo",
  "inferior-direito",
  "inferior-esquerdo",
];

/** Permite importar o módulo até em testes Node (sem `window`). */
const escopo: Window =
  typeof window !== "undefined" ? window : (globalThis as unknown as Window);

function limitar(valor: number, min: number, max: number, padrao: number): number {
  return Number.isFinite(valor) ? Math.min(max, Math.max(min, valor)) : padrao;
}

/** Aceita tanto o PanelConfig do Rust (camelCase) quanto um objeto parcial. */
function normalizarConfig(valor: unknown): PanelConfig {
  if (!valor || typeof valor !== "object") return { ...CONFIG_PADRAO };
  const bruto = valor as Partial<PanelConfig> & { canto?: unknown };
  const canto =
    typeof bruto.canto === "string" && CANTOS.includes(bruto.canto as PanelConfig["canto"])
      ? (bruto.canto as PanelConfig["canto"])
      : CONFIG_PADRAO.canto;
  return {
    tamanho: limitar(Number(bruto.tamanho), 0.6, 1.6, CONFIG_PADRAO.tamanho),
    opacidade: limitar(Number(bruto.opacidade), 0.3, 1, CONFIG_PADRAO.opacidade),
    canto,
    alwaysOnTop:
      typeof bruto.alwaysOnTop === "boolean" ? bruto.alwaysOnTop : CONFIG_PADRAO.alwaysOnTop,
  };
}

/** `isTauri()` cobre o runtime; `__TAURI_INTERNALS__` cobre init scripts antigos. */
function detectarTauri(): boolean {
  if (isTauri()) return true;
  const internals = (escopo as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  return typeof internals !== "undefined";
}

async function chamar<T>(comando: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!detectarTauri()) return null;
  try {
    return await invoke<T>(comando, args);
  } catch {
    return null;
  }
}

function executar(comando: string, args?: Record<string, unknown>, legado?: () => void): void {
  if (detectarTauri()) {
    void chamar(comando, args);
    return;
  }
  try {
    legado?.();
  } catch {
    // bridge ausente ou quebrada: segue como no-op
  }
}

function criarHost(): LibrasHost {
  const tauri = detectarTauri();

  return {
    isTauri: tauri,

    async getConfig() {
      const resposta = await chamar<PanelConfig>("get_config");
      if (resposta) return normalizarConfig(resposta);
      const antigo = legado()?.getConfig;
      if (antigo) {
        try {
          const config = await antigo();
          return config ? normalizarConfig(config) : null;
        } catch {
          return null;
        }
      }
      return null;
    },

    setConfig(config) {
      executar("set_config", { config }, () => legado()?.setConfig?.(config));
    },

    setAlwaysOnTop(value) {
      executar("set_always_on_top", { value }, () => legado()?.setAlwaysOnTop?.(value));
    },

    setOpacity(opacity) {
      executar("set_opacity", { opacity });
    },

    resize(width, height) {
      executar("resize_window", { width, height });
    },

    moveCorner(corner) {
      executar("move_corner", { corner });
    },

    cycleCorner() {
      executar("cycle_corner");
    },

    setIgnoreMouse(ignore) {
      executar("set_ignore_mouse", { ignore });
    },

    async getState() {
      return chamar<OverlayState>("get_state");
    },

    minimize() {
      executar("minimize", undefined, () => legado()?.minimize?.());
    },

    close() {
      executar("close_window", undefined, () => legado()?.close?.());
    },

    drag(deltaX, deltaY) {
      executar("drag_window", { deltaX, deltaY }, () => legado()?.drag?.(deltaX, deltaY));
    },

    startBackend() {
      executar("start_backend");
    },
  };
}

/** Host canônico; um host injetado externamente pode sobrescrever métodos. */
const externo = escopo.librasHost;
export const librasHost: LibrasHost = externo ? { ...criarHost(), ...externo } : criarHost();

// O host canônico injetado pelo index.html pode ser congelado; nesse caso o
// merge acima já garante todos os métodos e a reatribuição pode ser ignorada.
try {
  escopo.librasHost = librasHost;
} catch {
  // mantém o objeto externo imutável como ponte ativa
}
