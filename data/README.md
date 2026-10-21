# The data

Collected on 20 and 21 October 2026 from Lichess's open database and the two
sites' public APIs (see the [paper](https://theophile-wallez.github.io/lichess-chesscom-ratings/#data)).
Under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## `pairs.csv`

One row per pair: one player's ratings in one speed on both sites, each over at
least 100 games, the Chess.com one with an RD of at most 90 and played in the
last 90 days. Rows are shuffled, and nothing in them names a player: no
usernames, countries or dates, and the games played only in ranges.

| Column                    | What it holds                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `lichess_speed`           | `bullet`, `blitz`, `rapid`, `classical` or `correspondence`                                       |
| `chesscom_speed`          | the Chess.com speed it's compared with: `bullet`, `blitz`, `rapid` (for classical too) or `daily` |
| `lichess_rating`          | the Lichess rating (Glicko-2), not provisional (RD under 110)                                     |
| `lichess_games`           | games rated in the speed on Lichess: `100-249`, `250-999`, `1000-4999` or `5000+`                 |
| `chesscom_rating`         | the Chess.com rating, at the last game in the speed                                               |
| `chesscom_games`          | games in the speed on Chess.com, in the same ranges                                               |
| `pair_kind`               | how the accounts were matched: see below                                                          |
| `same_player_probability` | the model's probability that both accounts are one player (w in the paper)                   |

`pair_kind` is `link` when the Lichess profile links to the Chess.com account,
otherwise the accounts share a username and it's `same-country` (both
profiles name the same country), `other-country` (they name different ones)
or `no-country` (at least one names none).

## `conversion.csv` and `conversion.json`

The conversion table, every 50 points of Lichess rating where at least 25 same
players stand within 100 points. `half_middle_range` is half the range in
which the middle half of those players' Chess.com ratings fall: half of them
are within ± that of `chesscom_rating`. The JSON holds the same rows,
`[Lichess rating, Chess.com rating, half_middle_range]`, by speed.

## `collection.json`

How many players each step of the collection kept, for the paper's funnel.
