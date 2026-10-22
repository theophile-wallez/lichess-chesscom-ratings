// Draws the paper's figures from results.json (written by analysis/analyze.py).

const SPEEDS = [
  { key: 'bullet', name: 'Bullet', target: 'Bullet', color: 'var(--series-1)' },
  { key: 'blitz', name: 'Blitz', target: 'Blitz', color: 'var(--series-2)' },
  { key: 'rapid', name: 'Rapid', target: 'Rapid', color: 'var(--series-3)' },
  { key: 'classical', name: 'Classical', target: 'Rapid', color: 'var(--series-4)' },
];
const GROUP_NAMES = { link: 'Linked profile', 'same-country': 'Same country', 'other-country': 'Other country', 'no-country': 'No country' };
const GAME_NAMES = { '100-249': '100–249', '250-999': '250–999', '1000-4999': '1,000–4,999', '5000+': '5,000+' };
const NS = 'http://www.w3.org/2000/svg';
const nf = new Intl.NumberFormat('en-US');
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const signed = v => {
  const rounded = Math.round(v);
  return (rounded > 0 ? '+' : rounded < 0 ? '−' : '') + nf.format(Math.abs(rounded));
};
// The fitted curve, a lighter step of its speed's hue, so it stands out of its own points.
const strong = speed => `color-mix(in oklab, ${speed.color} 58%, var(--curve-mix))`;

let results;

const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
};
const path = (points, X, Y) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('');
const area = (upper, lower, X, Y) => `${path(upper, X, Y)}L${path(lower.slice().reverse(), X, Y).slice(1)}Z`;

function interpolate(rows, value, index) {
  if (value <= rows[0][0]) return rows[0][index];
  const i = rows.findIndex(row => row[0] >= value);
  if (i < 0) return rows[rows.length - 1][index];
  const [a, b] = [rows[i - 1], rows[i]];
  return a[index] + ((value - a[0]) / (b[0] - a[0])) * (b[index] - a[index]);
}

const span = fit => [fit.table[0][0], fit.table[fit.table.length - 1][0]];
const covered = fit => {
  const [low, high] = span(fit);
  return fit.curve.filter(([x]) => x >= low && x <= high);
};
const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// ---- Chart frame, tooltip and crosshair ----

