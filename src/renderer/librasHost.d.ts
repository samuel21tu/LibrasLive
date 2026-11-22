/**
 * Declaração global da ponte canônica injetada pelo shell Tauri no index.html.
 * Substitui a antiga declaração de `window.electronAPI` (Electron removido).
 */
import type { LibrasHost } from "./host";

declare global {
  interface Window {
    librasHost?: LibrasHost;
  }
}

export {};
