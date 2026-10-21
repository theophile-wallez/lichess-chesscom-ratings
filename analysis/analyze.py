"""Fits the conversion on data/pairs.csv and writes what the paper shows:

  python3 analysis/analyze.py              (numpy and scipy, a few minutes)

- data/conversion.json and data/conversion.csv: the conversion table;
- docs/results.json: the fits, a sample of the pairs, the bootstrap's
  confidence band and the checks, for docs/index.html's charts.

Everything here starts from the published pairs, so anyone can run it again.
"""

import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import GROUPS, Fit, weighted_quantile  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
# Lichess's classical is played as rapid on Chess.com; correspondence, as
# daily, has too few pairs to fit.
SPEEDS = {'bullet': 'bullet', 'blitz': 'blitz', 'rapid': 'rapid', 'classical': 'rapid'}
MIN_PAIRS = 200
BOOTSTRAPS = 100
SHOWN_POINTS = 3000
GAME_BUCKETS = ['100-249', '250-999', '1000-4999', '5000+']
GAME_FLOORS = {'250': {'250-999', '1000-4999', '5000+'}, '1000': {'1000-4999', '5000+'}}
GRID_STEP = 25
MEDIAN_BOOTSTRAPS = 1000


def load(path):
    rows = list(csv.DictReader(open(path)))
    speeds = {}
    for speed in SPEEDS:
        mine = [row for row in rows if row['lichess_speed'] == speed]
        speeds[speed] = {
            'x': np.array([int(row['lichess_rating']) for row in mine], dtype=float),
            'y': np.array([int(row['chesscom_rating']) for row in mine], dtype=float),
            'groups': np.array([GROUPS.index(row['pair_kind']) for row in mine]),
            'games': [(row['lichess_games'], row['chesscom_games']) for row in mine],
        }
    left_out = sum(row['lichess_speed'] not in SPEEDS for row in rows)
    return speeds, left_out


def resampled(job):
    """One bootstrap draw's curve, on the main fit's knots and grid."""
    seed, data, fit = job
    pick = np.random.default_rng(seed).integers(0, len(data['x']), len(data['x']))
    draw = Fit(data['x'][pick], data['y'][pick], data['groups'][pick], start=fit.params, model=fit.model)
    return draw.at(grid(fit))[0], draw.share


def grid(fit):
    return np.arange(fit.model.curve_knots[0], fit.model.curve_knots[-1] + 1, GRID_STEP)


def histogram(values, edges, weights=None):
    counts, _ = np.histogram(values, edges, weights=weights)
    return [round(float(c), 2) for c in counts]


def median_band(values, weights, seed=0):
    """The weighted median of values, and its 95% bootstrap interval."""
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(MEDIAN_BOOTSTRAPS):
        pick = rng.integers(0, len(values), len(values))
        draws.append(weighted_quantile(values[pick], weights[pick], 0.5))
    low, high = np.percentile(draws, [2.5, 97.5])
    return [round(weighted_quantile(values, weights, 0.5), 1), round(float(low), 1), round(float(high), 1)]


def checks(data, fit, table):
    """How the pairs we're surest of sit around the curve: those whose
    Lichess profile links to the Chess.com account."""
    linked = data['groups'] == GROUPS.index('link')
    mean, _ = fit.at(data['x'][linked])
    residuals = data['y'][linked] - mean
    rows = np.array(table)
    half = np.interp(data['x'][linked], rows[:, 0], rows[:, 2])
    return {
        'links': int(linked.sum()),
        'linkMedian': median_band(residuals, np.ones(len(residuals))) if linked.sum() >= 20 else None,
        'linkWithinHalf': round(float(np.mean(np.abs(residuals) <= half)), 3) if linked.any() else None,
        'linkPoints': [[int(a), int(b)] for a, b in zip(data['x'][linked], data['y'][linked])],
        'groupMedians': {
            g: median_band(data['y'][kind] - fit.at(data['x'][kind])[0], fit.weight[kind])
            for g, kind in ((g, data['groups'] == i) for i, g in enumerate(GROUPS))
            if g != 'link' and kind.sum() >= 30
        },
    }


def experience(data, fit):
    """The same players' median gap to the curve, by how many games they've
    played on each site, and how many of the linked pairs are in each range."""
    mean, _ = fit.at(data['x'])
    residuals = data['y'] - mean
    linked = data['groups'] == GROUPS.index('link')
    out = {}
    for side, column in (('lichess', 0), ('chesscom', 1)):
        buckets = np.array([games[column] for games in data['games']])
        out[side] = [
            {
                'games': bucket,
                'same': round(float(fit.weight[buckets == bucket].sum())),
                'median': median_band(residuals[buckets == bucket], fit.weight[buckets == bucket]),
                'linkShare': round(float(np.mean(buckets[linked] == bucket)), 3) if linked.any() else None,
                'share': round(float(fit.weight[buckets == bucket].sum() / fit.weight.sum()), 3),
            }
            for bucket in GAME_BUCKETS
            if (buckets == bucket).sum() >= 30
        ]
    return out