function frame(box, { aspect = 0.62, margin = {}, x, y, xTicks, yTicks, xTitle, yTitle, xFormat = nf.format, yFormat = nf.format, xGrid = true }) {
  box.querySelector('svg')?.remove();
  const W = Math.max(260, box.clientWidth), H = Math.round(Math.min(560, Math.max(190, W * aspect)));
  const m = { l: yTitle ? 64 : 50, r: 14, t: 10, b: xTitle ? 44 : 28, ...margin };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  box.prepend(svg);
  const X = v => m.l + ((v - x[0]) / (x[1] - x[0])) * (W - m.l - m.r);
  const Y = v => H - m.b - ((v - y[0]) / (y[1] - y[0])) * (H - m.t - m.b);
  for (const v of yTicks) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 || v === y[0] ? 'axis-line' : 'grid-line' }, svg);
    el('text', { x: m.l - 7, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = yFormat(v);
  }
  for (const v of xTicks) {
    if (xGrid) el('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid-line' }, svg);
    el('text', { x: X(v), y: H - m.b + 17, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = xFormat(v);
  }
  if (xTitle) el('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg).textContent = xTitle;
  if (yTitle) {
    const middle = (m.t + H - m.b) / 2;
    el('text', { x: 12, y: middle, transform: `rotate(-90 12 ${middle})`, 'text-anchor': 'middle', class: 'axis-title' }, svg).textContent = yTitle;
  }
  return { svg, X, Y, W, H, m };
}

function tooltip(box) {
  let tip = box.querySelector('.tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    box.append(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      const width = tip.offsetWidth, room = box.clientWidth;
      tip.style.left = `${x + 14 + width > room ? Math.max(0, x - 14 - width) : x + 14}px`;
      tip.style.top = `${Math.max(0, y - 24)}px`;
      tip.style.opacity = 1;
    },
    hide() { tip.style.opacity = 0; },
  };
}

// A crosshair over a rating axis: read(rating) gives the tooltip and the marks to place.
function crosshair(box, f, { from, to, step = 25, read }) {
  const { svg, X, Y, W, H, m } = f;
  const line = el('line', { y1: m.t, y2: H - m.b, stroke: 'var(--axis)', opacity: 0 }, svg);
  const marks = el('g', {}, svg);
  const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
  const tip = tooltip(box);
  const move = event => {
    const bounds = svg.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const rating = Math.round((from + ((px - m.l) / (W - m.l - m.r)) * (to - from)) / step) * step;
    const { html, points } = read(Math.min(to, Math.max(from, rating)));
    if (!html) return leave();
    line.setAttribute('x1', X(rating)); line.setAttribute('x2', X(rating)); line.setAttribute('opacity', 1);
    marks.replaceChildren(...points.map(([y, color]) => el('circle', { cx: X(rating), cy: Y(y), r: 5, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2 })));
    tip.show(html, px, event.clientY - bounds.top);
  };
  const leave = () => { tip.hide(); line.setAttribute('opacity', 0); marks.replaceChildren(); };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', leave);
}

function curveLine(svg, points, X, Y, color, width = 3) {
  el('path', { d: path(points, X, Y), fill: 'none', stroke: 'var(--surface-1)', 'stroke-width': width + 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85 }, svg);
  el('path', { d: path(points, X, Y), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
}

const legend = (id, items) => {
  document.getElementById(id).innerHTML = items.map(([mark, label]) => `<span>${mark}${label}</span>`).join('');
};
const speedLegend = id => legend(id, SPEEDS.filter(s => results.speeds[s.key]).map(s => [`<i style="background:${s.color}"></i>`, `${s.name} → ${s.target}`]));

// ---- The converter ----

function converter() {
  const picker = document.getElementById('speed-picker');
  const input = document.getElementById('rating-input'), slider = document.getElementById('rating-slider');
  let speed = SPEEDS[1];
  picker.innerHTML = '<span class="slide"></span>' + SPEEDS.map(s => `<button type="button" data-speed="${s.key}"><i style="background:${s.color}"></i>${s.name}</button>`).join('');
  const slide = picker.querySelector('.slide');
  const place = () => {
    const button = picker.querySelector(`[data-speed="${speed.key}"]`);
    slide.style.left = `${button.offsetLeft}px`;
    slide.style.width = `${button.offsetWidth}px`;
    for (const b of picker.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
  };
  const show = () => {
    const fit = results.speeds[speed.key], rating = Number(input.value);
    const [low, high] = span(fit);
    const value = document.getElementById('answer-value'), text = document.getElementById('answer-range');
    const meter = document.getElementById('answer-meter');
    document.getElementById('answer-label').textContent = `Chess.com ${speed.target.toLowerCase()} rating`;
    if (!(rating >= low && rating <= high)) {
      value.innerHTML = '<small>no estimate</small>';
      text.textContent = `Too few players near this rating. In ${speed.name.toLowerCase()}, the table runs from ${nf.format(low)} to ${nf.format(high)}.`;
      meter.style.visibility = 'hidden';
      return;
    }
    const estimate = interpolate(fit.table, rating, 1), half = interpolate(fit.table, rating, 2);
    const ci = (interpolate(fit.curve, rating, 4) - interpolate(fit.curve, rating, 3)) / 2;
    value.innerHTML = `<small>≈</small>${nf.format(Math.round(estimate))}`;
    text.innerHTML = `Half of these players stand between <b>${nf.format(Math.round(estimate - half))}</b> and <b>${nf.format(Math.round(estimate + half))}</b> on Chess.com. The curve itself is known to ± ${Math.max(1, Math.round(ci))} (95%).`;
    const at = v => `${Math.min(100, Math.max(0, (v / 3000) * 100))}%`;
    meter.style.visibility = 'visible';
    Object.assign(meter.querySelector('.iqr').style, { left: at(estimate - half), width: `calc(${at(estimate + half)} - ${at(estimate - half)})`, background: speed.color });
    Object.assign(meter.querySelector('.dot').style, { left: at(estimate), background: strong(speed) });
  };
  picker.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    speed = SPEEDS.find(s => s.key === button.dataset.speed);
    place();
    show();
  });
  input.addEventListener('input', () => { slider.value = input.value; show(); });
  slider.addEventListener('input', () => { input.value = slider.value; show(); });
  window.addEventListener('resize', place);
  place();
  show();
}

function tiles() {
  const fits = Object.values(results.speeds);
  const items = [
    [nf.format(fits.reduce((sum, f) => sum + f.pairs, 0)), 'rating pairs fitted'],
    [nf.format(results.collection.lookedUp), 'Lichess usernames looked up on Chess.com'],
    [`~${nf.format(Math.round(fits.reduce((sum, f) => sum + f.same, 0) / 100) * 100)}`, 'pairs estimated to be one player'],
    [nf.format(results.collection.lichessProfiles), 'players found on both sites'],
  ];
  document.getElementById('tiles').innerHTML = items.map(([value, note]) => `<div class="card tile"><div class="value">${value}</div><div class="note">${note}</div></div>`).join('');
}

function fillValues() {
  const fits = Object.values(results.speeds);
  const values = {
    pairsTotal: nf.format(fits.reduce((sum, f) => sum + f.pairs, 0)),
    pairsAll: nf.format(Object.values(results.collection.pairs).reduce((a, b) => a + b, 0)),
    leftOut: nf.format(results.leftOut),
    bootstraps: nf.format(results.bootstraps),
    fittedMonth: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(results.fitted)),
    fittedDay: new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date(results.fitted)),
  };
  for (const node of document.querySelectorAll('[data-value]')) {
    const key = node.dataset.value;
    node.textContent = key.startsWith('collection.') ? nf.format(results.collection[key.slice(11)]) : values[key];
  }
}

// ---- 1. The short answer ----

function curvesChart() {
  speedLegend('curves-legend');
  const box = document.getElementById('chart-curves');
  const f = frame(box, { aspect: 0.78, x: [400, 2900], y: [0, 2900], xTicks: range(500, 2500, 500), yTicks: range(0, 2500, 500), xTitle: 'Lichess rating', yTitle: 'Chess.com rating' });
  el('line', { x1: f.X(400), y1: f.Y(400), x2: f.X(2900), y2: f.Y(2900), stroke: 'var(--text-muted)', 'stroke-dasharray': '4 4' }, f.svg);
  const slope = (-Math.atan2(f.Y(400) - f.Y(2900), f.X(2900) - f.X(400)) * 180) / Math.PI;
  el('text', { x: f.X(560), y: f.Y(560) - 6, class: 'tick', transform: `rotate(${slope} ${f.X(560)} ${f.Y(560) - 6})` }, f.svg).textContent = 'same number';
  for (const speed of SPEEDS) {
    const fit = results.speeds[speed.key];
    if (!fit) continue;
    const points = covered(fit);
    el('path', { d: area(points.map(c => [c[0], c[4]]), points.map(c => [c[0], c[3]]), f.X, f.Y), fill: speed.color, 'fill-opacity': 0.3 }, f.svg);
    curveLine(f.svg, points.map(c => [c[0], c[1]]), f.X, f.Y, speed.color, 2.5);
  }
  crosshair(box, f, {
    from: 400, to: 2900,
    read: rating => {
      const rows = SPEEDS.filter(s => results.speeds[s.key]).map(s => ({ s, fit: results.speeds[s.key] }))
        .filter(({ fit }) => rating >= span(fit)[0] && rating <= span(fit)[1]);
      if (!rows.length) return {};
      const values = rows.map(({ s, fit }) => [s, interpolate(fit.table, rating, 1)]);
      return {
        html: `Lichess <b>${nf.format(rating)}</b>` + values.map(([s, v]) => `<div class="row"><i style="background:${s.color}"></i>${s.name} <b>≈ ${nf.format(Math.round(v))}</b></div>`).join(''),
        points: values.map(([s, v]) => [v, s.color]),
      };
    },
  });
}

