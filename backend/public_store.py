"""Verified server history: original recovery snapshots and normalized analytics."""
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from threading import RLock
import time

from fastapi import HTTPException

from backend.coverage import annotate_history
from backend.database import merge_source_order
from backend.tracker import IDENTITY, canonical, validate_document

MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_DATABASE_BYTES = 8 * 1024 * 1024 * 1024
ACCOUNT_IDENTITY = ("uid", "endpoint_host", "server", "game_channel_id")


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def account_key(identity):
    if any(not isinstance(identity.get(key), str) or not identity[key] or len(identity[key]) > 200
           for key in (*ACCOUNT_IDENTITY, "account_fingerprint")):
        raise HTTPException(422, 'Verified account identity including UID is required')
    return digest(canonical({key: identity[key] for key in ACCOUNT_IDENTITY}))


class PublicStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = RLock()
        self._statistics_cache = None
        configured = os.environ.get('GFL2_PUBLIC_DATABASE_MAX_BYTES', str(MAX_DATABASE_BYTES))
        if not re.fullmatch(r'[1-9][0-9]*', configured):
            raise RuntimeError('GFL2_PUBLIC_DATABASE_MAX_BYTES must be a positive integer')
        self.max_database_bytes = int(configured)
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            populated = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").fetchone()
            if (populated and version != 2) or version not in (0, 2):
                raise RuntimeError('Server history requires a fresh version 2 database; renaming a legacy database is not a migration')
            db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA user_version=2;
                CREATE TABLE IF NOT EXISTS sessions (
                    hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS access (
                    session_hash TEXT NOT NULL, account_id TEXT NOT NULL, identity TEXT NOT NULL,
                    PRIMARY KEY(session_hash, account_id),
                    FOREIGN KEY(session_hash) REFERENCES sessions(hash) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY, uid TEXT NOT NULL, endpoint_host TEXT NOT NULL,
                    server TEXT NOT NULL, game_channel_id TEXT NOT NULL,
                    account_fingerprint TEXT NOT NULL, name TEXT NOT NULL,
                    UNIQUE(uid, endpoint_host, server, game_channel_id)
                );
                CREATE TABLE IF NOT EXISTS snapshots (
                    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
                    sources TEXT NOT NULL, PRIMARY KEY(account_id, sequence), UNIQUE(account_id, digest)
                );
                CREATE TABLE IF NOT EXISTS pulls (
                    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
                    type_id INTEGER NOT NULL, record_key TEXT NOT NULL, occurrence INTEGER NOT NULL,
                    timestamp TEXT NOT NULL, timestamp_order INTEGER NOT NULL,
                    item_id INTEGER NOT NULL, pool_id INTEGER NOT NULL, quantity INTEGER NOT NULL,
                    raw_record TEXT NOT NULL, source_page INTEGER NOT NULL,
                    snapshot_sequence INTEGER NOT NULL, sources TEXT NOT NULL, rarity TEXT NOT NULL,
                    pity INTEGER NOT NULL, pity_uncertain INTEGER NOT NULL, gap_before INTEGER NOT NULL,
                    PRIMARY KEY(account_id, type_id, record_key, occurrence)
                );
                CREATE INDEX IF NOT EXISTS pulls_history ON pulls(account_id, timestamp DESC, timestamp_order);
                CREATE INDEX IF NOT EXISTS pulls_statistics ON pulls(type_id, pool_id, account_id);
                CREATE TABLE IF NOT EXISTS history_versions (
                    account_id TEXT PRIMARY KEY, version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
        self.catalog_path = Path(__file__).with_name('catalog.json')
        self._catalog_mtime = self.catalog_path.stat().st_mtime_ns
        self.catalog = {item['id']: item for item in json.loads(self.catalog_path.read_text(encoding='utf-8'))['items']}

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        except sqlite3.OperationalError as error:
            if getattr(error, 'sqlite_errorcode', None) == sqlite3.SQLITE_FULL:
                raise HTTPException(507, 'Server storage capacity reached; download a local backup') from None
            raise
        finally:
            db.close()

    def cleanup(self):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM sessions WHERE expires <= ?', (time.time(),))

    def session(self, token):
        if not token or len(token) > 128:
            return None
        with self.connect() as db:
            return db.execute('SELECT * FROM sessions WHERE hash=? AND expires>?', (digest(token), time.time())).fetchone()

    def create_session(self, token, csrf, expires):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            if db.execute('SELECT count(*) FROM sessions').fetchone()[0] >= 2048:
                raise HTTPException(503, 'Session capacity reached; try again later')
            db.execute('INSERT INTO sessions VALUES(?,?,?)', (digest(token), digest(csrf), expires))

    def grant(self, token, identity):
        key = account_key(identity)
        with self.lock, self.connect() as db:
            count = db.execute('SELECT count(*) FROM access WHERE session_hash=?', (digest(token),)).fetchone()[0]
            if count >= 20:
                raise HTTPException(429, 'At most 20 verified accounts per session')
            db.execute('INSERT OR REPLACE INTO access VALUES(?,?,?)', (digest(token), key, canonical(identity)))
        return key

    def accounts(self, token):
        with self.connect() as db:
            return [{'account_id': row['account_id'], 'identity': json.loads(row['identity'])} for row in
                    db.execute('SELECT account_id,identity FROM access WHERE session_hash=?', (digest(token),))]

    def require_account(self, token, key):
        with self.connect() as db:
            row = db.execute('SELECT identity FROM access WHERE session_hash=? AND account_id=?', (digest(token), key)).fetchone()
        if row is None:
            raise HTTPException(404, 'Verified account not found in this session')
        return json.loads(row['identity'])

    def validate_snapshots(self, identity, snapshots, *, associate=False):
        account_key(identity)
        if not isinstance(snapshots, list) or not snapshots or len(snapshots) > 100:
            raise HTTPException(422, 'Supply between 1 and 100 source snapshots')
        for snapshot in snapshots:
            validate_portable(snapshot)
            validation_snapshot(identity, snapshot, associate=associate)
        try:
            size = len(canonical(snapshots).encode())
        except (ValueError, TypeError, RecursionError):
            raise HTTPException(422, 'Snapshots must contain valid finite JSON') from None
        if size > MAX_REQUEST_BYTES:
            raise HTTPException(413, 'Snapshot upload exceeds the 16 MiB request limit')

    def _capacity(self, db):
        # SQLite's page allocator enforces the limit during writes, including
        # uncommitted growth. A failed allocation rolls back the whole save.
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        limit = max(1, self.max_database_bytes // page_size)
        db.execute(f'PRAGMA max_page_count={limit}')
        if db.execute('PRAGMA page_count').fetchone()[0] * page_size > self.max_database_bytes:
            raise HTTPException(507, 'Server storage capacity reached; download a local backup')

    def backup_version(self, key):
        with self.connect() as db:
            row = db.execute('SELECT version FROM history_versions WHERE account_id=?', (key,)).fetchone()
        return row[0] if row else 0

    def put_backup(self, key, identity, name, snapshots, expected_version=None, *, source='upload', associate=False):
        self.validate_snapshots(identity, snapshots, associate=associate)
        if key != account_key(identity):
            raise HTTPException(409, 'Verified account key does not match its identity')
        if source not in {'upload', 'collected'}:
            raise ValueError('Unknown server snapshot source')
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            version = db.execute('SELECT version FROM history_versions WHERE account_id=?', (key,)).fetchone()
            if expected_version is not None and expected_version != (version[0] if version else 0):
                raise HTTPException(409, 'Backup was deleted during collection; it was not recreated')
            previous_account = db.execute('SELECT account_fingerprint FROM accounts WHERE account_id=?', (key,)).fetchone()
            if previous_account and previous_account[0] != identity['account_fingerprint']:
                raise HTTPException(409, 'Verified account fingerprint conflicts with saved history')
            self._capacity(db)
            self._ensure_catalog(db)
            db.execute("""INSERT INTO accounts VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id)
                DO UPDATE SET name=excluded.name, account_fingerprint=excluded.account_fingerprint""",
                (key, *(identity[field] for field in ACCOUNT_IDENTITY), identity['account_fingerprint'], name))
            sequence = db.execute('SELECT coalesce(max(sequence),0) FROM snapshots WHERE account_id=?', (key,)).fetchone()[0]
            changed = False
            for snapshot in snapshots:
                payload = canonical(snapshot)
                fingerprint = digest(payload)
                previous = db.execute('SELECT sources FROM snapshots WHERE account_id=? AND digest=?', (key, fingerprint)).fetchone()
                if previous:
                    sources = set(json.loads(previous[0]))
                    if source not in sources:
                        db.execute('UPDATE snapshots SET sources=? WHERE account_id=? AND digest=?',
                                   (canonical(sorted(sources | {source})), key, fingerprint))
                        changed = True
                else:
                    sequence += 1
                    db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?)', (key, sequence, fingerprint, payload, canonical([source])))
                    changed = True
            if changed:
                self._rebuild_account(db, key, identity)
            self._capacity(db)
            result = dict(account_id=key, name=name,
                snapshot_count=db.execute('SELECT count(*) FROM snapshots WHERE account_id=?', (key,)).fetchone()[0],
                record_count=db.execute('SELECT count(*) FROM pulls WHERE account_id=?', (key,)).fetchone()[0])
            self._statistics_cache = None
        return result

    def get_backup(self, key):
        with self.connect() as db:
            db.execute('BEGIN')
            account = db.execute('SELECT name FROM accounts WHERE account_id=?', (key,)).fetchone()
            if account is None:
                raise HTTPException(404, 'No server backup for this account')
            snapshots = [json.loads(row[0]) for row in db.execute(
                'SELECT payload FROM snapshots WHERE account_id=? ORDER BY sequence', (key,))]
        return {'account_id': key, 'name': account['name'], 'snapshots': snapshots}

    def delete_backup(self, key):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM accounts WHERE account_id=?', (key,))
            db.execute('INSERT INTO history_versions VALUES(?,1) ON CONFLICT(account_id) DO UPDATE SET version=version+1', (key,))
            self._statistics_cache = None

    def _ensure_catalog(self, db):
        mtime = self.catalog_path.stat().st_mtime_ns
        if mtime != self._catalog_mtime:
            self.catalog = {item['id']: item for item in json.loads(self.catalog_path.read_text(encoding='utf-8'))['items']}
            self._catalog_mtime = mtime
        signature = digest(canonical(self.catalog))
        saved = db.execute("SELECT value FROM metadata WHERE key='catalog_digest'").fetchone()
        if saved and saved[0] == signature:
            return
        self._capacity(db)
        for account in db.execute('SELECT * FROM accounts').fetchall():
            self._rebuild_account(db, account['account_id'], dict(account))
        db.execute("INSERT OR REPLACE INTO metadata VALUES('catalog_digest',?)", (signature,))
        self._statistics_cache = None

    def _rebuild_account(self, db, key, identity):
        snapshots = []
        provenance = {}
        for saved in db.execute('SELECT * FROM snapshots WHERE account_id=? ORDER BY sequence', (key,)):
            snapshot = validation_snapshot(identity, json.loads(saved['payload']), associate=True)
            snapshots.append(snapshot)
            _, incoming = validate_document(snapshot['records_document'], snapshot.get('manifest'), snapshot.get('raw_pages'))
            occurrences = Counter()
            for row in incoming:
                record = (row['type_id'], row['record_key'])
                occurrences[record] += 1
                token = (*record, occurrences[record])
                entry = provenance.setdefault(token, [saved['sequence'], set()])
                entry[1].update(json.loads(saved['sources']))
        rows = merged_history(snapshots, self.catalog, identity['endpoint_host'])
        db.execute('DELETE FROM pulls WHERE account_id=?', (key,))
        positions = Counter()
        for row in rows:
            token = (row['type_id'], row['record_key'], row['occurrence'])
            sequence, sources = provenance[token]
            group = (row['type_id'], row['timestamp'])
            position = positions[group]
            positions[group] += 1
            db.execute('INSERT INTO pulls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (key, *token, row['timestamp'], position, row['item_id'], row['pool_id'], row['quantity'],
                 row['raw_record'], row['source_page'], sequence, canonical(sorted(sources)), row['rarity'],
                 row['pity'], int(row['pity_uncertain']), int(row['gap_before'])))

    def statistics(self):
        # Normal requests read normalized rows only. Catalog changes refresh the
        # persisted derived fields once using the retained source windows.
        with self.lock, self.connect() as db:
            self._ensure_catalog(db)
            if self._statistics_cache is None:
                self._statistics_cache = self._statistics(db)
            return self._statistics_cache

    def _statistics(self, db):
        # Aggregate in SQLite so memory scales with released buckets rather
        # than every contributor's lifetime history.
        accounts = db.execute('SELECT count(*) FROM accounts').fetchone()[0]
        total = db.execute('SELECT count(*) FROM pulls').fetchone()[0]
        dimensions = 'a.endpoint_host,a.server,p.type_id,p.pool_id'
        tables = 'pulls p JOIN accounts a USING(account_id)'
        groups = {}
        for row in db.execute(f"""SELECT {dimensions},count(*) AS total,count(DISTINCT p.account_id) AS contributors
                FROM {tables} GROUP BY {dimensions} HAVING count(DISTINCT p.account_id)>=5
                ORDER BY {dimensions}"""):
            key = tuple(row[field] for field in ('endpoint_host', 'server', 'type_id', 'pool_id'))
            groups[key] = dict(row) | dict(rarities=[], items=[], pity=[], observed_pity_count=0, average_observed_pity=None)
        for field, output, label in [('rarity', 'rarities', 'rarity'), ('item_id', 'items', 'item_id'), ('pity', 'pity', 'pulls')]:
            condition = "WHERE p.rarity='Elite' AND p.pity_uncertain=0" if field == 'pity' else ''
            for row in db.execute(f"""SELECT {dimensions},p.{field} AS bucket,count(*) AS count
                    FROM {tables} {condition} GROUP BY {dimensions},p.{field}
                    HAVING count(DISTINCT p.account_id)>=5 ORDER BY {dimensions},p.{field}"""):
                key = tuple(row[name] for name in ('endpoint_host', 'server', 'type_id', 'pool_id'))
                group = groups[key]
                bucket = {label: row['bucket'], 'count': row['count']}
                if field == 'rarity':
                    bucket['rate'] = row['count'] / group['total']
                group[output].append(bucket)
        for group in groups.values():
            observed = sum(bucket['count'] for bucket in group['pity'])
            group['observed_pity_count'] = observed
            if observed:
                group['average_observed_pity'] = sum(bucket['pulls'] * bucket['count'] for bucket in group['pity']) / observed
        return dict(minimum_contributors=5, suppressed=accounts < 5,
                    contributors=accounts if accounts >= 5 else None,
                    total=total if accounts >= 5 else None, breakdowns=list(groups.values()),
                    coverage='accessible_history_only',
                    note='Voluntary sample of accessible game history. Unknown or discontinuous intervals are excluded from pity averages.')


def validation_snapshot(identity, snapshot, *, associate):
    """Bind only validation copies; the exact recovery payload remains intact."""
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('records_document'), dict):
        raise HTTPException(422, 'Snapshot needs a records document')
    document = dict(snapshot['records_document'])
    manifest = snapshot.get('manifest')
    raw_pages = snapshot.get('raw_pages')
    if manifest is not None and not isinstance(manifest, dict):
        raise HTTPException(422, 'Invalid snapshot manifest')
    if raw_pages is not None and not isinstance(raw_pages, dict):
        raise HTTPException(422, 'Invalid raw response documents')
    for page in (raw_pages or {}).values():
        if isinstance(page, str):
            try:
                validate_portable(json.loads(page.lstrip('\ufeff')))
            except (ValueError, RecursionError):
                raise HTTPException(422, 'Invalid raw response document') from None
    for field in (*IDENTITY, 'uid'):
        for metadata in (document, manifest or {}):
            actual = metadata.get(field)
            if actual is not None and actual != identity.get(field):
                raise HTTPException(409, 'Snapshot belongs to a different account, host, server, or channel')
        if field in IDENTITY and document.get(field) is None:
            if not associate:
                raise HTTPException(409, 'Snapshot identity is incomplete; explicitly associate it with this verified account')
            document[field] = identity[field]
    external = document.get('external_source')
    if isinstance(external, dict) and external.get('source') == 'https://exilium.xyz':
        recovered = external.get('recovered_store')
        try:
            profiles = recovered['state']['profilesData']
            if not isinstance(profiles, dict) or len(profiles) != 1:
                raise ValueError()
            pulls = next(iter(profiles.values()))['pulls']
            if not isinstance(pulls, dict):
                raise ValueError()
            for records in pulls.values():
                if not isinstance(records, list):
                    raise ValueError()
                for record in records:
                    if not isinstance(record, dict) or not isinstance(record.get('uid'), str) or not record['uid']:
                        raise ValueError()
                    if record['uid'] != identity['uid']:
                        raise HTTPException(409, 'Recovered Exilium history belongs to a different UID')
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, 'Exilium snapshot needs its recovered account identity') from None
    validate_document(document, manifest, raw_pages)
    return {**snapshot, 'records_document': document}