def naive(data):
    """What a plain fit makes of the same pairs, strangers and all."""
    x, y = data['x'], data['y']
    slope, intercept = np.polyfit(x, y, 1)
    medians = []
    for low in range(int(x.min() // 100 * 100), int(x.max()) + 1, 100):
        inside = (x >= low) & (x < low + 100)
        if inside.sum() >= 30:
            medians.append([low + 50, round(float(np.median(y[inside])))])
    return {'ols': [round(float(slope), 4), round(float(intercept), 1)], 'medians': medians}


def sensitivity(data, fit):
    """The curve again, keeping only pairs with more games on both sites."""
    curves = {}
    for floor, buckets in GAME_FLOORS.items():
        keep = np.array([a in buckets and b in buckets for a, b in data['games']])
        if keep.sum() < MIN_PAIRS:
            continue
        refit = Fit(data['x'][keep], data['y'][keep], data['groups'][keep], start=fit.params, model=fit.model)
        curves[floor] = {'pairs': int(keep.sum()), 'curve': [round(float(v)) for v in refit.at(grid(fit))[0]]}
    return curves


def speed_results(speed, data, pool):
    started = time.time()
    fit = Fit(data['x'], data['y'], data['groups'])
    table = fit.table()
    draws = list(pool.map(resampled, [(seed, data, fit) for seed in range(BOOTSTRAPS)]))
    curves = np.array([curve for curve, _ in draws])
    shares = np.array([share for _, share in draws])
    mean, sigma = fit.at(grid(fit))
    low, high = np.percentile(curves, [2.5, 97.5], axis=0)
    pick = np.random.default_rng(0).permutation(len(data['x']))[:SHOWN_POINTS]
    result = {
        'chesscom': SPEEDS[speed],
        'pairs': int(len(data['x'])),
        'same': round(float(fit.weight.sum())),
        'groups': {g: int((data['groups'] == i).sum()) for i, g in enumerate(GROUPS)},
        'shares': fit.shares(),
        'shareBands': {g: [round(float(a), 3), round(float(b), 3)] for g, a, b in zip(GROUPS, *np.percentile(shares, [2.5, 97.5], axis=0))},
        'curve': [[int(x), round(float(m)), round(float(s)), round(float(a)), round(float(b))] for x, m, s, a, b in zip(grid(fit), mean, sigma, low, high)],
        'table': table,
        'points': [[int(data['x'][i]), int(data['y'][i]), round(float(fit.weight[i]), 2)] for i in pick],
        'weights': histogram(fit.weight, np.linspace(0, 1, 21)),
        'residuals': histogram(fit.residual, np.arange(-4, 4.01, 0.25), fit.weight),
        'naive': naive(data),
        'sensitivity': sensitivity(data, fit),
        'experience': experience(data, fit),
        **checks(data, fit, table),
    }
    print(f'{speed}: {len(data["x"])} pairs, shares {fit.shares()}, {time.time() - started:.0f} s', file=sys.stderr)
    return result


def write_table(results):
    speeds = {speed: r['table'] for speed, r in results.items()}
    conversion = {
        'fitted': time.strftime('%Y-%m'),
        'table': '[Lichess rating, Chess.com rating, half the range of the middle half of players]',
        'speeds': speeds,
    }
    (ROOT / 'data/conversion.json').write_text(json.dumps(conversion, indent=1) + '\n')
    with open(ROOT / 'data/conversion.csv', 'w', newline='') as out:
        writer = csv.writer(out)
        writer.writerow(['lichess_speed', 'chesscom_speed', 'lichess_rating', 'chesscom_rating', 'half_middle_range'])
        for speed, rows in speeds.items():
            writer.writerows([speed, SPEEDS[speed], *row] for row in rows)


def main():
    speeds, left_out = load(ROOT / 'data/pairs.csv')
    collection = json.loads((ROOT / 'data/collection.json').read_text())
    with ProcessPoolExecutor(os.cpu_count()) as pool:
        results = {speed: speed_results(speed, data, pool) for speed, data in speeds.items() if len(data['x']) >= MIN_PAIRS}
    write_table(results)
    out = {'fitted': time.strftime('%Y-%m-%d'), 'bootstraps': BOOTSTRAPS, 'leftOut': left_out, 'collection': collection, 'speeds': results}
    (ROOT / 'docs/results.json').write_text(json.dumps(out, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
