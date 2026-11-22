import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // O webview do Tauri carrega os arquivos por protocolo proprio; caminhos relativos.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
});
