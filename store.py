"""Storage layer.

Local development uses SQLite (a file next to the app). Production on Vercel uses
Firebase Firestore, because Vercel's filesystem is read-only. The backend is chosen
automatically: if a Firebase service account is configured, Firestore is used.

Every visitor gets a private space (keyed by a cookie), so people who open the public
link never see each other's emails.
"""

import base64
import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from contextvars import ContextVar
from pathlib import Path
from typing import Optional

# Set per request by main.py. SQLite ignores it (one local user).
current_user: ContextVar[str] = ContextVar("current_user", default="local")

EMAILS_SCHEMA = """
CREATE TABLE IF NOT EXISTS emails (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_name TEXT NOT NULL,
    purpose        TEXT NOT NULL,
    tone           TEXT NOT NULL,
    length         TEXT NOT NULL,
    language       TEXT NOT NULL,
    subject        TEXT NOT NULL,
    body           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'new',
    source_text    TEXT NOT NULL DEFAULT '',
    pinned         INTEGER NOT NULL DEFAULT 0,
    tags           TEXT NOT NULL DEFAULT '',
    quality        INTEGER
)
"""
TEMPLATES_SCHEMA = """
CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    tone       TEXT NOT NULL,
    length     TEXT NOT NULL,
    language   TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""
SETTINGS_SCHEMA = "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
# Columns added after the first version; lets an older emails.db upgrade itself.
EMAIL_MIGRATIONS = {
    "kind": "kind TEXT NOT NULL DEFAULT 'new'",
    "source_text": "source_text TEXT NOT NULL DEFAULT ''",
    "pinned": "pinned INTEGER NOT NULL DEFAULT 0",
    "tags": "tags TEXT NOT NULL DEFAULT ''",
    "quality": "quality INTEGER",
}
# Fields an update is allowed to touch.
UPDATABLE = {"subject", "body", "language", "quality", "pinned", "tags"}


def _email_from_row(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["pinned"] = bool(data["pinned"])
    data["tags"] = [tag for tag in data["tags"].split(",") if tag]
    return data


def filter_emails(rows: list[dict], q: str, tag: str, pinned: bool) -> list[dict]:
    """The same filtering SQLite does in SQL, for stores that can't do it in the query."""
    q = q.strip().lower()
    tag = tag.strip().lower()
    result = []
    for row in rows:
        if pinned and not row["pinned"]:
            continue
        if tag and tag not in row["tags"]:
            continue
        if q:
            haystack = " ".join(str(row[key]) for key in ("subject", "recipient_name", "purpose", "body", "source_text")).lower()
            if q not in haystack:
                continue
        result.append(row)
    return result