def validate_portable(value):
    """Reject credentials and uploaded trust claims before private persistence.

    This complements the strict collector validation, which also serves trusted
    local files. Bounds apply before recursive schema traversal.
    """
    forbidden = {'authorization', 'cookie', 'token', 'capture', 'headers', 'accountvalue', 'originalurl',
                 'accesstoken', 'refreshtoken', 'idtoken', 'session', 'sessionid', 'sessiontoken',
                 'csrftoken', 'csrf', 'password', 'secret', 'clientsecret', 'verified', 'serververified',
                 'verification', 'verificationclaims', 'verifiedidentity', 'verifiedat'}
    stack, visited = [(value, 0)], 0
    while stack:
        item, depth = stack.pop()
        visited += 1
        if depth > 40 or visited > 1_000_000:
            raise HTTPException(422, 'Snapshot structure exceeds safe import limits')
        if isinstance(item, dict):
            for key, child in item.items():
                normalized = re.sub(r'[^a-z0-9]', '', str(key).lower())
                if normalized in forbidden:
                    raise HTTPException(422, 'Snapshot contains credentials or server verification claims')
                stack.append((child, depth+1))
        elif isinstance(item, list):
            stack.extend((child, depth+1) for child in item)
        elif isinstance(item, str) and re.search(r'https?://[^\s]+[?&](?:u|uid|openid|token|access_token|authorization|key|code)=', item, re.I):
            raise HTTPException(422, 'Snapshot contains a credential-bearing URL')