function gapChart() {
  speedLegend('gap-legend');
  const box = document.getElementById('chart-gap');
  const f = frame(box, { aspect: 0.78, x: [400, 2900], y: [-700, 300], xTicks: range(500, 2500, 500), yTicks: range(-700, 300, 100), xTitle: 'Lichess rating', yTitle: 'Points', yFormat: signed });
  for (const speed of SPEEDS) {
    const fit = results.speeds[speed.key];
    if (!fit) continue;
    const points = covered(fit);
    el('path', { d: area(points.map(c => [c[0], c[4] - c[0]]), points.map(c => [c[0], c[3] - c[0]]), f.X, f.Y), fill: speed.color, 'fill-opacity': 0.3 }, f.svg);
    curveLine(f.svg, points.map(c => [c[0], c[1] - c[0]]), f.X, f.Y, speed.color, 2.5);
  }
  crosshair(box, f, {
    from: 400, to: 2900,
    read: rating => {
      const values = SPEEDS.filter(s => results.speeds[s.key] && rating >= span(results.speeds[s.key])[0] && rating <= span(results.speeds[s.key])[1])
        .map(s => [s, interpolate(results.speeds[s.key].table, rating, 1) - rating]);
      if (!values.length) return {};
      return {
        html: `Lichess <b>${nf.format(rating)}</b>` + values.map(([s, v]) => `<div class="row"><i style="background:${s.color}"></i>${s.name} <b>${signed(v)}</b></div>`).join(''),
        points: values.map(([s, v]) => [v, s.color]),
      };
    },
  });
}

