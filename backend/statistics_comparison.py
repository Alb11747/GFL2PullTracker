"""Rebuildable, account-level comparisons over ordered normalized history.

Only cumulative reward counts are indexed. Original snapshots remain the source
of truth. The same continuous-window rules are used by the browser summary.
"""
from collections import defaultdict

from backend.banner_outcomes import annotate_banner_outcomes, load_banner_rules

def rules_version(rules):
    return f"gfl2-probability-v1:banner-{rules['version']}:{rules['source']['sha256']}"


RULES_VERSION = rules_version(load_banner_rules())
MAX_BUDGET = 20_000


def comparison_sequences(rows):
    """Return latest continuous windows and chronological classifiable trials.

    Input is one recruitment type, newest first, already coverage/classifier
    annotated. A reward establishing a missing state is excluded from its window.
    """
    chronological = list(reversed(rows))
    first = chronological[0] if chronological else None
    pity = (first['pity'] - 1 if first and not first['pity_uncertain']
            and not first['gap_before'] and first['rarity'] != 'Unknown' else None)
    elite = dict(startingPity=pity, guaranteed=False, values=[]) if pity is not None else None
    featured = None  # The classifier never assumes an initial guarantee.
    attempts = []
    for row in chronological:
        banner = row.get('banner_result') or {}
        is_elite = row['rarity'] == 'Elite'
        pity_break = row['gap_before'] or row['rarity'] == 'Unknown'
        featured_break = (pity_break or not banner
                          or (is_elite and banner.get('featured') is None)
                          or banner.get('guarantee_after') is None
                          or banner.get('reason') in {'unknown_pool', 'unknown_provider',
                              'unknown_item', 'guarantee_conflict', 'unsupported_type'})
        if pity_break:
            elite = None
        if featured_break:
            featured = None
        if elite is not None:
            elite['values'].append(int(is_elite))
        if featured is not None:
            featured['values'].append(int(is_elite and banner.get('featured') is True))
        if is_elite:
            if banner.get('outcome') in ('win', 'loss'):
                attempts.append(int(banner['outcome'] == 'win'))
            if elite is None:
                elite = dict(startingPity=0, guaranteed=False, values=[])
            if featured is None and banner.get('featured') is not None and banner.get('guarantee_after') is not None:
                featured = dict(startingPity=0, guaranteed=banner['guarantee_after'], values=[])
    return dict(elite=elite, featured=featured,
                wins=dict(startingPity=0, guaranteed=False, values=attempts))


def rebuild_account(db, key, catalog, rules):
    rows = [dict(row) for row in db.execute('''SELECT * FROM pulls WHERE account_id=?
        ORDER BY timestamp DESC,timestamp_order,type_id,record_key,occurrence''', (key,))]
    account = db.execute('SELECT endpoint_host FROM accounts WHERE account_id=?', (key,)).fetchone()
    for row in rows:
        row['kind'] = catalog.get(row['item_id'], {}).get('kind')
    annotate_banner_outcomes(rows, account['endpoint_host'], rules)
    grouped = defaultdict(list)
    for row in rows:
        if row['type_id'] in (3, 4):
            grouped[row['type_id']].append(row)
    db.execute('DELETE FROM comparison_windows WHERE account_id=?', (key,))
    for type_id, records in grouped.items():
        for metric, window in comparison_sequences(records).items():
            if window is None:
                continue
            values = window['values']
            db.execute('INSERT INTO comparison_windows VALUES(?,?,?,?,?,?,?)',
                (key, type_id, metric, rules_version(rules), window['startingPity'], int(window['guaranteed']), len(values)))
            # Only reward transitions are needed: the latest point <= budget
            # gives its prefix count. Zero is explicit, including empty windows.
            points = [(key, type_id, metric, 0, 0)]
            count = 0
            for position, value in enumerate(values[:MAX_BUDGET], 1):
                count += value
                if value:
                    points.append((key, type_id, metric, position, count))
            db.executemany('INSERT INTO comparison_points VALUES(?,?,?,?,?)', points)


def unavailable(status, reason):
    return dict(status=status, contributors=None, better_or_equal=None, percentage=None, reason=reason)


def compare(db, request, excluded=None, version=RULES_VERSION):
    metrics = {}
    for metric in ('elite', 'featured', 'wins'):
        query = request.get(metric)
        if request['rules_version'] != version or request['type_id'] not in (3, 4):
            metrics[metric] = unavailable('unsupported', 'This recruitment type or rules version is not supported.')
            continue
        if query is None:
            metrics[metric] = unavailable('invalid_window', 'No eligible comparison window was supplied.')
            continue
        budget = query['trials'] if metric == 'wins' else query['budget']
        count = query['wins'] if metric == 'wins' else query['count']
        pity = 0 if metric == 'wins' else query['startingPity']
        guaranteed = False if metric == 'wins' else query['guaranteed']
        if budget == 0 or count > budget or pity >= (80 if request['type_id'] == 3 else 70) or (metric == 'elite' and guaranteed):
            metrics[metric] = unavailable('invalid_window', 'The supplied budget or starting state is invalid.')
            continue
        rows = db.execute('''SELECT (
                SELECT p.count FROM comparison_points p WHERE p.account_id=w.account_id
                AND p.type_id=w.type_id AND p.metric=w.metric AND p.position<=?
                ORDER BY p.position DESC LIMIT 1) AS reward_count
            FROM comparison_windows w JOIN accounts a USING(account_id)
            WHERE w.type_id=? AND w.metric=? AND w.rules_version=?
            AND w.starting_pity=? AND w.guaranteed=? AND w.budget>=?
            AND a.endpoint_host=? AND a.server=? AND a.game_channel_id=?
            AND (? IS NULL OR w.account_id<>?) ORDER BY w.account_id''',
            (budget, request['type_id'], metric, version, pity, int(guaranteed), budget,
             request['endpoint_host'], request['server'], request['game_channel_id'], excluded, excluded))
        total, better = 0, 0
        for row in rows:
            total += 1
            better += row['reward_count'] >= count
        if total < 5:
            metrics[metric] = unavailable('insufficient_cohort', 'Fewer than five eligible saved accounts.')
        elif 0 < better < 5 or 0 < total - better < 5:
            metrics[metric] = unavailable('privacy_suppressed', 'This comparison contains a group smaller than five accounts.')
        else:
            metrics[metric] = dict(status='ok', contributors=total, better_or_equal=better,
                                   percentage=better / total if total >= 50 else None)
    return dict(rules_version=version, self_excluded=excluded is not None, metrics=metrics)
