import { defineConfig } from "vitest/config";

/**
 * Config isolada do Vitest para os testes de NLP/Lexicon.
 * Tem prioridade sobre vite.config.ts, que pertence ao scaffold do renderer
 * e depende de @vitejs/plugin-react (não necessário para testes Node).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
