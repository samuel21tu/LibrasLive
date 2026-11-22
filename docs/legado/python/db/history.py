"""Histórico SQLite espelhado em JSON (dono: agente de Áudio/STT).

SQLite é a fonte de verdade; ~/.libraslive/config.json é o espelho legível.
Thread-safe (o WebSocket chama estes métodos via threads do executor).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

MAX_ROWS = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class HistoryStore:
    def __init__(self, db_path: Optional[Path] = None, json_path: Optional[Path] = None) -> None:
        base = Path.home() / ".libraslive"
        self.db_path = Path(db_path) if db_path else base / "history.sqlite"
        self.json_path = Path(json_path) if json_path else base / "config.json"
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._memory: dict[str, Any] = {
            "versao": "1",
            "exportado_em": _now(),
            "transcricoes": [],
            "preferencias": {},
        }

    @property
    def backend(self) -> str:
        return "sqlite" if self._conn else "json"

    def init(self) -> "HistoryStore":
        with self._lock:
            self._load_mirror()
            try:
                self.db_path.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode = WAL")
                conn.executescript(
                    """
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
                    """
                )
                conn.commit()
                self._conn = conn
                self._sync_memory()
            except sqlite3.Error:
                self._conn = None
            return self

    def add_transcript(
        self,
        texto: str,
        gloss: Any = None,
        latency_ms: Optional[int] = None,
        source: str = "ws",
    ) -> int:
        with self._lock:
            record_id = 0
            if self._conn is not None:
                cursor = self._conn.execute(
                    "INSERT INTO transcricoes (texto, gloss, latency_ms, source, created_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        texto,
                        None if gloss is None else json.dumps(gloss, ensure_ascii=False),
                        latency_ms,
                        source,
                        _now(),
                    ),
                )
                self._conn.commit()
                record_id = int(cursor.lastrowid)
            else:
                record_id = 1 + max((int(row.get("id", 0)) for row in self._memory["transcricoes"]), default=0)
                self._memory["transcricoes"].insert(0, {
                    "id": record_id,
                    "texto": texto,
                    "gloss": gloss,
                    "latency_ms": latency_ms,
                    "source": source,
                    "created_at": _now(),
                })
                del self._memory["transcricoes"][MAX_ROWS:]
            self._sync_memory()
            self._write_mirror()
            return record_id

    def list_transcripts(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            return self._memory["transcricoes"][:limit]

    def get_preference(self, key: str, default: Any = None) -> Any:
        with self._lock:
            if self._conn is not None:
                row = self._conn.execute("SELECT valor FROM preferencias WHERE chave = ?", (key,)).fetchone()
                if row is not None:
                    try:
                        return json.loads(row["valor"])
                    except (TypeError, ValueError):
                        return default
            return self._memory["preferencias"].get(key, default)

    def set_preference(self, key: str, value: Any) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.execute(
                    "INSERT INTO preferencias (chave, valor, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at",
                    (key, json.dumps(value, ensure_ascii=False), _now()),
                )
                self._conn.commit()
                rows = self._conn.execute("SELECT chave, valor FROM preferencias").fetchall()
                self._memory["preferencias"] = {
                    row["chave"]: _safe_json(row["valor"]) for row in rows
                }
            else:
                self._memory["preferencias"][key] = value
            self._write_mirror()

    def clear_transcripts(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.execute("DELETE FROM transcricoes")
                self._conn.commit()
            self._memory["transcricoes"] = []
            self._write_mirror()

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._memory, ensure_ascii=False))

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def _sync_memory(self) -> None:
        if self._conn is None:
            return
        rows = self._conn.execute(
            "SELECT id, texto, gloss, latency_ms, source, created_at "
            "FROM transcricoes ORDER BY id DESC LIMIT ?",
            (MAX_ROWS,),
        ).fetchall()
        self._memory["transcricoes"] = [
            {
                "id": int(row["id"]),
                "texto": row["texto"],
                "gloss": _safe_json(row["gloss"]),
                "latency_ms": row["latency_ms"],
                "source": row["source"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
        prefs = self._conn.execute("SELECT chave, valor FROM preferencias").fetchall()
        self._memory["preferencias"] = {row["chave"]: _safe_json(row["valor"]) for row in prefs}

    def _load_mirror(self) -> None:
        try:
            if not self.json_path.exists():
                return
            data = json.loads(self.json_path.read_text(encoding="utf-8"))
            if isinstance(data.get("transcricoes"), list):
                self._memory["transcricoes"] = data["transcricoes"]
            if isinstance(data.get("preferencias"), dict):
                self._memory["preferencias"] = data["preferencias"]
        except (OSError, ValueError, AttributeError):
            pass

    def _write_mirror(self) -> None:
        self._memory["exportado_em"] = _now()
        temp = self.json_path.with_suffix(".json.tmp")
        try:
            self.json_path.parent.mkdir(parents=True, exist_ok=True)
            temp.write_text(json.dumps(self._memory, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(str(temp), str(self.json_path))
        except OSError:
            try:
                if temp.exists():
                    temp.unlink()
            except OSError:
                pass


def _safe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value