# --------------------------------------------------------------------------
# SQLite (local development)
# --------------------------------------------------------------------------
class SqliteStore:
    name = "sqlite"

    def __init__(self, path):
        self.path = Path(path)
        self._ready = False
        self._lock = threading.Lock()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        if not self._ready:
            with self._lock:
                if not self._ready:
                    with conn:
                        conn.execute(EMAILS_SCHEMA)
                        conn.execute(TEMPLATES_SCHEMA)
                        conn.execute(SETTINGS_SCHEMA)
                        existing = {row["name"] for row in conn.execute("PRAGMA table_info(emails)")}
                        for column, ddl in EMAIL_MIGRATIONS.items():
                            if column not in existing:
                                conn.execute(f"ALTER TABLE emails ADD COLUMN {ddl}")
                    self._ready = True
        return conn

    def init(self) -> None:
        with closing(self._conn()):
            pass

    # emails
    def email_get(self, email_id: int) -> Optional[dict]:
        with closing(self._conn()) as conn:
            row = conn.execute("SELECT * FROM emails WHERE id = ?", (email_id,)).fetchone()
        return _email_from_row(row) if row else None

    def email_insert(self, fields: dict) -> dict:
        with closing(self._conn()) as conn, conn:
            cursor = conn.execute(
                "INSERT INTO emails (recipient_name, purpose, tone, length, language, subject, body, "
                "created_at, kind, source_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    fields["recipient_name"], fields["purpose"], fields["tone"], fields["length"],
                    fields["language"], fields["subject"], fields["body"], fields["created_at"],
                    fields["kind"], fields["source_text"],
                ),
            )
            email_id = cursor.lastrowid
        return self.email_get(email_id)

    def email_update(self, email_id: int, fields: dict) -> None:
        unknown = set(fields) - UPDATABLE
        if unknown or not fields:
            raise ValueError(f"Cannot update fields: {sorted(unknown) or 'none given'}")
        values = []
        for key, value in fields.items():
            if key == "tags":
                value = ",".join(value)
            elif key == "pinned":
                value = int(value)
            values.append(value)
        assignments = ", ".join(f"{key} = ?" for key in fields)  # keys are whitelisted above
        with closing(self._conn()) as conn, conn:
            conn.execute(f"UPDATE emails SET {assignments} WHERE id = ?", (*values, email_id))

    def email_delete(self, email_id: int) -> None:
        with closing(self._conn()) as conn, conn:
            conn.execute("DELETE FROM emails WHERE id = ?", (email_id,))

    def email_clear(self) -> None:
        with closing(self._conn()) as conn, conn:
            conn.execute("DELETE FROM emails")

    def email_list(self, q: str, tag: str, pinned: bool, limit: int = 200) -> list[dict]:
        clauses: list[str] = []
        params: list = []
        if q.strip():
            like = f"%{q.strip()}%"
            clauses.append(
                "(subject LIKE ? OR recipient_name LIKE ? OR purpose LIKE ? OR body LIKE ? OR source_text LIKE ?)"
            )
            params += [like, like, like, like, like]
        if tag.strip():
            clauses.append("(',' || tags || ',') LIKE ?")
            params.append(f"%,{tag.strip().lower()},%")
        if pinned:
            clauses.append("pinned = 1")
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(self._conn()) as conn:
            rows = conn.execute(
                f"SELECT * FROM emails{where} ORDER BY pinned DESC, id DESC LIMIT ?", (*params, limit)
            ).fetchall()
        return [_email_from_row(row) for row in rows]

    def email_all(self) -> list[dict]:
        with closing(self._conn()) as conn:
            rows = conn.execute("SELECT * FROM emails").fetchall()
        return [_email_from_row(row) for row in rows]

    # templates
    def template_list(self) -> list[dict]:
        with closing(self._conn()) as conn:
            rows = conn.execute("SELECT * FROM templates ORDER BY id DESC").fetchall()
        return [dict(row) for row in rows]

    def template_count(self) -> int:
        with closing(self._conn()) as conn:
            return conn.execute("SELECT COUNT(*) FROM templates").fetchone()[0]

    def template_insert(self, fields: dict) -> dict:
        with closing(self._conn()) as conn, conn:
            cursor = conn.execute(
                "INSERT INTO templates (name, purpose, tone, length, language, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (fields["name"], fields["purpose"], fields["tone"], fields["length"], fields["language"], fields["created_at"]),
            )
            row = conn.execute("SELECT * FROM templates WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return dict(row)

    def template_delete(self, template_id: int) -> None:
        with closing(self._conn()) as conn, conn:
            conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))

    # settings
    def settings_get(self) -> Optional[dict]:
        with closing(self._conn()) as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = 'app'").fetchone()
        if not row:
            return None
        try:
            data = json.loads(row["value"])
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def settings_put(self, data: dict) -> None:
        with closing(self._conn()) as conn, conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('app', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(data),),
            )


# --------------------------------------------------------------------------
# Firestore (production on Vercel)
# --------------------------------------------------------------------------
def _new_id() -> int:
    # Microseconds since the epoch: unique enough for one person, sorts by creation time,
    # and small enough (about 1.8e15) to stay exact as a JavaScript number.
    return time.time_ns() // 1000


