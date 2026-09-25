"""Synthetic-only server comparison matching, privacy and authorization tests."""
from copy import deepcopy
import json
from pathlib import Path
import time

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from backend import statistics_comparison as comparison
from backend.public_app import create_public_app
from backend.public_store import PublicStore, account_key

HOST = 'gf2-gacha-record-us.sunborngame.com'
ORIGIN = 'https://tracker.example'


def identity(uid='1', **updates):
    return dict(uid=uid, endpoint_host=HOST, server='10', game_channel_id='5',
                account_fingerprint='sha256:' + 'a' * 64) | updates


def query(**updates):
    return dict(endpoint_host=HOST, server='10', game_channel_id='5', type_id=3,
        rules_version=comparison.RULES_VERSION,
        elite=dict(budget=5, count=1, startingPity=0, guaranteed=False),
        featured=None, wins=None) | updates


def snapshot(owner, items, *, timestamp=1733270400, pages=None):
    return dict(records_document=dict(schema_version=2, exported_at='2026-01-01T00:00:00Z', **owner,
        records=[dict(source_type_id=3,source_page=pages[i] if pages else 1,
            record=dict(item=item,pool_id=900,time=timestamp,item_num=1)) for i,item in enumerate(items)]))


@pytest.fixture
def store(tmp_path):
    value = PublicStore(tmp_path / 'public-v2.sqlite3')
    value.catalog = {1:dict(id=1,rarity='Standard',kind='Doll'),
                     2:dict(id=2,rarity='Elite',kind='Doll'),
                     3:dict(id=3,rarity='Elite',kind='Doll')}
    return value


def seed(store, n, *, winners=None, owner_updates=None):
    # Oldest reward anchors unknown pity; budget=5 starts after that reward.
    for i in range(n):
        owner = identity(str(i), **(owner_updates or {}))
        items = [1, 1, 2 if winners is None or i < winners else 1, 1, 1, 2]
        source = snapshot(owner, items)
        store.put_backup(account_key(owner), owner, 'Synthetic', [source])


def test_matching_prefix_is_not_full_window_and_zero_observed(store):
    seed(store, 5)
    # Reward at position three: first two pulls have no rewards.
    result = store.compare_statistics(query(elite=dict(budget=2,count=1,startingPity=0,guaranteed=False)))
    assert result['metrics']['elite'] == dict(status='ok',contributors=5,better_or_equal=0,percentage=None)
    zero = store.compare_statistics(query(elite=dict(budget=2,count=0,startingPity=0,guaranteed=False)))
    assert zero['metrics']['elite']['better_or_equal'] == 5
    assert store.compare_statistics(query(elite=dict(budget=6,count=1,startingPity=0,guaranteed=False)))['metrics']['elite']['status'] == 'insufficient_cohort'


@pytest.mark.parametrize('n,winners,status,percent', [(4,4,'insufficient_cohort',None),
    (5,5,'ok',None),(6,5,'privacy_suppressed',None),(10,5,'ok',None),
    (49,25,'ok',None),(50,25,'ok',.5),(50,49,'privacy_suppressed',None),
    (50,0,'ok',0),(50,50,'ok',1)])
def test_cohort_and_partition_thresholds(store,n,winners,status,percent):
    seed(store,n,winners=winners)
    metric=store.compare_statistics(query())['metrics']['elite']
    assert metric['status']==status
    assert metric['percentage']==percent
    if status!='ok':
        assert metric['contributors'] is None and metric['better_or_equal'] is None


@pytest.mark.parametrize('field,value', [('endpoint_host','other.example'),('server','11'),('game_channel_id','6'),
                                        ('type_id',4),('rules_version','old')])
def test_identity_and_rules_isolation(store,field,value):
    seed(store,5)
    assert store.compare_statistics(query(**{field:value}))['metrics']['elite']['status'] != 'ok'


def test_equal_timestamp_duplicates_reopen_deletion_and_race(store):
    seed(store,5)
    owner=identity('0');key=account_key(owner)
    source=snapshot(owner,[1,1,2,1,1,2])
    store.put_backup(key,owner,'Synthetic',[source],source='collected')
    assert store.compare_statistics(query())['metrics']['elite']['contributors']==5
    with store.connect() as db:
        points=[tuple(r) for r in db.execute('SELECT position,count FROM comparison_points WHERE account_id=? AND metric=? ORDER BY position',(key,'elite'))]
        assert points==[(0,0),(3,1)]
    reopened=PublicStore(store.path)
    reopened.catalog=store.catalog
    assert reopened.compare_statistics(query())['metrics']['elite']['contributors']==5
    version=store.backup_version(key)
    store.delete_backup(key)
    assert store.compare_statistics(query())['metrics']['elite']['status']=='insufficient_cohort'
    with pytest.raises(HTTPException) as error:
        store.put_backup(key,owner,'Synthetic',[source],expected_version=version)
    assert error.value.status_code==409
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM comparison_points WHERE account_id=?',(key,)).fetchone()[0]==0