function conversionTable() {
  const shown = SPEEDS.filter(s => results.speeds[s.key]);
  const cell = (fit, rating) => {
    const [low, high] = span(fit);
    if (rating < low || rating > high) return '<td class="muted">–</td>';
    return `<td>${nf.format(Math.round(interpolate(fit.table, rating, 1)))}<span class="spread">± ${Math.round(interpolate(fit.table, rating, 2))}</span></td>`;
  };
  document.getElementById('table-conversion').innerHTML = `<table><thead><tr><th>Lichess</th>${shown.map(s => `<th><i style="background:${s.color}"></i>${s.name} → ${s.target}</th>`).join('')}</tr></thead>
    <tbody>${range(600, 2800, 100).map(r => `<tr><td>${nf.format(r)}</td>${shown.map(s => cell(results.speeds[s.key], r)).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---- 2. The data ----

function funnelSteps() {
  const c = results.collection;
  const pairs = Object.values(c.pairs).reduce((a, b) => a + b, 0);
  return [
    [c.dumpPlayers, 'Players in the dump’s slice', 'September 2026, rated games'],
    [c.established, 'With a settled rating', 'in at least one speed'],
    [c.lookedUp, 'Usernames looked up on Chess.com', 'with those of a pilot run'],
    [c.onChesscom, 'Found with a rating on Chess.com', ''],
    [c.active, 'Active on Chess.com', '20 games in a speed, played in 180 days'],
    [c.lichessProfiles, 'Settled on both sites', 'their Lichess profile read'],
    [pairs, 'Rating pairs kept', SPEEDS.map(s => `${s.name.toLowerCase()} ${nf.format(c.pairs[s.key])}`).join(', ')],
  ];
}

// The longest bar leaves room for its count: 80% of the track at most.
const funnelWidth = count => (count / Math.max(results.collection.dumpPlayers, results.collection.lookedUp)) * 80;

function funnel() {
  const steps = funnelSteps();
  document.getElementById('funnel').innerHTML = steps.map(([count, name, note], i) => {
    const width = funnelWidth(count);
    return `<div class="step"><div class="name">${name}${note ? `<small>${note}</small>` : ''}</div>
      <div class="track"><div class="bar${i === steps.length - 1 ? ' pairs' : ''}" style="width:${width}%"></div>
      <span class="count" style="left:calc(${width}% + 8px)">${nf.format(count)}</span></div></div>`;
  }).join('');
}

// ---- 3. The namesakes ----

function naiveChart() {
  const speed = SPEEDS[1], fit = results.speeds.blitz, [slope, intercept] = fit.naive.ols;
  legend('naive-legend', [
    [`<i class="dot" style="background:${speed.color}"></i>`, 'a pair'],
    [`<i style="background:${strong(speed)};height:4px"></i>`, 'the mixture model'],
    ['<i class="dot" style="background:var(--text-primary)"></i>', 'median at each Lichess rating'],
    ['<i class="dash"></i>', 'least-squares line'],
  ]);
  const box = document.getElementById('chart-naive');
  const f = frame(box, { aspect: box.clientWidth < 640 ? 0.85 : 0.5, x: [400, 2900], y: [0, 3000], xTicks: range(500, 2500, 500), yTicks: range(0, 3000, 500), xTitle: 'Lichess blitz rating', yTitle: 'Chess.com blitz rating' });
  const dots = el('g', {}, f.svg);
  for (const [x, y, w] of fit.points) {
    if (x >= 400 && x <= 2900) el('circle', { cx: f.X(x).toFixed(1), cy: f.Y(y).toFixed(1), r: 2.2, fill: speed.color, 'fill-opacity': (0.06 + 0.34 * w).toFixed(2) }, dots);
  }
  el('path', { d: path([[400, slope * 400 + intercept], [2900, slope * 2900 + intercept]], f.X, f.Y), stroke: 'var(--text-secondary)', 'stroke-width': 2, 'stroke-dasharray': '6 5', fill: 'none' }, f.svg);
  curveLine(f.svg, covered(fit).map(c => [c[0], c[1]]), f.X, f.Y, strong(speed), 3.5);
  for (const [x, y] of fit.naive.medians) {
    if (x >= 400 && x <= 2900) el('circle', { cx: f.X(x), cy: f.Y(y), r: 4, fill: 'var(--text-primary)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, f.svg);
  }
  const [low, high] = span(fit);
  document.getElementById('naive-note').textContent = `${nf.format(fit.pairs)} pairs, ${pct.format(fit.same / fit.pairs)} estimated to be one player`;
  crosshair(box, f, {
    from: 400, to: 2900, step: 50,
    read: rating => {
      const median = fit.naive.medians.find(([x]) => Math.abs(x - rating) < 50)?.[1];
      const model = rating >= low && rating <= high ? interpolate(fit.table, rating, 1) : null;
      const ols = slope * rating + intercept;
      return {
        html: `Lichess <b>${nf.format(rating)}</b>` +
          (model !== null ? `<div>Mixture model <b>≈ ${nf.format(Math.round(model))}</b></div>` : '') +
          (median !== undefined ? `<div>Median of the pairs <b>${nf.format(median)}</b></div>` : '') +
          `<div>Least squares <b>${nf.format(Math.round(ols))}</b></div>`,
        points: model !== null ? [[model, strong(speed)]] : [],
      };
    },
  });
}

function smallHistogram(box, { bins, from, step, color, xTicks, xFormat, overlay, yMax, tipFor }) {
  const max = yMax ?? Math.max(...bins) * 1.08;
  const f = frame(box, { aspect: 0.62, margin: { l: 42 }, x: [from, from + bins.length * step], y: [0, max], xTicks, yTicks: niceTicks(max, 3), xFormat, xGrid: false, yFormat: v => (max < 2 ? v.toFixed(1) : nf.format(v)) });
  const tip = tooltip(box);
  bins.forEach((value, i) => {
    const x0 = f.X(from + i * step) + 1, x1 = f.X(from + (i + 1) * step) - 1;
    const top = f.Y(value), bottom = f.Y(0);
    const bar = el('path', { d: `M${x0},${bottom}V${Math.min(bottom, top + 2)}Q${x0},${top} ${x0 + 2},${top}H${x1 - 2}Q${x1},${top} ${x1},${top + 2}V${bottom}Z`, fill: color }, f.svg);
    const hit = el('rect', { x: x0 - 1, y: f.m.t, width: x1 - x0 + 2, height: bottom - f.m.t, fill: 'transparent' }, f.svg);
    hit.addEventListener('pointermove', event => {
      const bounds = f.svg.getBoundingClientRect();
      bar.setAttribute('fill-opacity', 0.75);
      tip.show(tipFor(i, value), event.clientX - bounds.left, event.clientY - bounds.top);
    });
    hit.addEventListener('pointerleave', () => { bar.removeAttribute('fill-opacity'); tip.hide(); });
  });
  if (overlay) el('path', { d: path(overlay, f.X, f.Y), fill: 'none', stroke: 'var(--text-primary)', 'stroke-width': 2, 'pointer-events': 'none' }, f.svg);
  return f;
}

function niceTicks(max, count) {
  const raw = max / count, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(k => k * magnitude).find(s => s >= raw);
  return range(0, max, step);
}

// `subject` names what the small multiples show, for a card's exported image, where its
// speed-only heading would stand alone.
function smallMultiples(id, subject, draw) {
  const parent = document.getElementById(id);
  parent.innerHTML = '';
  // Every card is in before any is drawn: a chart is drawn at its box's width.
  const cards = SPEEDS.filter(speed => results.speeds[speed.key]).map(speed => {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.exportTitle = `${subject} · ${speed.name}`;
    card.innerHTML = `<h3>${speed.name}</h3><div class="chart"></div>`;
    parent.append(card);
    return [speed, card];
  });
  for (const [speed, card] of cards) draw(card.querySelector('.chart'), speed, results.speeds[speed.key], card);
}

function weightCharts() {
  smallMultiples('weights', 'How sure the model is of each pair', (box, speed, fit) => smallHistogram(box, {
    bins: fit.weights, from: 0, step: 0.05, color: speed.color, xTicks: [0, 0.5, 1], xFormat: v => pct.format(v),
    tipFor: (i, value) => `<b>${nf.format(value)}</b> pairs<div class="muted">${pct.format(i * 0.05)} to ${pct.format((i + 1) * 0.05)} likely one player</div>`,
  }));
}

// ---- 5. Speed by speed ----

function speedPanel(speed, fit, card) {
  card.innerHTML = `<div class="panel-head"><h3>${speed.name} Lichess → ${speed.target} Chess.com</h3>
    <span class="muted">${nf.format(fit.pairs)} pairs, ~${nf.format(fit.same)} one player</span></div>
    <div class="legend">
      <span><i class="dot" style="background:${speed.color}"></i>a pair</span>
      <span><i class="ring"></i>linked profile</span>
      <span><i style="background:${strong(speed)};height:4px"></i>estimate</span>
      <span><i class="band" style="background:${speed.color}"></i>middle half</span></div>
    <div class="chart"></div>`;
  const box = card.querySelector('.chart');
  const f = frame(box, { aspect: 0.8, x: [400, 2900], y: [0, 2900], xTicks: range(500, 2500, 500), yTicks: range(0, 2500, 500), xTitle: `Lichess ${speed.name.toLowerCase()} rating`, yTitle: `Chess.com ${speed.target.toLowerCase()} rating` });
  el('line', { x1: f.X(400), y1: f.Y(400), x2: f.X(2900), y2: f.Y(2900), stroke: 'var(--text-muted)', 'stroke-dasharray': '4 4' }, f.svg);
  const dots = el('g', {}, f.svg);
  for (const [x, y, w] of fit.points) {
    if (x >= 400 && x <= 2900) el('circle', { cx: f.X(x).toFixed(1), cy: f.Y(y).toFixed(1), r: 2, fill: speed.color, 'fill-opacity': (0.05 + 0.3 * w).toFixed(2) }, dots);
  }
  el('path', { d: area(fit.table.map(r => [r[0], r[1] + r[2]]), fit.table.map(r => [r[0], r[1] - r[2]]), f.X, f.Y), fill: speed.color, 'fill-opacity': 0.24 }, f.svg);
  curveLine(f.svg, covered(fit).map(c => [c[0], c[1]]), f.X, f.Y, strong(speed), 3.5);
  const rings = el('g', {}, f.svg);
  for (const [x, y] of fit.linkPoints) {
    if (x >= 400 && x <= 2900) el('circle', { cx: f.X(x).toFixed(1), cy: f.Y(Math.max(0, y)).toFixed(1), r: 3.6, fill: 'none', stroke: 'var(--text-primary)', 'stroke-width': 1.4, opacity: 0.9 }, rings);
  }
  const [low, high] = span(fit);
  crosshair(box, f, {
    from: 400, to: 2900,
    read: rating => {
      if (rating < low || rating > high) return { html: `Lichess <b>${nf.format(rating)}</b><div class="muted">too few players here for an estimate</div>`, points: [] };
      const value = interpolate(fit.table, rating, 1), half = interpolate(fit.table, rating, 2);
      const near = fit.points.filter(([x]) => Math.abs(x - rating) <= 100).length;
      return {
        html: `Lichess <b>${nf.format(rating)}</b> → Chess.com <b>≈ ${nf.format(Math.round(value))}</b>` +
          `<div class="muted">half of the players within ± ${Math.round(half)}</div><div class="muted">${nf.format(near)} pairs shown within ± 100</div>`,
        points: [[value, strong(speed)]],
      };
    },
  });
  card.insertAdjacentHTML('beforeend', `<div class="badges">${Object.entries(fit.shares).map(([g, v]) =>
    `<span class="badge">${GROUP_NAMES[g]}: ${pct.format(v)} one player · ${nf.format(fit.groups[g])} pairs</span>`).join('')}</div>`);
}

function sharesChart() {
  const box = document.getElementById('chart-shares');
  const groups = Object.keys(GROUP_NAMES), shown = SPEEDS.filter(s => results.speeds[s.key]);
  const f = frame(box, { aspect: 0.32, margin: { l: 112, b: 30 }, x: [0, 1], y: [0, groups.length], xTicks: range(0, 1, 0.25), yTicks: [], xFormat: v => pct.format(v) });
  const tip = tooltip(box);
  groups.forEach((group, row) => {
    const center = groups.length - row - 0.5;
    el('text', { x: f.m.l - 10, y: f.Y(center) + 4, 'text-anchor': 'end', class: 'direct' }, f.svg).textContent = GROUP_NAMES[group];
    shown.forEach((speed, i) => {
      const fit = results.speeds[speed.key], y = f.Y(center + 0.27 - (i * 0.54) / Math.max(1, shown.length - 1));
      const [low, high] = fit.shareBands[group];
      el('line', { x1: f.X(low), x2: f.X(high), y1: y, y2: y, stroke: speed.color, 'stroke-width': 2, 'stroke-linecap': 'round' }, f.svg);
      const dot = el('circle', { cx: f.X(fit.shares[group]), cy: y, r: 4.5, fill: speed.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, f.svg);
      const hit = el('rect', { x: f.m.l, y: y - 6, width: f.W - f.m.l - f.m.r, height: 12, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', event => {
        const bounds = f.svg.getBoundingClientRect();
        dot.setAttribute('r', 6);
        tip.show(`<div class="row"><i style="background:${speed.color}"></i>${speed.name}, ${GROUP_NAMES[group].toLowerCase()}</div><b>${pct.format(fit.shares[group])}</b> one player<div class="muted">95%: ${pct.format(low)} to ${pct.format(high)} · ${nf.format(fit.groups[group])} pairs</div>`, event.clientX - bounds.left, event.clientY - bounds.top);
      });
      hit.addEventListener('pointerleave', () => { dot.setAttribute('r', 4.5); tip.hide(); });
    });
  });
  const legendBox = document.createElement('div');
  legendBox.className = 'legend';
  legendBox.innerHTML = shown.map(s => `<span><i class="dot" style="background:${s.color}"></i>${s.name}</span>`).join('');
  box.querySelector('.legend')?.remove();
  box.prepend(legendBox);
}

// ---- 6. Checks ----

function linksTable() {
  const band = b => (b ? `${signed(b[0])} <span class="spread">${signed(b[1])} to ${signed(b[2])}</span>` : '<span class="muted">too few</span>');
  const rows = SPEEDS.filter(s => results.speeds[s.key]).map(s => {
    const fit = results.speeds[s.key], others = fit.groupMedians;
    return `<tr><td><i style="background:${s.color};width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px"></i>${s.name}</td>
      <td>${nf.format(fit.links)}</td><td>${band(fit.linkMedian)}</td><td>${fit.linkWithinHalf === null ? '–' : pct.format(fit.linkWithinHalf)}</td>
      <td>${band(others['same-country'])}</td><td>${band(others['no-country'])}</td><td>${band(others['other-country'])}</td></tr>`;
  }).join('');
  document.getElementById('table-links').innerHTML = `<table><thead><tr><th>Speed</th><th>Linked pairs</th><th>Their median gap</th><th>Within ± s</th>
    <th>Same country</th><th>No country</th><th>Other country</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function experienceChart(side) {
  speedLegend(`exp-legend-${side}`);
  const box = document.getElementById(`chart-exp-${side}`);
  const buckets = Object.keys(GAME_NAMES), shown = SPEEDS.filter(s => results.speeds[s.key]);
  const f = frame(box, { aspect: 0.62, x: [0, buckets.length], y: [-150, 150], xTicks: [], yTicks: range(-150, 150, 50), xTitle: `Games played on ${side === 'chesscom' ? 'Chess.com' : 'Lichess'} in the speed`, yTitle: 'Median gap to the curve', yFormat: signed });
  buckets.forEach((bucket, i) => el('text', { x: f.X(i + 0.5), y: f.H - f.m.b + 17, 'text-anchor': 'middle', class: 'tick' }, f.svg).textContent = GAME_NAMES[bucket]);
  const tip = tooltip(box);
  shown.forEach((speed, j) => {
    const fit = results.speeds[speed.key];
    const offset = (j - (shown.length - 1) / 2) * 0.14;
    const points = fit.experience[side].map(row => ({ row, x: buckets.indexOf(row.games) + 0.5 + offset }));
    el('path', { d: path(points.map(p => [p.x, p.row.median[0]]), f.X, f.Y), fill: 'none', stroke: speed.color, 'stroke-width': 1.5, 'stroke-opacity': 0.5 }, f.svg);
    for (const { row, x } of points) {
      const clamp = v => Math.max(-150, Math.min(150, v));
      el('line', { x1: f.X(x), x2: f.X(x), y1: f.Y(clamp(row.median[1])), y2: f.Y(clamp(row.median[2])), stroke: speed.color, 'stroke-width': 2, 'stroke-linecap': 'round' }, f.svg);
      const dot = el('circle', { cx: f.X(x), cy: f.Y(clamp(row.median[0])), r: 4.5, fill: speed.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, f.svg);
      const hit = el('rect', { x: f.X(x) - 8, y: f.m.t, width: 16, height: f.H - f.m.t - f.m.b, fill: 'transparent' }, f.svg);
      hit.addEventListener('pointermove', event => {
        const bounds = f.svg.getBoundingClientRect();
        dot.setAttribute('r', 6);
        tip.show(`<div class="row"><i style="background:${speed.color}"></i>${speed.name}, ${GAME_NAMES[row.games]} games</div><b>${signed(row.median[0])}</b> median gap
          <div class="muted">95%: ${signed(row.median[1])} to ${signed(row.median[2])}</div>
          <div class="muted">${pct.format(row.share)} of the same players · ${row.linkShare === null ? '' : `${pct.format(row.linkShare)} of the linked`}</div>`, event.clientX - bounds.left, event.clientY - bounds.top);
      });
      hit.addEventListener('pointerleave', () => { dot.setAttribute('r', 4.5); tip.hide(); });
    }
  });
}

function sensitivityCharts() {
  smallMultiples('sensitivity', 'The curve refitted on the pairs with more games', (box, speed, fit, card) => {
    const points = covered(fit), index = new Map(fit.curve.map((c, i) => [c[0], i]));
    const floors = Object.entries(fit.sensitivity);
    card.querySelector('h3').insertAdjacentHTML('afterend', `<div class="legend">${floors.map(([floor, s], i) =>
      `<span><i style="background:${i ? `repeating-linear-gradient(90deg, ${speed.color} 0 5px, transparent 5px 9px)` : speed.color}"></i>≥ ${nf.format(Number(floor))} games · ${nf.format(s.pairs)}</span>`).join('') || '<span>too few pairs with more games</span>'}</div>`);
    const f = frame(box, { aspect: 0.7, margin: { l: 42 }, x: [400, 2900], y: [-120, 120], xTicks: range(500, 2500, 1000), yTicks: range(-120, 120, 60), yFormat: signed });
    el('path', { d: area(points.map(c => [c[0], c[4] - c[1]]), points.map(c => [c[0], c[3] - c[1]]), f.X, f.Y), fill: speed.color, 'fill-opacity': 0.22 }, f.svg);
    floors.forEach(([, s], i) => {
      const line = points.map(c => [c[0], Math.max(-120, Math.min(120, s.curve[index.get(c[0])] - c[1]))]);
      el('path', { d: path(line, f.X, f.Y), fill: 'none', stroke: speed.color, 'stroke-width': 2, 'stroke-dasharray': i ? '5 4' : 'none', 'stroke-linejoin': 'round' }, f.svg);
    });
    const [low, high] = span(fit);
    crosshair(box, f, {
      from: low, to: high,
      read: rating => {
        const i = index.get(rating);
        if (i === undefined) return {};
        const c = fit.curve[i];
        return {
          html: `Lichess <b>${nf.format(rating)}</b>` + floors.map(([floor, s]) => `<div>≥ ${nf.format(Number(floor))} games <b>${signed(s.curve[i] - c[1])}</b></div>`).join('') +
            `<div class="muted">95% band of the main curve ${signed(c[3] - c[1])} to ${signed(c[4] - c[1])}</div>`,
          points: floors.map(([, s]) => [Math.max(-120, Math.min(120, s.curve[i] - c[1])), speed.color]),
        };
      },
    });
  });
}

function residualCharts() {
  const normal = range(-4, 4, 0.05).map(z => [z, Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)]);
  smallMultiples('residuals', 'The standardized gaps against the normal', (box, speed, fit) => {
    const total = fit.residuals.reduce((a, b) => a + b, 0);
    const density = fit.residuals.map(v => v / total / 0.25);
    smallHistogram(box, {
      bins: density, from: -4, step: 0.25, color: speed.color, xTicks: [-3, -2, -1, 0, 1, 2, 3], xFormat: signed, overlay: normal, yMax: 0.55,
      tipFor: i => {
        const z = -4 + i * 0.25;
        const normalShare = (Math.exp(-0.5 * (z + 0.125) ** 2) / Math.sqrt(2 * Math.PI)) * 0.25;
        return `<b>${pct.format(fit.residuals[i] / total)}</b> of the weight from ${(z).toFixed(2)} to ${(z + 0.25).toFixed(2)} σ<div class="muted">normal: ${pct.format(normalShare)}</div>`;
      },
    });
  });
}

// ---- Copying and downloading a figure as an image ----

// An exported figure carries no stylesheet, so it is drawn with its own fonts, its own copies of
// style.css's chart rules, and the page's custom properties resolved into it.
const EXPORT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const EXPORT_VARS = ['--surface-1', '--text-primary', '--text-secondary', '--text-muted', '--grid', '--axis'];
const EXPORT_PAD = 22;
const ICONS = {
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 6.5v-1a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/>',
  download: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20.5h16"/>',
  done: '<path d="m4.5 12.5 5 5 10-11"/>',
  failed: '<path d="M6 6l12 12M18 6 6 18"/>',
};

const measureText = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text, font) => { ctx.font = font; return ctx.measureText(text).width; };
})();

function wrapText(text, font, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measureText(next, font) > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// A var() or color-mix() colour, as the browser resolves it on the page: an SVG read as an image
// has no access to the page's custom properties.
const resolveColor = (() => {
  const cache = new Map();
  let probe;
  return value => {
    if (!value || !/var\(|color-mix\(/.test(value)) return value;
    if (cache.has(value)) return cache.get(value);
    if (!probe) {
      probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.append(probe);
    }
    probe.style.color = '';
    probe.style.color = value;
    const resolved = getComputedStyle(probe).color;
    cache.set(value, resolved);
    return resolved;
  };
})();

function resolveColors(svg) {
  for (const node of svg.querySelectorAll('[fill], [stroke]')) {
    for (const name of ['fill', 'stroke']) {
      const value = node.getAttribute(name);
      if (value) node.setAttribute(name, resolveColor(value));
    }
  }
}

function exportCss() {
  const root = getComputedStyle(document.documentElement);
  const vars = EXPORT_VARS.map(name => `${name}:${root.getPropertyValue(name).trim()}`).join(';');
  // The chart rules mirror style.css; the rest styles the frame drawn around the chart.
  return `:root{${vars}}
    text{font-family:${EXPORT_FONT}}
    svg{overflow:visible}
    .grid-line{stroke:var(--grid);stroke-dasharray:3 4}
    .axis-line{stroke:var(--axis)}
    .tick{fill:var(--text-muted);font-size:11px}
    .axis-title{fill:var(--text-secondary);font-size:11.5px}
    .direct{fill:var(--text-secondary);font-size:12px}
    .head{fill:var(--text-primary);font-size:15px;font-weight:650}
    .note{fill:var(--text-muted);font-size:12.5px}
    .key{fill:var(--text-secondary);font-size:13px}
    .step{fill:var(--text-secondary);font-size:14px}
    .count{fill:var(--text-primary);font-size:13.5px}`;
}

// The card's legend, read off the page: each mark is a swatch to draw again in the image.
function legendItems(card) {
  return [...card.querySelectorAll('.legend span')].map(item => {
    const mark = item.querySelector('i');
    const label = item.textContent.trim();
    if (!mark) return { shape: 'none', label };
    const style = getComputedStyle(mark);
    const gradient = style.backgroundImage === 'none' ? null : style.backgroundImage.match(/rgba?\([^)]+\)/)?.[0];
    const shape = mark.classList.contains('dot') ? 'dot' : mark.classList.contains('ring') ? 'ring'
      : mark.classList.contains('band') ? 'band' : gradient ? 'dash' : 'line';
    return {
      shape, label,
      color: shape === 'ring' ? resolveColor('var(--text-primary)') : gradient || style.backgroundColor,
      opacity: Number(style.opacity) || 1,
    };
  }).filter(item => item.label);
}

function drawLegend(parent, items, left, top, width) {
  const font = `13px ${EXPORT_FONT}`;
  let x = left, y = top, rows = 1;
  for (const { shape, color, label, opacity } of items) {
    const needed = 16 + 7 + measureText(label, font);
    if (x > left && x + needed > left + width) { x = left; y += 20; rows++; }
    const middle = y + 8;
    if (shape === 'dot' || shape === 'ring') {
      el('circle', {
        cx: x + 6, cy: middle, r: 4.5, fill: shape === 'ring' ? 'none' : color,
        stroke: shape === 'ring' ? color : 'none', 'stroke-width': 2,
      }, parent);
    } else if (shape === 'band') {
      el('rect', { x, y: middle - 5, width: 16, height: 10, rx: 2, fill: color, 'fill-opacity': opacity }, parent);
    } else if (shape === 'dash') {
      el('line', { x1: x, x2: x + 16, y1: middle, y2: middle, stroke: color, 'stroke-width': 3, 'stroke-dasharray': '4 3' }, parent);
    } else if (shape === 'line') {
      el('rect', { x, y: middle - 1.5, width: 16, height: 3, rx: 1.5, fill: color }, parent);
    }
    el('text', { x: x + 23, y: middle + 4.5, class: 'key' }, parent).textContent = label;
    x += needed + 18;
  }
  return rows * 20;
}

// The funnel is HTML on the page, so the image gets its own drawing of the same steps.
function funnelSvg(width) {
  const nameWidth = Math.max(170, Math.min(280, width * 0.32));
  const trackLeft = nameWidth + 14, trackWidth = width - trackLeft;
  const nameFont = `14px ${EXPORT_FONT}`, noteFont = `12.5px ${EXPORT_FONT}`;
  const steps = funnelSteps();
  let height = 0;
  const rows = steps.map(([count, name, note], i) => {
    const lines = wrapText(name, nameFont, nameWidth);
    const notes = note ? wrapText(note, noteFont, nameWidth) : [];
    const row = { count, lines, notes, top: height, last: i === steps.length - 1 };
    row.height = Math.max(26, lines.length * 18 + notes.length * 16);
    height += row.height + 9;
    return row;
  });
  height -= 9;
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  for (const row of rows) {
    let y = row.top + (row.height - (row.lines.length * 18 + row.notes.length * 16)) / 2;
    for (const line of row.lines) { el('text', { x: 0, y: y + 13, class: 'step' }, svg).textContent = line; y += 18; }
    for (const line of row.notes) { el('text', { x: 0, y: y + 11, class: 'note' }, svg).textContent = line; y += 16; }
    const bar = Math.max(3, (funnelWidth(row.count) / 100) * trackWidth), top = row.top + (row.height - 26) / 2;
    const r = Math.min(4, bar);
    el('path', {
      d: `M${trackLeft},${top}h${bar - r}a${r},${r} 0 0 1 ${r},${r}v${26 - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(bar - r)}z`,
      fill: row.last ? 'var(--series-2)' : 'var(--series-1)',
    }, svg);
    el('text', { x: trackLeft + bar + 8, y: top + 17.5, class: 'count' }, svg).textContent = nf.format(row.count);
  }
  return svg;
}

// The card's chart, with its heading and legend, as a standalone SVG on an opaque background.
function figureSvg(card) {
  const chart = card.querySelector('.chart svg')?.cloneNode(true)
    ?? funnelSvg(Math.max(540, Math.round(card.clientWidth - 44)));
  resolveColors(chart);
  const width = Number(chart.getAttribute('width')), height = Number(chart.getAttribute('height'));
  const title = card.dataset.exportTitle || card.querySelector('h3')?.textContent.trim() || 'Figure';
  const note = card.querySelector('.panel-head .muted')?.textContent.trim();

  const svg = el('svg', {});
  el('style', {}, svg).textContent = exportCss();
  const background = el('rect', { x: 0, y: 0, width: width + EXPORT_PAD * 2, fill: resolveColor('var(--surface-1)') }, svg);
  let y = EXPORT_PAD;
  for (const line of wrapText(title, `650 15px ${EXPORT_FONT}`, width)) {
    el('text', { x: EXPORT_PAD, y: y + 13, class: 'head' }, svg).textContent = line;
    y += 21;
  }
  if (note) {
    el('text', { x: EXPORT_PAD, y: y + 11, class: 'note' }, svg).textContent = note;
    y += 19;
  }
  y += 8;
  const items = legendItems(card);
  if (items.length) y += drawLegend(svg, items, EXPORT_PAD, y, width) + 4;

  chart.setAttribute('x', EXPORT_PAD);
  chart.setAttribute('y', y);
  chart.removeAttribute('role');
  svg.append(chart);
  const W = width + EXPORT_PAD * 2, H = Math.round(y + height + EXPORT_PAD);
  for (const [name, value] of [['width', W], ['height', H], ['viewBox', `0 0 ${W} ${H}`]]) svg.setAttribute(name, value);
  background.setAttribute('height', H);
  return { svg, width: W, height: H, title };
}

// Rasterized at twice the size, so the image stays sharp on a dense screen.
async function figurePng(card, scale = 2) {
  const { svg, width, height, title } = figureSvg(card);
  const text = `<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(svg)}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), 'image/png'));
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
    return { blob, name: `${name || 'figure'}.png` };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function flash(button, icon, title) {
  const mark = button.querySelector('svg');
  const [wasIcon, wasTitle] = [mark.innerHTML, button.title];
  mark.innerHTML = ICONS[icon];
  button.classList.add(icon);
  if (title) button.title = title;
  setTimeout(() => {
    mark.innerHTML = wasIcon;
    button.classList.remove(icon);
    button.title = wasTitle;
  }, 1600);
}

async function figureAction(button, card) {
  if (button.dataset.figure === 'download') {
    const { blob, name } = await figurePng(card);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } else {
    // Safari keeps the click's permission to write only if the item is built from a promise.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': figurePng(card).then(png => png.blob) })]);
  }
}

const figureTool = (action, label) => `<button type="button" data-figure="${action}" title="${label}" aria-label="${label}">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${ICONS[action]}</svg></button>`;

// Every card holding a chart gets the two buttons. Charts are drawn again on resize, so the
// cards rebuilt then are given theirs back.
function figureTools() {
  for (const card of document.querySelectorAll('.card')) {
    if (!card.querySelector('.chart svg') && !card.querySelector('#funnel')) continue;
    card.classList.add('exportable');
    if (card.querySelector('.figure-tools')) continue;
    const tools = document.createElement('div');
    tools.className = 'figure-tools';
    tools.innerHTML = figureTool('copy', 'Copy as image') + figureTool('download', 'Download as image');
    card.prepend(tools);
  }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('.figure-tools [data-figure]');
  if (!button) return;
  button.disabled = true;
  try {
    await figureAction(button, button.closest('.card'));
    flash(button, 'done');
  } catch (error) {
    console.error(error);
    flash(button, 'failed', button.dataset.figure === 'copy'
      ? 'Copying an image isn’t available in this browser — download it instead'
      : 'The image could not be made');
  } finally {
    button.disabled = false;
  }
});

// ---- Putting it together ----

function drawCharts() {
  curvesChart();
  gapChart();
  naiveChart();
  weightCharts();
  const panels = document.getElementById('panels');
  panels.innerHTML = '';
  const cards = SPEEDS.filter(speed => results.speeds[speed.key]).map(speed => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="chart"></div>';
    panels.append(card);
    return [speed, card];
  });
  for (const [speed, card] of cards) speedPanel(speed, results.speeds[speed.key], card);
  sharesChart();
  experienceChart('chesscom');
  experienceChart('lichess');
  sensitivityCharts();
  residualCharts();
  figureTools();
}

async function main() {
  results = await (await fetch('results.json')).json();
  fillValues();
  tiles();
  converter();
  conversionTable();
  funnel();
  linksTable();
  drawCharts();
  let width = window.innerWidth, timer;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(drawCharts, 150);
  });
  const math = () => window.renderMathInElement?.(document.body, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }] });
  if (window.renderMathInElement) math();
  else window.addEventListener('load', math);
}

main();
