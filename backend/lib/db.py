import hashlib
import hmac
import ipaddress
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"{salt}:{digest}"


def password_matches(password: str, encoded: str) -> bool:
    return hmac.compare_digest(password_hash(password, encoded.split(":")[0]), encoded)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def ip_address(value):
    if not isinstance(value, str):
        return None
    try:
        address = ipaddress.ip_address(value)
        return str(getattr(address, 'ipv4_mapped', None) or address)
    except (ValueError, TypeError):
        return None


class Database:
    def __init__(self, path: Path, password: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
                    arch TEXT NOT NULL, version TEXT NOT NULL, last_seen REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, time REAL NOT NULL, trace_id TEXT NOT NULL,
                    device_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS device_connections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
                    connected_at REAL NOT NULL, last_seen REAL NOT NULL,
                    disconnected_at REAL, reason TEXT
                );
                CREATE INDEX IF NOT EXISTS device_connections_device_id
                    ON device_connections(device_id, id DESC);
                CREATE TABLE IF NOT EXISTS device_networks (
                    device_id TEXT PRIMARY KEY, source_ip TEXT,
                    local_addresses TEXT NOT NULL DEFAULT '[]', public_ip TEXT,
                    reported_at REAL
                );
                CREATE TABLE IF NOT EXISTS device_systems (
                    device_id TEXT PRIMARY KEY, os TEXT, distribution_id TEXT, kernel_version TEXT
                );
            """)
            columns = {row['name'] for row in db.execute('PRAGMA table_info(audit)')}
            for column, definition in [('target', "TEXT NOT NULL DEFAULT ''"), ('duration_ms', 'REAL'), ('source_ip', 'TEXT')]:
                if column not in columns:
                    db.execute(f'ALTER TABLE audit ADD COLUMN {column} {definition}')
            db.execute('CREATE INDEX IF NOT EXISTS audit_request ON audit(trace_id, device_id, action, id)')
            db.execute("UPDATE audit SET status='interrupted' WHERE status='started'")
            db.execute("""UPDATE device_connections SET disconnected_at=last_seen,
                reason='controller_restart' WHERE disconnected_at IS NULL""")
            existing = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()
            # Password changes revoke sessions.
            if not existing or not password_matches(password, existing[0]):
                db.execute("INSERT OR REPLACE INTO settings VALUES ('password', ?)", (password_hash(password),))
                db.execute("DELETE FROM sessions")
        path.chmod(0o600)

    @contextmanager
    def connect(self):
        with sqlite3.connect(self.path, timeout=10) as db:
            db.row_factory = sqlite3.Row
            yield db

    def verify_password(self, password):
        with self.connect() as db:
            encoded = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()[0]
        return password_matches(password, encoded)

    def audit(self, trace_id, device_id, action, status, detail="", target="", source_ip=None):
        with self.connect() as db:
            return db.execute("""INSERT INTO audit(time,trace_id,device_id,action,status,detail,target,source_ip)
                VALUES (?,?,?,?,?,?,?,?)""", (time.time(), trace_id, device_id, action, status, str(detail)[:1000],
                                              str(target)[:1000], source_ip)).lastrowid

    def finish_audit(self, audit_id, status, detail, duration_ms):
        with self.connect() as db:
            db.execute('UPDATE audit SET status=?, detail=?, duration_ms=? WHERE id=?',
                       (status, str(detail)[:1000], round(duration_ms, 1), audit_id))

    def upsert_device(self, info, source_ip=None):
        with self.connect() as db:
            db.execute("""INSERT INTO devices VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, platform=excluded.platform, arch=excluded.arch,
                version=excluded.version, last_seen=excluded.last_seen""",
                       (info["id"], info["name"], info["platform"], info["arch"], info["version"], time.time()))
            db.execute("""INSERT INTO device_networks(device_id, source_ip) VALUES (?,?)
                ON CONFLICT(device_id) DO UPDATE SET source_ip=excluded.source_ip""", (info['id'], ip_address(source_ip)))

    def update_networks(self, device_id, result):
        if not isinstance(result, dict) or 'local_addresses' not in result:
            return
        addresses = []
        if isinstance(result['local_addresses'], list):
            for item in result['local_addresses'][:128]:
                if not isinstance(item, dict):
                    continue
                address = ip_address(item.get('address'))
                name = item.get('interface')
                if address and isinstance(name, str) and 0 < len(name) <= 128:
                    addresses.append({'interface': name, 'address': address})
        public = ip_address(result.get('public_ip')) if 'public_ip' in result else None
        if public and not ipaddress.ip_address(public).is_global:
            public = None
        with self.connect() as db:
            if 'public_ip' in result:
                db.execute("""UPDATE device_networks SET local_addresses=?, public_ip=?, reported_at=?
                    WHERE device_id=?""", (json.dumps(addresses), public, time.time(), device_id))
            else:
                db.execute("""UPDATE device_networks SET local_addresses=?, reported_at=?
                    WHERE device_id=?""", (json.dumps(addresses), time.time(), device_id))

    def update_system(self, device_id, result):
        if not isinstance(result, dict):
            return
        values = [result.get(key) for key in ('os', 'distribution_id', 'kernel_version')]
        values = [value.strip() if isinstance(value, str) and 0 < len(value.strip()) <= 256
                  else None for value in values]
        if not any(values):
            return
        with self.connect() as db:
            db.execute("""INSERT INTO device_systems(device_id, os, distribution_id, kernel_version)
                VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
                os=COALESCE(excluded.os, device_systems.os),
                distribution_id=COALESCE(excluded.distribution_id, device_systems.distribution_id),
                kernel_version=COALESCE(excluded.kernel_version, device_systems.kernel_version)""",
                       (device_id, *values))

    def touch_device(self, device_id):
        with self.connect() as db:
            db.execute("UPDATE devices SET last_seen=? WHERE id=?", (time.time(), device_id))

    def delete_device(self, device_id):
        """Remove a device and its controller-owned state.

        Audit records intentionally remain so that administrative history is
        still available after a stale device is removed.
        """
        with self.connect() as db:
            row = db.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
            if not row:
                return None
            for table in ('device_networks', 'device_systems', 'device_connections'):
                db.execute(f"DELETE FROM {table} WHERE device_id=?", (device_id,))
            # Upgrade storage is initialized after Database construction, so
            # keep this method usable in standalone database tests too.
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_upgrades'").fetchone():
                db.execute("DELETE FROM device_upgrades WHERE device_id=?", (device_id,))
            db.execute("DELETE FROM devices WHERE id=?", (device_id,))
            return dict(row)

    def start_connection(self, device_id):
        now = time.time()
        with self.connect() as db:
            db.execute("""UPDATE device_connections SET disconnected_at=?, reason='reconnected'
                WHERE device_id=? AND disconnected_at IS NULL""", (now, device_id))
            return db.execute("""INSERT INTO device_connections(device_id, connected_at, last_seen)
                VALUES (?,?,?)""", (device_id, now, now)).lastrowid

    def touch_connection(self, connection_id):
        now = time.time()
        with self.connect() as db:
            updated = db.execute("""UPDATE device_connections SET last_seen=?
                WHERE id=? AND disconnected_at IS NULL""", (now, connection_id))
            if updated.rowcount:
                db.execute("""UPDATE devices SET last_seen=? WHERE id=(
                    SELECT device_id FROM device_connections WHERE id=?)""", (now, connection_id))

    def end_connection(self, connection_id, reason):
        with self.connect() as db:
            db.execute("""UPDATE device_connections SET disconnected_at=?, reason=?
                WHERE id=? AND disconnected_at IS NULL""", (time.time(), reason, connection_id))

    def close_connections(self):
        with self.connect() as db:
            db.execute("""UPDATE device_connections SET disconnected_at=?, reason='controller_shutdown'
                WHERE disconnected_at IS NULL""", (time.time(),))