def merged_history(snapshots, catalog, host):
    """Occurrence-aware merge using the desktop order and coverage functions."""
    records, groups, documents = {}, defaultdict(list), []
    for snapshot in snapshots:
        _, incoming = validate_document(snapshot['records_document'], snapshot.get('manifest'), snapshot.get('raw_pages'))
        document = dict(snapshot['records_document'])
        empty_pages = defaultdict(list)
        for path, contents in (snapshot.get('raw_pages') or {}).items():
            match = re.fullmatch(r'raw/type_(\d+)/page_(\d+)\.json', path)
            payload = json.loads(contents.lstrip('\ufeff')) if isinstance(contents, str) else contents
            if match and payload['data']['list'] == []:
                empty_pages[str(int(match[1]))].append(int(match[2]))
        document['_coverage_empty_pages'] = empty_pages
        documents.append(document)
        counts, ordered = Counter(), defaultdict(list)
        for row in incoming:
            key = row['type_id'], row['record_key']
            counts[key] += 1
            identity = (*key, counts[key])
            item = catalog.get(row['item_id'], {})
            records.setdefault(identity, {**row, 'occurrence': counts[key], 'rarity': item.get('rarity', 'Unknown')})
            ordered[(row['type_id'], row['timestamp'])].append(identity)
        for group, values in ordered.items():
            groups[group] = merge_source_order(groups[group], values)
    rows = []
    for group in sorted(groups, key=lambda value: (value[1], value[0]), reverse=True):
        rows.extend(records[key] for key in groups[group])
    return annotate_history(rows, documents, host)
