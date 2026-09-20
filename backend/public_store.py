"""Private public-site storage, isolated from the desktop tracker's database.

Account keys are derived only after a provider verifier establishes credential
ownership. Uploaded snapshots never enter the contribution table.
"""
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from threading import RLock
import time

from fastapi import HTTPException

from backend.coverage import annotate_history
from backend.database import merge_source_order
from backend.tracker import IDENTITY, canonical, validate_document

MAX_ACCOUNT_BYTES = 16 * 1024 * 1024
MAX_DATABASE_BYTES = 512 * 1024 * 1024


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def account_key(identity):
    return digest(canonical({key: identity[key] for key in IDENTITY}))


class PublicStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = RLock()
        self._statistics_cache = None
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS access (
                    session_hash TEXT NOT NULL, account_id TEXT NOT NULL, identity TEXT NOT NULL,
                    PRIMARY KEY(session_hash, account_id),
                    FOREIGN KEY(session_hash) REFERENCES sessions(hash) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS backups (
                    account_id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshots TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS backup_versions (
                    account_id TEXT PRIMARY KEY, version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS contributions (
                    account_id TEXT PRIMARY KEY, identity TEXT NOT NULL, snapshots TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL
                );
            """)
        self.catalog = {item['id']: item for item in json.loads(Path(__file__).with_name('catalog.json').read_text(encoding='utf-8'))['items']}

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
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

    def validate_snapshots(self, identity, snapshots):
        if not snapshots or len(snapshots) > 100:
            raise HTTPException(422, 'Supply between 1 and 100 source snapshots')
        for snapshot in snapshots:
            validate_portable(snapshot)
            for page in (snapshot.get('raw_pages') or {}).values():
                if isinstance(page, str):
                    try:
                        validate_portable(json.loads(page.lstrip('\ufeff')))
                    except (ValueError, RecursionError):
                        raise HTTPException(422, 'Invalid raw response document') from None
            actual, _ = validate_document(snapshot['records_document'], snapshot.get('manifest'), snapshot.get('raw_pages'))
            if any(actual.get(key) != identity[key] for key in IDENTITY):
                raise HTTPException(409, 'Snapshot belongs to a different account, host, server, or channel')
        if len(canonical(snapshots).encode()) > MAX_ACCOUNT_BYTES:
            raise HTTPException(413, 'Account backup exceeds the 16 MiB storage limit')

    def _capacity(self):
        used = sum(p.stat().st_size for p in self.path.parent.glob(self.path.name + '*') if p.is_file())
        if used >= MAX_DATABASE_BYTES:
            raise HTTPException(507, 'Server storage capacity reached; download a local backup')

    def backup_version(self, key):
        with self.connect() as db:
            row = db.execute('SELECT version FROM backup_versions WHERE account_id=?', (key,)).fetchone()
        return row[0] if row else 0

    def put_backup(self, key, identity, name, snapshots, expected_version=None):
        self.validate_snapshots(identity, snapshots)
        with self.lock, self.connect() as db:
            version = db.execute('SELECT version FROM backup_versions WHERE account_id=?', (key,)).fetchone()
            if expected_version is not None and expected_version != (version[0] if version else 0):
                raise HTTPException(409, 'Backup was deleted during collection; it was not recreated')
            self._capacity()
            previous = db.execute('SELECT snapshots FROM backups WHERE account_id=?', (key,)).fetchone()
            merged = merge_snapshots(json.loads(previous[0]) if previous else [], snapshots)
            self.validate_snapshots(identity, merged)
            db.execute('INSERT OR REPLACE INTO backups VALUES(?,?,?)', (key, name, canonical(merged)))
        return {'account_id': key, 'name': name, 'snapshots': merged}

    def get_backup(self, key):
        with self.connect() as db:
            row = db.execute('SELECT * FROM backups WHERE account_id=?', (key,)).fetchone()
        if row is None:
            raise HTTPException(404, 'No server backup for this account')
        return {'account_id': key, 'name': row['name'], 'snapshots': json.loads(row['snapshots'])}

    def delete_backup(self, key):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM backups WHERE account_id=?', (key,))
            db.execute('INSERT INTO backup_versions VALUES(?,1) ON CONFLICT(account_id) DO UPDATE SET version=version+1', (key,))

    def preference(self, key, enabled):
        with self.lock, self.connect() as db:
            db.execute('INSERT OR REPLACE INTO preferences VALUES(?,?)', (key, int(enabled)))
            if not enabled:
                db.execute('DELETE FROM contributions WHERE account_id=?', (key,))
                self._statistics_cache = None

    def contribute_collected(self, key, identity, snapshot):
        """Only a trusted collection worker calls this; never a file-upload route.

        Recheck consent inside the transaction so withdrawing while a collection
        is running cannot re-create the contribution on completion.
        """
        self.validate_snapshots(identity, [snapshot])
        with self.lock, self.connect() as db:
            self._capacity()
            preference = db.execute('SELECT enabled FROM preferences WHERE account_id=?', (key,)).fetchone()
            if not preference or not preference[0]:
                return
            previous = db.execute('SELECT snapshots FROM contributions WHERE account_id=?', (key,)).fetchone()
            merged = merge_snapshots(json.loads(previous[0]) if previous else [], [snapshot])
            self.validate_snapshots(identity, merged)
            db.execute('INSERT OR REPLACE INTO contributions VALUES(?,?,?)', (key, canonical(identity), canonical(merged)))
            self._statistics_cache = None

    def statistics(self):
        # Compute once per change. Serializing this potentially large read also
        # prevents concurrent requests multiplying memory use by thread count.
        with self.lock:
            if self._statistics_cache is None:
                self._statistics_cache = self._statistics()
            return self._statistics_cache

    def _statistics(self):
        with self.connect() as db:
            accounts = db.execute('SELECT * FROM contributions').fetchall()
        groups = defaultdict(list)
        total = 0
        for account in accounts:
            identity = json.loads(account['identity'])
            rows = merged_history(json.loads(account['snapshots']), self.catalog, identity['endpoint_host'])
            total += len(rows)
            grouped = defaultdict(list)
            for row in rows:
                grouped[(identity['endpoint_host'], identity['server'], row['type_id'], row['pool_id'])].append(row)
            for key, pulls in grouped.items():
                groups[key].append(pulls)
        breakdowns = []
        for (host, server, type_id, pool_id), contributors in sorted(groups.items()):
            if len(contributors) < 5:
                continue
            rows = [row for pulls in contributors for row in pulls]
            rarities = Counter(row['rarity'] for row in rows)
            items = Counter(row['item_id'] for row in rows)
            pity = Counter(row['pity'] for row in rows if row['rarity'] == 'Elite' and not row['pity_uncertain'])
            # Suppress item/rarity/pity sub-buckets too. A pool with five
            # contributors does not make a single person's rare result public.
            rarity_owners = Counter(value for pulls in contributors for value in {row['rarity'] for row in pulls})
            item_owners = Counter(value for pulls in contributors for value in {row['item_id'] for row in pulls})
            pity_owners = Counter(value for pulls in contributors for value in {row['pity'] for row in pulls if row['rarity'] == 'Elite' and not row['pity_uncertain']})
            rarities = Counter({key: value for key, value in rarities.items() if rarity_owners[key] >= 5})
            items = Counter({key: value for key, value in items.items() if item_owners[key] >= 5})
            pity = Counter({key: value for key, value in pity.items() if pity_owners[key] >= 5})
            observed = sum(pity.values())
            breakdowns.append(dict(endpoint_host=host, server=server, type_id=type_id, pool_id=pool_id,
                contributors=len(contributors), total=len(rows),
                rarities=[{'rarity': key, 'count': value, 'rate': value / len(rows)} for key, value in sorted(rarities.items())],
                items=[{'item_id': key, 'count': value} for key, value in sorted(items.items())],
                pity=[{'pulls': key, 'count': value} for key, value in sorted(pity.items())],
                observed_pity_count=observed, average_observed_pity=sum(k*v for k,v in pity.items()) / observed if observed else None))
        return dict(minimum_contributors=5, suppressed=len(accounts) < 5,
                    contributors=len(accounts) if len(accounts) >= 5 else None,
                    total=total if len(accounts) >= 5 else None, breakdowns=breakdowns,
                    coverage='accessible_history_only',
                    note='Voluntary sample of accessible game history. Unknown or discontinuous intervals are excluded from pity averages.')


def merge_snapshots(existing, incoming):
    unique = {digest(canonical(value)): value for value in [*existing, *incoming]}
    return list(unique.values())


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
