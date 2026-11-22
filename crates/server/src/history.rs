//! Histórico SQLite (rusqlite) espelhado em JSON — contrato 4.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub id: i64,
    pub texto: String,
    pub gloss: Option<serde_json::Value>,
    pub latency_ms: Option<u64>,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Mirror {
    versao: String,
    exportado_em: String,
    transcricoes: Vec<TranscriptEntry>,
    preferencias: serde_json::Map<String, serde_json::Value>,
}

pub struct HistoryStore {
    conn: Mutex<Connection>,
    json_path: PathBuf,
}

impl HistoryStore {
    pub fn open(db_path: &Path, json_path: PathBuf) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS transcricoes (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 texto TEXT NOT NULL,
                 gloss TEXT,
                 latency_ms INTEGER,
                 source TEXT NOT NULL DEFAULT 'ws',
                 created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS preferencias (
                 chave TEXT PRIMARY KEY,
                 valor TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            json_path,
        })
    }

    pub fn add_transcript(
        &self,
        texto: &str,
        gloss: &serde_json::Value,
        latency_ms: u64,
        source: &str,
    ) -> rusqlite::Result<i64> {
        let now = agora();
        let id = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO transcricoes (texto, gloss, latency_ms, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![texto, gloss.to_string(), latency_ms as i64, source, now],
            )?;
            conn.last_insert_rowid()
        };
        self.mirror();
        Ok(id)
    }

    pub fn list_transcripts(&self, limit: i64) -> Vec<TranscriptEntry> {
        let conn = self.conn.lock().unwrap();
        let mut statement = match conn.prepare(
            "SELECT id, texto, gloss, latency_ms, source, created_at FROM transcricoes ORDER BY id DESC LIMIT ?1",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = statement
            .query_map(params![limit], |row| {
                let gloss_texto: Option<String> = row.get(2)?;
                let gloss = gloss_texto.and_then(|texto| serde_json::from_str(&texto).ok());
                Ok(TranscriptEntry {
                    id: row.get(0)?,
                    texto: row.get(1)?,
                    gloss,
                    latency_ms: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                    source: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .ok();
        rows.map(|iter| iter.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn get_preference(&self, chave: &str) -> Option<serde_json::Value> {
        let conn = self.conn.lock().unwrap();
        let valor: Option<String> = conn
            .query_row("SELECT valor FROM preferencias WHERE chave = ?1", params![chave], |row| row.get(0))
            .ok();
        valor.and_then(|texto| serde_json::from_str(&texto).ok())
    }

    pub fn set_preference(&self, chave: &str, valor: &serde_json::Value) {
        {
            let conn = self.conn.lock().unwrap();
            let _ = conn.execute(
                "INSERT INTO preferencias (chave, valor, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at",
                params![chave, valor.to_string(), agora()],
            );
        }
        self.mirror();
    }

    pub fn json_path(&self) -> &Path {
        &self.json_path
    }

    fn mirror(&self) {
        let conn = self.conn.lock().unwrap();
        let transcricoes: Vec<TranscriptEntry> = conn
            .prepare("SELECT id, texto, gloss, latency_ms, source, created_at FROM transcricoes ORDER BY id DESC LIMIT 500")
            .and_then(|mut statement| {
                let mapped = statement
                    .query_map([], |row| {
                        let gloss_texto: Option<String> = row.get(2)?;
                        let gloss = gloss_texto.and_then(|texto| serde_json::from_str(&texto).ok());
                        Ok(TranscriptEntry {
                            id: row.get(0)?,
                            texto: row.get(1)?,
                            gloss,
                            latency_ms: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                            source: row.get(4)?,
                            created_at: row.get(5)?,
                        })
                    })?
                    .filter_map(Result::ok)
                    .collect();
                Ok(mapped)
            })
            .unwrap_or_default();

        let mut preferencias = serde_json::Map::new();
        if let Ok(mut statement) = conn.prepare("SELECT chave, valor FROM preferencias") {
            if let Ok(rows) = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for row in rows.flatten() {
                    if let Ok(valor) = serde_json::from_str(&row.1) {
                        preferencias.insert(row.0, valor);
                    }
                }
            }
        }
        drop(conn);

        let snapshot = Mirror {
            versao: "1".into(),
            exportado_em: agora(),
            transcricoes,
            preferencias,
        };
        if let Some(parent) = self.json_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let temporario = self.json_path.with_extension("json.tmp");
        if fs::write(&temporario, serde_json::to_string_pretty(&snapshot).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&temporario, &self.json_path);
        }
    }
}

fn agora() -> String {
    let segundos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duracao| duracao.as_secs())
        .unwrap_or(0);
    format!("{}Z", segundos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_history_is_mirrored_to_json() {
        let diretorio = std::env::temp_dir().join(format!("libraslive-history-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&diretorio);
        let db = diretorio.join("history.sqlite");
        let json = diretorio.join("config.json");
        let store = HistoryStore::open(&db, json.clone()).unwrap();

        let gloss = serde_json::json!({"tokens": [], "textoOriginal": "olá"});
        let id = store.add_transcript("olá", &gloss, 321, "ws").unwrap();
        store.set_preference("tamanho", &serde_json::json!(0.8));

        assert!(id > 0);
        let lista = store.list_transcripts(10);
        assert_eq!(lista.len(), 1);
        assert_eq!(lista[0].texto, "olá");
        assert_eq!(lista[0].latency_ms, Some(321));
        assert_eq!(store.get_preference("tamanho"), Some(serde_json::json!(0.8)));

        let espelho: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&json).unwrap()).unwrap();
        assert_eq!(espelho["transcricoes"][0]["texto"], "olá");
        assert_eq!(espelho["preferencias"]["tamanho"], 0.8);

        let _ = fs::remove_dir_all(&diretorio);
    }
}
