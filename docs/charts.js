// SVG chart builders. Pure functions: (data, options) -> SVG string.
// Width is passed in, so charts are re-rendered on resize and text stays
// at real CSS pixel size instead of being scaled down on phones.

export const C = {
  accent: '#2f5d8a',
  accentSoft: '#6f9dc0',
  accentPale: '#dbe7f1',
  track: '#eef0f2',
  grid: '#e4e7ea',
  text: '#1b1e23',
  faint: '#6a727b',
  good: '#1a7f4b',
  watch: '#8a5200',
  flag: '#b3261e',
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const svg = (w, h, body, title) =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${body}</svg>`;

function truncate(str, chars) {
  const s = String(str ?? '');
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s;
}

/** Keep both ends of a long label: the distinguishing words are often at the end. */
function truncateMiddle(str, chars) {
  const s = String(str ?? '');
  if (s.length <= chars) return s;
  const head = Math.ceil((chars - 1) * 0.6);
  const tail = Math.floor((chars - 1) * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Greedy word wrap, for annotations drawn inside the SVG. */
function wrapText(str, maxChars) {
  const words = String(str ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Vertical bars with value labels. Highlights buckets from `highlightFrom`. */
export function histogram(buckets, { width = 640, height = 190, highlightFrom = 4 } = {}) {
  const padL = 8;
  const padR = 8;
  const padT = 26;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = buckets.length || 1;
  const slot = plotW / n;
  const barW = Math.min(64, slot * 0.58);
  const max = niceMax(Math.max(...buckets.map((b) => b.n), 1));

  const bars = buckets
    .map((b, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      const h = max ? (b.n / max) * plotH : 0;
      const y = padT + plotH - h;
      const hot = i >= highlightFrom;
      const fill = hot ? C.accent : C.accentSoft;
      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="3" fill="${fill}" />
        <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="${C.text}">${b.n}</text>
        <text x="${(x + barW / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="${C.faint}">${esc(b.label)}</text>`;
    })
    .join('');

  const axis = `<line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="${C.grid}" stroke-width="1"/>`;
  const note = `<text x="${padL}" y="14" font-size="11" fill="${C.faint}">days on market · darker = past the 90-day mark</text>`;

  return svg(width, height, axis + bars + note, 'Distribution of days on market');
}

/** Line + area over months. */
export function lineArea(points, { width = 640, height = 180, note = '' } = {}) {
  const padL = 34;
  const padR = 10;
  const noteLines = note ? wrapText(note, Math.max(28, Math.floor(width / 5.8))) : [];
  const padT = noteLines.length ? 10 + noteLines.length * 13 : 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = niceMax(Math.max(...points.map((p) => p.n), 1));
  const stepX = points.length > 1 ? plotW / (points.length - 1) : plotW;

  const xy = points.map((p, i) => [
    padL + stepX * i,
    padT + plotH - (p.n / max) * plotH,
  ]);

  const line = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${(padL + plotW).toFixed(1)},${padT + plotH} L${padL},${padT + plotH} Z`;

  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = padT + plotH - plotH * f;
      const val = Math.round(max * f);
      return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>
        <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="${C.faint}">${val}</text>`;
    })
    .join('');

  const labels = points
    .map((p, i) => {
      const last = points.length - 1;
      if (i !== last && (i % 4 !== 0 || last - i < 4)) return '';
      const [x] = xy[i];
      const [yy, mm] = p.month.split('-');
      const name = MONTHS[Number(mm) - 1] ?? '';
      return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="${C.faint}">${esc(name)} ${esc(yy.slice(2))}</text>`;
    })
    .join('');

  const noteText = noteLines.length
    ? `<text x="${padL}" y="12" font-size="10.5" fill="${C.watch}">${noteLines
        .map((line, i) => `<tspan x="${padL}" dy="${i === 0 ? 0 : 13}">${esc(line)}</tspan>`)
        .join('')}</text>`
    : '';

  const dots = points
    .map((p, i) => {
      const [x, y] = xy[i];
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="${C.accent}"/>`;
    })
    .join('');

  return svg(
    width,
    height,
    grid +
      `<path d="${area}" fill="${C.accentPale}"/>` +
      `<path d="${line}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round"/>` +
      dots +
      labels +
      noteText,
    'Open roles published per month'
  );
}