def test_gap_chooses_latest_window_and_catalog_change_rebuilds(store):
    seed(store,5)
    for i in range(5):
        owner=identity(str(i))
        # Disconnected later records: two pulls after latest anchor, not seven.
        store.put_backup(account_key(owner),owner,'Synthetic',[snapshot(owner,[1,1,2],timestamp=1733356800)])
    assert store.compare_statistics(query())['metrics']['elite']['status']=='insufficient_cohort'
    assert store.compare_statistics(query(elite=dict(budget=2,count=0,startingPity=0,guaranteed=False)))['metrics']['elite']['contributors']==5
    store.catalog[2]['rarity']='Standard'
    assert store.compare_statistics(query(elite=dict(budget=2,count=0,startingPity=0,guaranteed=False)))['metrics']['elite']['status']=='insufficient_cohort'


def row(rarity='Standard',*,pity=1,unknown=False,gap=False,featured=None,outcome='not_applicable',guarantee=None,reason=None):
    return dict(rarity=rarity,pity=pity,pity_uncertain=unknown,gap_before=gap,
                banner_result=dict(featured=featured,outcome=outcome,guarantee_after=guarantee,reason=reason))


def test_featured_window_and_trials_keep_chronological_order():
    rows=[row('Elite',unknown=True,featured=False,outcome='loss',guarantee=True),
          row(pity=1,guarantee=True),row('Elite',pity=2,featured=True,outcome='guaranteed',guarantee=False),
          row('Elite',pity=1,featured=True,outcome='win',guarantee=False),row(pity=1,guarantee=False)]
    value=comparison.comparison_sequences(list(reversed(rows)))
    assert value['elite']['values']==[0,1,1,0]
    assert value['featured']==dict(startingPity=0,guaranteed=True,values=[0,1,1,0])
    assert value['wins']['values']==[0,1]
    # A late unknown pool makes only featured invalid; elite stays continuous.
    rows.append(row(pity=2,guarantee=None,reason='unknown_pool'))
    value=comparison.comparison_sequences(list(reversed(rows)))
    assert value['featured'] is None
    assert len(value['elite']['values'])==5


def test_rules_change_rebuilds_featured_indexes(store,monkeypatch):
    seed(store,5)
    assert store.compare_statistics(query(featured=dict(budget=2,count=0,startingPity=0,guaranteed=False)))['metrics']['featured']['status']=='insufficient_cohort'
    rules=deepcopy(store.banner_rules)
    rules['pools'].append(dict(type_id=3,pool_id=900,featured=[2],kind='Doll'))
    monkeypatch.setattr('backend.public_store.load_banner_rules',lambda:rules)
    value=store.compare_statistics(query(featured=dict(budget=2,count=0,startingPity=0,guaranteed=False)))
    assert value['metrics']['featured']['contributors']==5
    # Derived refresh never modifies the private original documents.
    assert len(store.get_backup(account_key(identity('0')))['snapshots'])==1


def test_post_read_without_session_still_requires_origin_and_bounded_aggregates(tmp_path):
    with TestClient(create_public_app(tmp_path,origin=ORIGIN),base_url=ORIGIN) as client:
        client.headers.update({'X-GFL2-Client-IP':'192.0.2.17','Origin':ORIGIN})
        assert client.post('/api/public/statistics/compare',json=query()).status_code==200
        assert not client.cookies
        assert client.post('/api/public/statistics/compare',json=query(),headers={'Origin':'https://evil.example'}).status_code==403
        assert client.post('/api/public/statistics/compare',json=query(records=[])).status_code==422
        for field,value in [('budget',20001),('budget',True),('startingPity',80),('count',1.5)]:
            body=query();body['elite'][field]=value
            assert client.post('/api/public/statistics/compare',json=body).status_code==422
        assert client.post('/api/public/statistics/compare',content=' '*8193,headers={'Content-Type':'application/json'}).status_code==413
        # Read exemption is exact, never applies to writes.
        assert client.put('/api/public/backup',json={}).status_code==401


def test_self_exclusion_requires_verified_live_owned_matching_session(tmp_path):
    with TestClient(create_public_app(tmp_path,origin=ORIGIN,identity_verifier=lambda _: None),base_url=ORIGIN) as client:
        client.headers.update({'X-GFL2-Client-IP':'192.0.2.18','Origin':ORIGIN})
        store=client.app.state.store
        owner=identity();key=account_key(owner)
        body=query(exclude_account_id=key)
        assert client.post('/api/public/statistics/compare',json=body).json()['self_excluded'] is False
        store.create_session('synthetic-session','csrf',time.time()+60)
        client.cookies.set('gfl2_session','synthetic-session')
        assert client.post('/api/public/statistics/compare',json=body).json()['self_excluded'] is False
        store.grant('synthetic-session',owner)
        assert client.post('/api/public/statistics/compare',json=body).json()['self_excluded'] is True
        assert client.post('/api/public/statistics/compare',json=body|{'server':'11'}).json()['self_excluded'] is False
        with store.connect() as db:
            db.execute('UPDATE sessions SET expires=0')
        assert client.post('/api/public/statistics/compare',json=body).json()['self_excluded'] is False


