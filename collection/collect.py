r"""Step 1 of the study: players who have an account on both sites, with
their ratings on each. Needs only the standard library.

Lichess's user API answers a 429 past about 15,000 users an hour, too few to
read a month's players through, so it's asked only about players already
found on Chess.com. The steps, each of which can be stopped and run again:

  dump=https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst
  curl -r 0-800000000 $dump | zstdcat | python3 collect.py names - names.jsonl
  python3 collect.py names-on-chesscom names.jsonl chesscom.jsonl
  python3 collect.py lichess chesscom.jsonl lichess.jsonl
  python3 collect.py links lichess.jsonl chesscom.jsonl

`names` reads a slice of a monthly dump of rated games
(https://database.lichess.org) for the players with an established rating
in some speed: their rating moved little in each game. `names-on-chesscom`
looks each up on Chess.com under the same username, in a random order, until
stopped (about 40,000 an hour). `lichess` reads, from Lichess's user API,
the current ratings, flag and profile of those found active there. `links`
looks up the Chess.com accounts their profiles link to. export.py turns
lichess.jsonl and chesscom.jsonl into the published pairs.
"""

import json
import random
import re
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

USER_AGENT = 'LichessNeo rating study (https://github.com/theophile-wallez/LichessNeo)'
SPEEDS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence']
CHESSCOM_SPEEDS = ['chess_bullet', 'chess_blitz', 'chess_rapid', 'chess_daily']
# Lichess calls a rating provisional past an RD of 110: keep only those below.
MAX_LICHESS_RD = 110
MIN_GAMES = 20
# In the dump: a player whose rating moved at most this much a game, over a few
# games, has an RD well under 110 (a provisional rating moves 30 points and more).
MAX_DUMP_DIFF = 20
MIN_DUMP_GAMES = 3
BATCH = 300
# Lichess answers a 429 when asked too fast, and asks for a full minute after one.
LICHESS_PAUSE_S = 4
# Chess.com serves one request at a time freely, and answers a 429 to too many at once.
CHESSCOM_WORKERS = 6
# A rating last played this long ago says little about the player now.
MAX_AGE_S = 180 * 24 * 3600
LINK = re.compile(
    r'chess\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:member|player|profile|stats/[a-z/]+)/([A-Za-z0-9_-]{3,25})',
    re.IGNORECASE,
)
HEADER = re.compile(r'^\[(\w+) "(.*)"\]$')


def request(url, body=None, retries=12):
    """The JSON at url, None on a 404 or a 410 (closed or missing account)."""
    headers = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    if body is not None:
        headers['Content-Type'] = 'text/plain'
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                return None
            print(f'{error.code} on {url}', file=sys.stderr)
            time.sleep(61 * (attempt + 1) if error.code == 429 else 5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'giving up on {url}')


def append_lines(path, rows):
    with open(path, 'a') as out:
        for row in rows:
            out.write(json.dumps(row) + '\n')


def read_lines(path):
    rows = []
    for line in open(path) if Path(path).exists() else []:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # the last line of a run stopped mid-write
    return rows


# ---- names: the dump's players with an established rating ----


def dump_games(lines):
    """Each game's headers, as a dict."""
    game = {}
    for line in lines:
        match = HEADER.match(line.strip())
        if not match:
            continue
        if match.group(1) == 'Event' and game:
            yield game
            game = {}
        game[match.group(1)] = match.group(2)
    if game:
        yield game


def collect_names(pgn_path, out_path):
    # {name: {speed: [(rating after each game, |its change|)]}}
    seen = defaultdict(lambda: defaultdict(list))
    source = sys.stdin if pgn_path == '-' else open(pgn_path, errors='replace')
    for game in dump_games(source):
        speed = re.match(r'Rated (\w+)', game.get('Event', ''))
        speed = speed and speed.group(1).lower()
        if speed not in SPEEDS:
            continue
        for side in ('White', 'Black'):
            try:
                rating, diff = int(game[f'{side}Elo']), int(game.get(f'{side}RatingDiff', ''))
            except (KeyError, ValueError):
                continue
            seen[game[side].lower()][speed].append((rating + diff, abs(diff)))
    rows = []
    for name, speeds in seen.items():
        ratings = {
            speed: games[-1][0]
            for speed, games in speeds.items()
            if len(games) >= MIN_DUMP_GAMES and statistics.median(d for _, d in games) <= MAX_DUMP_DIFF
        }
        if ratings:
            rows.append({'id': name, 'ratings': ratings})
    random.Random(1).shuffle(rows)
    append_lines(out_path, rows)
    print(f'{len(rows)} of {len(seen)} players established', file=sys.stderr)