/** Horizontal bars: label left, bar right, value at the end. */
export function barH(items, { width = 640, rowH = 28, gap = 6, max: forcedMax } = {}) {
  const padT = 4;
  const padB = 4;
  const labelW = Math.min(220, Math.round(width * 0.46));
  const valueW = 52;
  const plotW = Math.max(40, width - labelW - valueW);
  const height = padT + padB + items.length * (rowH + gap);
  const max = forcedMax ?? Math.max(...items.map((d) => d.value), 1);
  const maxChars = Math.max(8, Math.floor(labelW / 6.2));

  const rows = items
    .map((d, i) => {
      const y = padT + i * (rowH + gap);
      const w = max ? Math.max(1, (d.value / max) * plotW) : 1;
      return `
        <text x="0" y="${(y + rowH / 2 + 4).toFixed(1)}" font-size="12" fill="${C.text}">${esc(truncateMiddle(d.label, maxChars))}</text>
        <rect x="${labelW}" y="${y + 4}" width="${plotW}" height="${rowH - 8}" rx="3" fill="${C.track}"/>
        <rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${d.color ?? C.accent}"/>
        <text x="${width}" y="${(y + rowH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="${C.text}">${esc(d.display ?? d.value)}</text>`;
    })
    .join('');

  return svg(width, height, rows, 'Bar chart');
}

/** Single 100% stacked bar plus a wrapped legend. */
export function stackedBar(items, { width = 640, barH = 26 } = {}) {
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  const palette = [C.accent, '#4b7ea8', '#7ea7c6', C.accentSoft, '#c3d5e3', C.accentPale, '#e8eef4'];
  const colorOf = (d, i) => d.color ?? palette[i % palette.length];
  let x = 0;

  const segs = items
    .map((d, i) => {
      const w = (d.value / total) * width;
      const seg = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(w, 0).toFixed(1)}" height="${barH}" fill="${colorOf(d, i)}"/>`;
      const label = w > 34
        ? `<text x="${(x + w / 2).toFixed(1)}" y="${barH / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="${i < 2 && !d.color ? '#fff' : C.text}">${Math.round((d.value / total) * 100)}%</text>`
        : '';
      x += w;
      return seg + label;
    })
    .join('');

  // Legend: two columns of text, wrapped.
  const cols = 2;
  const colW = width / cols;
  const legend = items
    .map((d, i) => {
      const cx = (i % cols) * colW;
      const cy = barH + 20 + Math.floor(i / cols) * 18;
      return `<rect x="${cx}" y="${cy - 8}" width="9" height="9" rx="2" fill="${colorOf(d, i)}"/>
        <text x="${cx + 14}" y="${cy}" font-size="11" fill="${C.text}">${esc(truncate(d.label, 24))} <tspan fill="${C.faint}">${d.value}</tspan></text>`;
    })
    .join('');

  const rows = Math.ceil(items.length / cols);
  const height = barH + 14 + rows * 18;

  return svg(width, height, segs + legend, 'Composition');
}

/** Two-series comparison, one row per metric, both normalised to per-1000. */
export function groupedBars(groups, { width = 640, rowH = 34, gap = 12 } = {}) {
  const labelW = Math.min(190, Math.round(width * 0.4));
  const valueW = 54;
  const plotW = Math.max(40, width - labelW - valueW);
  const height = groups.length * (rowH + gap);
  const max = Math.max(...groups.flatMap((g) => g.series.map((s) => s.value)), 1);

  const rows = groups
    .map((g, i) => {
      const y = i * (rowH + gap);
      const inner = g.series
        .map((s, j) => {
          const w = (s.value / max) * plotW;
          const yy = y + j * ((rowH - 4) / 2);
          return `<rect x="${labelW}" y="${yy.toFixed(1)}" width="${plotW}" height="${(rowH - 4) / 2 - 3}" rx="2" fill="${C.track}"/>
            <rect x="${labelW}" y="${yy.toFixed(1)}" width="${Math.max(w, 1).toFixed(1)}" height="${(rowH - 4) / 2 - 3}" rx="2" fill="${s.color}"/>
            <text x="${width}" y="${(yy + (rowH - 4) / 2 - 3).toFixed(1)}" text-anchor="end" font-size="11" font-weight="600" fill="${C.text}">${esc(s.display ?? s.value)}</text>`;
        })
        .join('');
      return `<text x="0" y="${(y + rowH / 2 + 4).toFixed(1)}" font-size="12" fill="${C.text}">${esc(g.label)}</text>${inner}`;
    })
    .join('');

  return svg(width, height, rows, 'Comparison');
}

export function legend(items) {
  return `<div class="legend">${items
    .map(
      (i) =>
        `<span class="legend-item"><i style="background:${i.color}"></i>${esc(i.label)}</span>`
    )
    .join('')}</div>`;
}