class FirestoreStore:
    name = "firestore"

    def __init__(self, info: dict):
        from google.cloud import firestore
        from google.oauth2 import service_account

        credentials = service_account.Credentials.from_service_account_info(info)
        self.db = firestore.Client(project=info.get("project_id"), credentials=credentials)

    def init(self) -> None:
        pass  # collections are created on first write

    def _user(self):
        return self.db.collection("users").document(current_user.get())

    def _emails(self):
        return self._user().collection("emails")

    def _templates(self):
        return self._user().collection("templates")

    @staticmethod
    def _create(collection, fields: dict) -> dict:
        from google.api_core.exceptions import AlreadyExists

        for _ in range(5):
            new_id = _new_id()
            doc = {**fields, "id": new_id}
            try:
                collection.document(str(new_id)).create(doc)
                return doc
            except AlreadyExists:
                time.sleep(0.001)
        raise RuntimeError("Could not allocate a unique id")

    @staticmethod
    def _email_defaults(data: dict) -> dict:
        data.setdefault("quality", None)
        data.setdefault("pinned", False)
        data.setdefault("tags", [])
        data.setdefault("source_text", "")
        data.setdefault("kind", "new")
        return data

    # emails
    def email_get(self, email_id: int) -> Optional[dict]:
        snap = self._emails().document(str(email_id)).get()
        return self._email_defaults(snap.to_dict()) if snap.exists else None

    def email_insert(self, fields: dict) -> dict:
        doc = {**fields, "pinned": False, "tags": [], "quality": None}
        return self._create(self._emails(), doc)

    def email_update(self, email_id: int, fields: dict) -> None:
        from google.api_core.exceptions import NotFound

        unknown = set(fields) - UPDATABLE
        if unknown or not fields:
            raise ValueError(f"Cannot update fields: {sorted(unknown) or 'none given'}")
        try:
            self._emails().document(str(email_id)).update(fields)
        except NotFound:
            pass

    def email_delete(self, email_id: int) -> None:
        self._emails().document(str(email_id)).delete()

    def email_clear(self) -> None:
        refs = [snap.reference for snap in self._emails().stream()]
        for start in range(0, len(refs), 400):
            batch = self.db.batch()
            for ref in refs[start : start + 400]:
                batch.delete(ref)
            batch.commit()

    def email_all(self) -> list[dict]:
        return [self._email_defaults(snap.to_dict()) for snap in self._emails().stream()]

    def email_list(self, q: str, tag: str, pinned: bool, limit: int = 200) -> list[dict]:
        rows = filter_emails(self.email_all(), q, tag, pinned)
        rows.sort(key=lambda row: (row["pinned"], row["id"]), reverse=True)
        return rows[:limit]

    # templates
    def template_list(self) -> list[dict]:
        rows = [snap.to_dict() for snap in self._templates().stream()]
        rows.sort(key=lambda row: row["id"], reverse=True)
        return rows

    def template_count(self) -> int:
        return sum(1 for _ in self._templates().stream())

    def template_insert(self, fields: dict) -> dict:
        return self._create(self._templates(), dict(fields))

    def template_delete(self, template_id: int) -> None:
        self._templates().document(str(template_id)).delete()

    # settings
    def _settings_ref(self):
        return self._user().collection("meta").document("settings")

    def settings_get(self) -> Optional[dict]:
        snap = self._settings_ref().get()
        return snap.to_dict() if snap.exists else None

    def settings_put(self, data: dict) -> None:
        self._settings_ref().set(data)


# --------------------------------------------------------------------------
# Choosing a backend
# --------------------------------------------------------------------------
REQUIRED_KEYS = ("project_id", "client_email", "private_key")


def load_service_account() -> Optional[dict]:
    """Reads the Firebase service account from the environment, or returns None."""
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT", "").strip()
    encoded = os.getenv("FIREBASE_SERVICE_ACCOUNT_B64", "").strip()
    path = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
    try:
        if raw:
            info = json.loads(raw)
        elif encoded:
            info = json.loads(base64.b64decode(encoded).decode("utf-8"))
        elif path:
            info = json.loads(Path(path).read_text(encoding="utf-8"))
        else:
            return None
    except (ValueError, OSError) as exc:
        raise RuntimeError(
            "The Firebase service account could not be read. Check FIREBASE_SERVICE_ACCOUNT_B64 "
            "(or FIREBASE_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT_FILE)."
        ) from exc
    if not isinstance(info, dict) or any(key not in info for key in REQUIRED_KEYS):
        raise RuntimeError(
            "The Firebase service account is missing project_id, client_email or private_key. "
            "Download a fresh key from Firebase console > Project settings > Service accounts."
        )
    return info


def build_store(sqlite_path):
    info = load_service_account()
    return FirestoreStore(info) if info else SqliteStore(sqlite_path)
