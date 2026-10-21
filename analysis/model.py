"""The mixture model behind the conversion: per speed, a pair's Chess.com
rating is either the same player's, drawn around a rising curve of their
Lichess rating with a spread that may change along it, or a stranger's who
shares the username, drawn from all the Chess.com ratings found. How likely a
pair is the same player is fitted per kind of pair. docs/index.html writes it
out in full; the names below follow it.
"""

import math

import numpy as np
from scipy.optimize import minimize

GROUPS = ['link', 'same-country', 'other-country', 'no-country']
CURVE_STEP = 100
SPREAD_STEP = 400
SMOOTHING = 2.0
TABLE_STEP = 50
# A table row needs this many players, by their weight of being the same
# player, within a curve step of it: past them the curve is a guess.
MIN_SUPPORT = 25
BIN = 25


def background_density(chesscom):
    """b(y): a stranger's rating's density, a histogram of all the speed's
    Chess.com ratings smoothed by a Gaussian of 100 points."""
    bins = np.arange(0, 3600, BIN)
    counts, _ = np.histogram(chesscom, bins)
    kernel = np.exp(-0.5 * (np.arange(-8, 9) / 4) ** 2)
    smooth = np.convolve(counts + 0.5, kernel / kernel.sum(), 'same')
    density = smooth / smooth.sum() / BIN
    return lambda y: density[np.clip(((y - bins[0]) // BIN).astype(int), 0, len(density) - 1)]


class Model:
    """f on knots every CURVE_STEP, rising by a softplus step between each;
    log sigma on knots every SPREAD_STEP; a logit share of same players per group."""

    def __init__(self, low, high):
        self.curve_knots = np.arange(low, high + CURVE_STEP, CURVE_STEP, dtype=float)
        self.spread_knots = np.arange(low, high + SPREAD_STEP, SPREAD_STEP, dtype=float)
        self.size = len(self.curve_knots) + len(self.spread_knots) + len(GROUPS)

    @classmethod
    def spanning(cls, x):
        low = math.floor(np.percentile(x, 0.5) / CURVE_STEP) * CURVE_STEP
        high = math.ceil(np.percentile(x, 99.5) / CURVE_STEP) * CURVE_STEP
        return cls(low, high)

    def unpack(self, params):
        n, m = len(self.curve_knots), len(self.spread_knots)
        steps = np.logaddexp(0, params[1:n]) * CURVE_STEP
        curve = params[0] + np.concatenate([[0], np.cumsum(steps)])
        spread = np.exp(params[n : n + m])
        share = 1 / (1 + np.exp(-params[n + m :]))
        return curve, spread, share

    def curve_at(self, params, x):
        curve, spread, _ = self.unpack(params)
        return np.interp(x, self.curve_knots, curve), np.interp(x, self.spread_knots, spread)

    def start(self, x, y):
        params = np.zeros(self.size)
        n, m = len(self.curve_knots), len(self.spread_knots)
        slope, intercept = np.polyfit(x, y, 1)
        params[0] = slope * self.curve_knots[0] + intercept
        params[1:n] = math.log(math.expm1(max(slope, 0.2)))
        params[n : n + m] = math.log(150)
        return params


def neg_log_likelihood(params, model, x, y, groups, stranger):
    curve, spread, share = model.unpack(params)
    mean = np.interp(x, model.curve_knots, curve)
    sigma = np.interp(x, model.spread_knots, spread)
    same = np.exp(-0.5 * ((y - mean) / sigma) ** 2) / (sigma * math.sqrt(2 * math.pi))
    likelihood = share[groups] * same + (1 - share[groups]) * stranger
    # Second differences of the curve: it bends only where the data asks.
    bends = np.diff(curve, 2) / CURVE_STEP
    return -np.sum(np.log(likelihood + 1e-300)) + SMOOTHING * np.sum(bends**2)


class Fit:
    """A speed's fitted model, and each pair's weight of being the same player."""

    def __init__(self, x, y, groups, start=None, model=None):
        self.x, self.y, self.groups = x, y, groups
        self.model = model or Model.spanning(x)
        self.stranger = background_density(y)(y)
        result = minimize(
            neg_log_likelihood,
            self.model.start(x, y) if start is None else start,
            args=(self.model, x, y, groups, self.stranger),
            method='L-BFGS-B',
            options={'maxiter': 5000, 'maxfun': 200000},
        )
        self.params = result.x
        self.curve, self.spread, self.share = self.model.unpack(result.x)
        mean, sigma = self.model.curve_at(result.x, x)
        same = self.share[groups] * np.exp(-0.5 * ((y - mean) / sigma) ** 2) / (sigma * math.sqrt(2 * math.pi))
        self.weight = same / (same + (1 - self.share[groups]) * self.stranger)
        self.residual = (y - mean) / sigma

    def at(self, ratings):
        return self.model.curve_at(self.params, np.asarray(ratings, dtype=float))

    def shares(self):
        return dict(zip(GROUPS, self.share.round(3).tolist()))

    def table(self):
        """[rating, Chess.com rating, half the middle half's range] every
        TABLE_STEP: the range read off the players near the row, each by its
        weight of being the same player, around the curve."""
        mean, _ = self.at(self.x)
        residuals = self.y - mean
        rows = []
        for rating in range(int(self.model.curve_knots[0]), int(self.model.curve_knots[-1]) + 1, TABLE_STEP):
            near = np.abs(self.x - rating) <= CURVE_STEP
            if self.weight[near].sum() < MIN_SUPPORT:
                continue
            low = weighted_quantile(residuals[near], self.weight[near], 0.25)
            high = weighted_quantile(residuals[near], self.weight[near], 0.75)
            rows.append([rating, round(float(self.at([rating])[0][0])), round((high - low) / 2)])
        return rows


def weighted_quantile(values, weights, share):
    order = np.argsort(values)
    cumulative = np.cumsum(weights[order])
    return float(np.interp(share * cumulative[-1], cumulative, values[order]))
