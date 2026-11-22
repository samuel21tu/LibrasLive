/**
 * LibrasLive — persistência de histórico e preferências (dono: agente de Áudio/STT "Eco").
 *
 * ============================ CONTRATO 4 — PERSISTÊNCIA ============================
 * SQLite (better-sqlite3) é a fonte de verdade; um JSON espelhado fica em
 * ~/.libraslive/config.json para inspeção/backup e para o renderer ler sem SQLite.
 * Tabelas:
 *   transcricoes(id, texto, gloss JSON, latency_ms, source, created_at)
 *   preferencias(chave TEXT PRIMARY KEY, valor TEXT JSON, updated_at)
 * O espelho JSON usa a forma:
 *   { "versao": "1", "exportado_em": ISO, "transcricoes": [...], "preferencias": {chave: valor} }
 * Se `better-sqlite3` não estiver instalado, usa store JSON puro (implementação real,
 * mesma interface) e registra aviso via onLog. Nenhuma rede; tudo local.
 * ==================================================================================
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TranscriptEntry {
  id: number;
  texto: string;
  gloss: unknown | null;
  latency_ms: number | null;
  source: string;
  created_at: string;
}

export interface HistorySnapshot {
  versao: string;
  exportado_em: string;
  transcricoes: TranscriptEntry[];
  preferencias: Record<string, unknown>;
}

export interface HistoryPaths {
  dbPath: string;
  jsonPath: string;
}

interface SqlStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqlDatabase {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export function getDefaultHistoryPaths(): HistoryPaths {
  const dir = path.join(os.homedir(), ".libraslive");
  return { dbPath: path.join(dir, "history.sqlite"), jsonPath: path.join(dir, "config.json") };
}

export class HistoryStore {
  private db: SqlDatabase | null = null;
  private memory: HistorySnapshot = {
    versao: "1",
    exportado_em: new Date().toISOString(),
    transcricoes: [],
    preferencias: {},
  };
  private nextId = 1;
  private readonly dbPath: string;
  private readonly jsonPath: string;
  private readonly onLog: (message: string) => void;

  constructor(paths: Partial<HistoryPaths> = {}, onLog?: (message: string) => void) {
    const defaults = getDefaultHistoryPaths();
    this.dbPath = paths.dbPath ?? defaults.dbPath;
    this.jsonPath = paths.jsonPath ?? defaults.jsonPath;
    this.onLog = onLog ?? (() => undefined);
  }

  get backend(): "sqlite" | "json" {
    return this.db ? "sqlite" : "json";
  }

  async init(): Promise<this> {
    this.loadMirror();
    try {
      const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
      const module = await dynamicImport("better-sqlite3");
      const DatabaseCtor = module.default ?? module;
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const database = new DatabaseCtor(this.dbPath) as SqlDatabase;
      database.pragma("journal_mode = WAL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS transcricoes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          texto TEXT NOT NULL,
          gloss TEXT,
          latency_ms INTEGER,
          source TEXT NOT NULL DEFAULT 'ws',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS preferencias (
          chave TEXT PRIMARY KEY,
          valor TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db = database;
      const rows = database.prepare("SELECT id, texto, gloss, latency_ms, source, created_at FROM transcricoes ORDER BY id DESC LIMIT 500").all();
      this.memory.transcricoes = rows.map((row) => this.rowToEntry(row));
      this.nextId = Math.max(1, ...this.memory.transcricoes.map((entry) => entry.id + 1));
      this.onLog(`[history] SQLite ativo: ${this.dbPath}`);
    } catch (error) {
      this.db = null;
      this.onLog(`[history] better-sqlite3 indisponível (${String(error)}); usando JSON puro`);
      this.nextId = Math.max(1, ...this.memory.transcricoes.map((entry) => entry.id + 1));
    }
    return this;
  }

  addTranscript(entry: {
    texto: string;
    gloss?: unknown;
    latency_ms?: number | null;
    source?: string;
  }): number {
    const createdAt = new Date().toISOString();
    let id = this.nextId++;
    if (this.db) {
      const result = this.db
        .prepare("INSERT INTO transcricoes (texto, gloss, latency_ms, source, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.texto, entry.gloss === undefined ? null : JSON.stringify(entry.gloss), entry.latency_ms ?? null, entry.source ?? "ws", createdAt);
      id = Number(result.lastInsertRowid);
    }
    this.memory.transcricoes.unshift({
      id,
      texto: entry.texto,
      gloss: entry.gloss ?? null,
      latency_ms: entry.latency_ms ?? null,
      source: entry.source ?? "ws",
      created_at: createdAt,
    });
    if (this.memory.transcricoes.length > 500) this.memory.transcricoes.length = 500;
    this.mirror();
    return id;
  }

  listTranscripts(limit = 50): TranscriptEntry[] {
    if (this.db) {
      return this.db
        .prepare("SELECT id, texto, gloss, latency_ms, source, created_at FROM transcricoes ORDER BY id DESC LIMIT ?")
        .all(limit)
        .map((row) => this.rowToEntry(row));
    }
    return this.memory.transcricoes.slice(0, limit);
  }

  getPreference<T>(key: string, fallback: T): T {
    if (this.db) {
      const row = this.db.prepare("SELECT valor FROM preferencias WHERE chave = ?").get(key);
      if (row?.valor !== undefined) {
        try {
          return JSON.parse(String(row.valor)) as T;
        } catch {
          return fallback;
        }
      }
    }
    const value = this.memory.preferencias[key];
    return value === undefined ? fallback : (value as T);
  }

  setPreference(key: string, value: unknown): void {
    if (this.db) {
      this.db
        .prepare("INSERT INTO preferencias (chave, valor, updated_at) VALUES (?, ?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at")
        .run(key, JSON.stringify(value), new Date().toISOString());
    }
    this.memory.preferencias[key] = value;
    this.mirror();
  }

  getAllPreferences(): Record<string, unknown> {
    return { ...this.memory.preferencias };
  }

  clearTranscripts(): void {
    if (this.db) this.db.prepare("DELETE FROM transcricoes").run();
    this.memory.transcricoes = [];
    this.mirror();
  }

  getSnapshot(): HistorySnapshot {
    return JSON.parse(JSON.stringify(this.memory)) as HistorySnapshot;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private rowToEntry(row: Record<string, unknown>): TranscriptEntry {
    let gloss: unknown = null;
    if (typeof row.gloss === "string" && row.gloss.length > 0) {
      try {
        gloss = JSON.parse(row.gloss);
      } catch {
        gloss = row.gloss;
      }
    }
    return {
      id: Number(row.id),
      texto: String(row.texto),
      gloss,
      latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      source: String(row.source ?? "ws"),
      created_at: String(row.created_at ?? new Date().toISOString()),
    };
  }

  private loadMirror(): void {
    try {
      if (!fs.existsSync(this.jsonPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8")) as Partial<HistorySnapshot>;
      if (Array.isArray(parsed.transcricoes)) this.memory.transcricoes = parsed.transcricoes;
      if (parsed.preferencias && typeof parsed.preferencias === "object") this.memory.preferencias = parsed.preferencias;
    } catch (error) {
      this.onLog(`[history] falha ao ler espelho JSON: ${String(error)}`);
    }
  }

  private mirror(): void {
    this.memory.exportado_em = new Date().toISOString();
    const temp = `${this.jsonPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(this.memory, null, 2), "utf8");
      fs.renameSync(temp, this.jsonPath);
    } catch (error) {
      this.onLog(`[history] falha ao espelhar JSON: ${String(error)}`);
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        /* melhor esforço */
      }
    }
  }
}

/** Fábrica conveniente: cria e inicializa o store. */
export async function createHistoryStore(
  paths?: Partial<HistoryPaths>,
  onLog?: (message: string) => void,
): Promise<HistoryStore> {
  return new HistoryStore(paths, onLog).init();
}