# ---- names-on-chesscom and links: Chess.com's accounts ----


def chesscom_ratings(stats):
    ratings = {}
    for speed in CHESSCOM_SPEEDS:
        entry = stats.get(speed)
        if not entry or 'last' not in entry:
            continue
        record = entry.get('record', {})
        games = record.get('win', 0) + record.get('loss', 0) + record.get('draw', 0)
        last = entry['last']
        ratings[speed] = {'r': last['rating'], 'rd': last.get('rd'), 'date': last.get('date'), 'n': games}
    return ratings


def active(ratings):
    recent = time.time() - MAX_AGE_S
    return any(r['n'] >= MIN_GAMES and (r['date'] or 0) > recent for r in ratings.values())


def chesscom_row(lichess_id, username, how):
    stats = request(f'https://api.chess.com/pub/player/{username}/stats')
    ratings = chesscom_ratings(stats or {})
    row = {'id': lichess_id, 'chesscom': username, 'how': how, 'ratings': ratings}
    if active(ratings):
        player = request(f'https://api.chess.com/pub/player/{username}') or {}
        row['status'] = player.get('status')
        row['country'] = player.get('country', '').rsplit('/', 1)[-1] or None
        row['joined'] = player.get('joined')
    return row


def look_up(jobs, out_path):
    """Looks each (Lichess id, Chess.com username, how) up, a few at a time."""
    lock = threading.Lock()
    with open(out_path, 'a') as out, ThreadPoolExecutor(CHESSCOM_WORKERS) as pool:

        def run(numbered):
            count, job = numbered
            line = json.dumps(chesscom_row(*job)) + '\n'
            with lock:
                out.write(line)
                out.flush()
            if count % 500 == 0:
                print(f'{time.strftime("%H:%M")} {count} / {len(jobs)}', file=sys.stderr)

        list(pool.map(run, enumerate(jobs)))


def collect_names_on_chesscom(names_path, out_path):
    done = {row['id'] for row in read_lines(out_path) if row['how'] == 'name'}
    look_up([(row['id'], row['id'], 'name') for row in read_lines(names_path) if row['id'] not in done], out_path)


def collect_links(lichess_path, out_path):
    done = {row['id'] for row in read_lines(out_path) if row['how'] == 'link'}
    players = read_lines(lichess_path)
    look_up([(p['id'], p['link'], 'link') for p in players if p['link'] and p['id'] not in done], out_path)


# ---- lichess: the profiles of those found on Chess.com ----


def established(user):
    """The user's established ratings, by speed."""
    ratings = {}
    for speed in SPEEDS:
        perf = user.get('perfs', {}).get(speed)
        if perf and not perf.get('prov') and perf.get('rd', 999) < MAX_LICHESS_RD and perf['games'] >= MIN_GAMES:
            ratings[speed] = {'r': perf['rating'], 'rd': perf['rd'], 'n': perf['games']}
    return ratings


def linked_account(profile):
    """The Chess.com username the profile links to, if any."""
    match = LINK.search(' '.join(str(value) for value in profile.values()))
    return match.group(1).lower() if match else None


def lichess_row(user):
    if user.get('disabled') or user.get('tosViolation') or user.get('closed'):
        return None
    ratings = established(user)
    if not ratings:
        return None
    profile = user.get('profile', {})
    return {
        'id': user['id'],
        'seen': user.get('seenAt'),
        'flag': profile.get('flag'),
        'link': linked_account(profile),
        'ratings': ratings,
    }


def collect_lichess(chesscom_path, out_path):
    done = {row['id'] for row in read_lines(out_path)}
    asked_path = Path(f'{out_path}.asked')
    asked = set(asked_path.read_text().split()) if asked_path.exists() else set()
    found = {row['id'] for row in read_lines(chesscom_path) if active(row['ratings'])}
    names = sorted(found - done - asked)
    for i in range(0, len(names), BATCH):
        batch = names[i : i + BATCH]
        users = request('https://lichess.org/api/users', ','.join(batch).encode()) or []
        append_lines(out_path, filter(None, map(lichess_row, users)))
        with open(asked_path, 'a') as out:
            out.write('\n'.join(batch) + '\n')
        print(f'{min(i + BATCH, len(names))} / {len(names)}', file=sys.stderr)
        time.sleep(LICHESS_PAUSE_S)


if __name__ == '__main__':
    command, source, target = sys.argv[1:4]
    {
        'names': collect_names,
        'names-on-chesscom': collect_names_on_chesscom,
        'lichess': collect_lichess,
        'links': collect_links,
    }[command](source, target)
