"""Step 2: turns collect.py's raw files, which name the players and stay
private, into the published data:

  python3 collection/export.py <raw folder>    (the folder collect.py wrote in)

- data/pairs.csv: one row per pair, without usernames, countries or dates,
  shuffled, the games played bucketed: matching an account on one site with
  one on the other is personal data, and the exact counts would point at the
  players;
- data/collection.json: how many players each step of the collection kept.

A pair is one player's established ratings on both sites, each over at least
100 games and the Chess.com one played lately, in matching speeds.
"""

import csv
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'analysis'))
import numpy as np  # noqa: E402
from model import GROUPS, Fit  # noqa: E402

SPEEDS = {
    'bullet': 'chess_bullet',
    'blitz': 'chess_blitz',
    'rapid': 'chess_rapid',
    'classical': 'chess_rapid',
    'correspondence': 'chess_daily',
}
# A pair counts only if both ratings rest on many games: a player with
# hundreds of games on one site and a few dozen on the other isn't at their
# level on both yet. Chess.com's RD grows when a player stops, as Lichess's does.
MIN_GAMES = 100
MAX_CHESSCOM_RD = 90
MAX_AGE_S = 90 * 24 * 3600
GAME_BUCKETS = [(100, '100-249'), (250, '250-999'), (1000, '1000-4999'), (5000, '5000+')]
# England, Scotland, Wales and Northern Ireland are their own flags on both sites.
CHESSCOM_REGIONS = {'XE': 'GB', 'XS': 'GB', 'XW': 'GB', 'XI': 'GB'}


def country(code):
    """A country both sites name the same way, or None."""
    if not code or code.startswith('_') or code in ('XX', 'EU'):
        return None
    return CHESSCOM_REGIONS.get(code, code.split('-')[0].upper())


def pair_kind(how, lichess_flag, chesscom_country):
    if how == 'link':
        return 'link'
    mine, theirs = country(lichess_flag), country(chesscom_country)
    if not mine or not theirs:
        return 'no-country'
    return 'same-country' if mine == theirs else 'other-country'


def kept(mine, theirs, recent):
    if not mine or not theirs or min(mine['n'], theirs['n']) < MIN_GAMES:
        return False
    return (theirs['date'] or 0) >= recent and (theirs['rd'] or 999) <= MAX_CHESSCOM_RD


def games_bucket(games):
    return [label for low, label in GAME_BUCKETS if games >= low][-1]


def read(raw):
    players = {row['id']: row for row in map(json.loads, open(raw / 'lichess.jsonl'))}
    lookups, accounts = {}, {}
    for row in map(json.loads, open(raw / 'chesscom.jsonl')):
        if row['how'] == 'name':
            lookups.setdefault(row['id'], row)
        if row['ratings'] and not (row.get('status') or '').startswith('closed'):
            # A link wins over the same name.
            if row['how'] == 'link' or row['id'] not in accounts:
                accounts[row['id']] = row
    return players, lookups, accounts


def pair_rows(players, accounts):
    recent = max((r.get('date') or 0) for a in accounts.values() for r in a['ratings'].values()) - MAX_AGE_S
    rows = []
    for lichess_id, account in accounts.items():
        player = players.get(lichess_id)
        if not player:
            continue
        kind = pair_kind(account['how'], player['flag'], account.get('country'))
        for speed, chesscom_speed in SPEEDS.items():
            mine, theirs = player['ratings'].get(speed), account['ratings'].get(chesscom_speed)
            if kept(mine, theirs, recent):
                rows.append({
                    'lichess_speed': speed,
                    'chesscom_speed': chesscom_speed.removeprefix('chess_'),
                    'lichess_rating': mine['r'],
                    'lichess_games': games_bucket(mine['n']),
                    'chesscom_rating': theirs['r'],
                    'chesscom_games': games_bucket(theirs['n']),
                    'pair_kind': kind,
                })
    return rows


def with_probabilities(rows):
    """Each pair's weight of being the same player, from its speed's fit."""
    for speed in SPEEDS:
        mine = [row for row in rows if row['lichess_speed'] == speed]
        if len(mine) < 2:
            continue
        x, y = (np.array([row[key] for row in mine], dtype=float) for key in ('lichess_rating', 'chesscom_rating'))
        fit = Fit(x, y, np.array([GROUPS.index(row['pair_kind']) for row in mine]))
        for row, weight in zip(mine, fit.weight):
            row['same_player_probability'] = round(float(weight), 3)
    return [row for row in rows if 'same_player_probability' in row]


def collection(raw, players, lookups, rows):
    found = [row for row in lookups.values() if row['ratings']]
    active = [row for row in found if 'status' in row and not (row.get('status') or '').startswith('closed')]
    return {
        'dumpPlayers': sum(1 for _ in open(raw / 'names.txt')),
        'established': sum(1 for _ in open(raw / 'names.jsonl')),
        'lookedUp': len(lookups),
        'onChesscom': len(found),
        'active': len(active),
        'lichessProfiles': sum(row['id'] in players for row in active),
        'linked': sum(1 for p in players.values() if p['link']),
        'pairs': {speed: sum(row['lichess_speed'] == speed for row in rows) for speed in SPEEDS},
    }


def main(raw):
    raw = Path(raw)
    players, lookups, accounts = read(raw)
    rows = with_probabilities(pair_rows(players, accounts))
    random.Random(7).shuffle(rows)
    with open(ROOT / 'data/pairs.csv', 'w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    summary = collection(raw, players, lookups, rows)
    (ROOT / 'data/collection.json').write_text(json.dumps(summary, indent=1) + '\n')
    print(f'{len(rows)} pairs in data/pairs.csv', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1])