@pytest.mark.parametrize('case', json.loads((Path(__file__).parents[1] / 'web/tests/statistics-windows.json').read_text(encoding='utf-8'))['cases'], ids=lambda case: case['name'])
def test_shared_browser_window_parity(case):
    sequences=comparison.comparison_sequences(case['rows'])
    windows={key:(None if sequences[key] is None else dict(
        budget=len(sequences[key]['values']),count=sum(sequences[key]['values']),
        startingPity=sequences[key]['startingPity'],guaranteed=sequences[key]['guaranteed']))
        for key in ('elite','featured')}
    assert windows==case['expected']['windows']
    assert sum(sequences['wins']['values'])==case['expected']['wins']['wins']
    assert len(sequences['wins']['values'])==case['expected']['wins']['trials']

@pytest.mark.parametrize('metric,window', [('elite',dict(budget=0,count=0,startingPity=0,guaranteed=False)),
    ('elite',dict(budget=1,count=2,startingPity=0,guaranteed=False)),
    ('elite',dict(budget=1,count=1,startingPity=0,guaranteed=True)),
    ('wins',dict(wins=2,trials=1))])
def test_invalid_windows_are_isolated(store,metric,window):
    seed(store,5)
    response=store.compare_statistics(query(**{metric:window}))
    assert response['metrics'][metric]['status']=='invalid_window'
    if metric!='elite':
        assert response['metrics']['elite']['status']=='ok'


def test_featured_guarantee_and_trials_match_prefix_not_total(store,monkeypatch):
    rules=deepcopy(store.banner_rules)
    rules['pools'].append(dict(type_id=3,pool_id=900,featured=[2],kind='Doll'))
    monkeypatch.setattr('backend.public_store.load_banner_rules',lambda:rules)
    for i in range(5):
        owner=identity(str(i))
        # Oldest loss establishes guaranteed start. Then standard, guaranteed
        # featured, unguaranteed win, trailing standard. Trials are loss, win.
        source=snapshot(owner,[1,2,2,1,3])
        store.put_backup(account_key(owner),owner,'Synthetic',[source])
    response=store.compare_statistics(query(featured=dict(budget=2,count=1,startingPity=0,guaranteed=True),
                                          wins=dict(wins=1,trials=1)))
    assert response['metrics']['featured']['better_or_equal']==5
    assert response['metrics']['wins']['better_or_equal']==0
    assert store.compare_statistics(query(wins=dict(wins=1,trials=2)))['metrics']['wins']['better_or_equal']==5
    assert store.compare_statistics(query(featured=dict(budget=2,count=1,startingPity=0,guaranteed=False)))['metrics']['featured']['status']=='insufficient_cohort'
    # Exclusion affects only the requested verified account, once per metric.
    assert store.compare_statistics(query(),account_key(identity('0')))['metrics']['elite']['status']=='insufficient_cohort'


def test_matching_and_prefix_queries_use_indexes(store):
    seed(store,5)
    with store.connect() as db:
        windows=' '.join(str(tuple(row)) for row in db.execute('''EXPLAIN QUERY PLAN SELECT account_id FROM comparison_windows
            WHERE type_id=3 AND metric='elite' AND rules_version=? AND starting_pity=0 AND guaranteed=0 AND budget>=5''',
            (comparison.RULES_VERSION,)))
        points=' '.join(str(tuple(row)) for row in db.execute('''EXPLAIN QUERY PLAN SELECT count FROM comparison_points
            WHERE account_id=? AND type_id=3 AND metric='elite' AND position<=5 ORDER BY position DESC LIMIT 1''',
            (account_key(identity('0')),)))
    assert 'comparison_matching' in windows
    assert 'SEARCH comparison_points USING INDEX' in points

def test_changed_rule_version_is_reported_and_old_clients_are_unsupported(store,monkeypatch):
    seed(store,5)
    rules=deepcopy(store.banner_rules)
    rules['version']+=1
    monkeypatch.setattr('backend.public_store.load_banner_rules',lambda:rules)
    current=comparison.rules_version(rules)
    old=store.compare_statistics(query())
    assert old['rules_version']==current
    assert old['metrics']['elite']['status']=='unsupported'
    assert store.compare_statistics(query(rules_version=current))['metrics']['elite']['contributors']==5
