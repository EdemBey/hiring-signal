import { parsePosting } from './parse.js';
import {
  computeMetrics,
  diagnostics,
  aiSignal,
  headline,
  offenders,
  hygieneReasons,
  ageDays,
} from './metrics.js';
import * as charts from './charts.js';

const API = 'https://api.smartrecruiters.com/v1/companies';
const CACHE_PREFIX = 'hs:v1:';
const PREV_PREFIX = 'hs:prev:v1:';
const CACHE_TTL = 60 * 60 * 1000;
const CONCURRENCY = 4;
const MAX_ROWS = 200;
const MAX_POSTINGS = 5000;

const app = document.getElementById('app');
const form = document.getElementById('controls');
const input = document.getElementById('company');
const chips = document.getElementById('chips');
const goBtn = document.getElementById('go');
const limitsSection = document.getElementById('limits-section');
const footMeta = document.getElementById('foot-meta');
const statusEl = document.getElementById('status');

const state = {
  company: null,
  vs: null,
  postings: null,
  vsPostings: null,
  metrics: null,
  vsMetrics: null,
  deep: null,
  deepIndex: null,
  fetchedAt: null,
  vsError: null,
  diff: null,
  loading: false,
  controller: null,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n) => Number(n).toLocaleString('en-GB');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const setStatus = (msg) => {
  if (statusEl) statusEl.textContent = msg;
};
const fmtDateTime = (d) =>
  new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// --- input ---------------------------------------------------------------

function normalizeCompany(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const fromUrl = s.match(/smartrecruiters\.com\/([^/?#\s]+)/i);
  if (fromUrl) return fromUrl[1];
  return s.replace(/^\/+|\/+$/g, '');
}

// --- network -------------------------------------------------------------

async function getPage(company, offset, signal, attempt = 0) {
  const url = `${API}/${encodeURIComponent(company)}/postings?limit=100&offset=${offset}`;
  try {
    const res = await fetch(url, { signal });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(900 * 2 ** attempt);
      return getPage(company, offset, signal, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (attempt < 2) {
      await sleep(700 * 2 ** attempt);
      return getPage(company, offset, signal, attempt + 1);
    }
    throw err;
  }
}

async function fetchBoard(company, signal, onProgress) {
  const first = await getPage(company, 0, signal);
  const total = first.totalFound ?? 0;
  if (!total) return { total: 0, raw: [] };
  if (total > MAX_POSTINGS) {
    throw new Error(
      `This board has ${nf(total)} postings. The page stops at ${nf(MAX_POSTINGS)} to stay polite to the API.`
    );
  }

  const raw = [...(first.content ?? [])];
  let loaded = raw.length;
  onProgress?.(loaded, total);

  const queue = [];
  for (let off = 100; off < total; off += 100) queue.push(off);

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const off = queue.shift();
      const page = await getPage(company, off, signal);
      raw.push(...(page.content ?? []));
      loaded += page.content?.length ?? 0;
      onProgress?.(Math.min(loaded, total), total);
    }
  });

  await Promise.all(workers);
  return { total, raw };
}

// --- cache ---------------------------------------------------------------

function readCache(company) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + company);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL) return null;
    return {
      ts: obj.ts,
      postings: obj.postings.map((p) => ({
        ...p,
        released: p.released ? new Date(p.released) : null,
      })),
    };
  } catch {
    return null;
  }
}

function writeCache(company, postings) {
  try {
    sessionStorage.setItem(
      CACHE_PREFIX + company,
      JSON.stringify({
        ts: Date.now(),
        postings: postings.map((p) => ({
          ...p,
          released: p.released ? p.released.toISOString() : null,
        })),
      })
    );
  } catch {
    /* quota — cache is a nicety, not a requirement */
  }
}

/**
 * Compare posting ids against the previous visit. Ids are stable and cannot be
 * faked by a bulk republish the way `releasedDate` can.
 */
function diffAgainstPrevious(company, postings) {
  const key = PREV_PREFIX + company;
  let prev = null;
  try {
    prev = JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    prev = null;
  }

  const ids = new Set(postings.map((p) => p.id));
  let diff = null;
  if (prev && Array.isArray(prev.ids) && Date.now() - prev.ts > 60 * 60 * 1000) {
    const prevIds = new Set(prev.ids);
    diff = {
      ts: prev.ts,
      added: [...ids].filter((id) => !prevIds.has(id)).length,
      removed: [...prevIds].filter((id) => !ids.has(id)).length,
    };
  }

  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), ids: [...ids].slice(0, MAX_POSTINGS) }));
  } catch {
    /* ignore */
  }
  return diff;
}

// --- states --------------------------------------------------------------

function renderEmpty() {
  state.metrics = null;
  limitsSection.hidden = true;
  footMeta.textContent = '';
  app.innerHTML = `
    <section>
      <div class="state">
        <h3>Start with a company identifier</h3>
        <p>
          Paste an identifier or any job URL. The page pulls the public postings board and
          turns it into diagnostics — nothing is uploaded, nothing is stored server-side.
        </p>
        <div class="examples">
          <button type="button" class="chip" data-company="Ramboll3">Try Ramboll3 →</button>
          <button type="button" class="chip" data-company="AFRY">Try AFRY →</button>
        </div>
      </div>
    </section>`;
}

function renderLoading(company) {
  limitsSection.hidden = true;
  footMeta.textContent = '';
  app.innerHTML = `
    <section>
      <div class="meta"><span>Loading <b>${esc(company)}</b>…</span></div>
      <div class="skeleton" style="margin-top:16px"></div>
      <div class="progress" id="progress">Fetching postings…</div>
      <div class="skeleton" style="margin-top:18px;height:80px"></div>
    </section>`;
}

function renderError(company, message) {
  limitsSection.hidden = true;
  footMeta.textContent = '';
  app.innerHTML = `
    <section>
      <div class="state">
        <h3>Could not load <code>${esc(company)}</code></h3>
        <p>${esc(message)}</p>
        <div class="examples">
          <button type="button" class="chip" id="retry">Retry</button>
          <button type="button" class="chip" data-company="Ramboll3">Ramboll3</button>
        </div>
      </div>
    </section>`;
  document.getElementById('retry')?.addEventListener('click', () => load(company, { refresh: true }));
}

function renderNotFound(company) {
  limitsSection.hidden = true;
  footMeta.textContent = '';
  app.innerHTML = `
    <section>
      <div class="state">
        <h3>No public postings for <code>${esc(company)}</code></h3>
        <p>
          The board is either empty, private, or the identifier is wrong. The identifier is the
          segment right after <code>jobs.smartrecruiters.com/</code> — for example
          <code>jobs.smartrecruiters.com/<b>Ramboll3</b>/744000151575689</code>.
        </p>
        <div class="examples">
          <button type="button" class="chip" data-company="Ramboll3">Ramboll3</button>
          <button type="button" class="chip" data-company="AFRY">AFRY</button>
        </div>
      </div>
    </section>`;
}

// --- report --------------------------------------------------------------

const VERDICT_LABEL = {
  good: 'healthy',
  watch: 'worth a look',
  flag: 'needs attention',
  na: 'not measurable',
};
const PILL = { good: 'ok', watch: 'watch', flag: 'act', na: 'n/a' };

function renderReport() {
  const m = state.metrics;
  const ds = diagnostics(m).map((d) => (m.smallSample ? { ...d, verdict: 'na' } : d));
  const top = m.smallSample ? null : headline(m, ds);
  const ai = aiSignal(m, state.deep);

  document.title = `${m.companyName ?? state.company} — hiring signals`;

  const heroNum = (num, lbl) => `<div><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;

  const cards = ds
    .map(
      (d) => `
      <div class="card" id="card-${d.id}">
        <div class="top">
          <span class="name">${esc(d.label)}</span>
          <span class="val ${d.verdict}">${esc(d.display)}</span>
        </div>
        <div class="detail"><span class="pill ${d.verdict}">${PILL[d.verdict] ?? 'n/a'}</span>${esc(d.detail)}</div>
        <p class="so">${esc(d.soWhat)}</p>
        <div class="do"><b>What I would do:</b> ${esc(d.action)}</div>
        <div class="cav">${esc(d.caveat)}</div>
        ${drillDown(d.id, m, state.postings)}
      </div>`
    )
    .join('');

  const verdictBlock = top
    ? `<div class="verdict ${top.verdict}">
         <span class="tag">${VERDICT_LABEL[top.verdict]} · ${esc(top.label)}</span>
         <p><b>${esc(top.detail)}.</b> ${esc(top.soWhat)}</p>
       </div>`
    : '';

  const diffLine =
    state.diff && (state.diff.added || state.diff.removed)
      ? `<p class="diff">Since your last visit on ${fmtDate(state.diff.ts)}:
           <b>+${nf(state.diff.added)}</b> new,
           <b>−${nf(state.diff.removed)}</b> closed.</p>`
      : '';

  app.innerHTML = `
    <section>
      <div class="meta">
        <span><b>${esc(m.companyName ?? state.company)}</b> · <code>${esc(state.company)}</code></span>
        <span>Live data: <b>${fmtDateTime(state.fetchedAt)}</b></span>
        <span>n = <b>${nf(m.total)}</b> postings</span>
        ${m.managers ? `<span>${nf(m.managers)} managers · ${nf(m.orgPaths)} org paths</span>` : ''}
        ${state.vs ? `<span>vs <b>${esc(state.vs)}</b></span>` : ''}
      </div>

      <div class="hero">
        ${heroNum(nf(m.total), 'open roles on the public board')}
        ${heroNum(pct(m.staleShare), 'older than 90 days')}
        ${heroNum(nf(m.countryCount), 'countries with at least one role')}
        ${heroNum(`${nf(m.aiInTitle.count)}<small> / ${nf(m.total)}</small>`, 'mention AI in the job title')}
      </div>

      ${verdictBlock}
      ${diffLine}

      <div style="margin-top:34px">
        <h2>Diagnostics</h2>
        ${
          m.smallSample
            ? `<p class="hint" style="margin:0 0 12px">Small board — only ${nf(m.total)} ${m.total === 1 ? 'posting' : 'postings'}. Every percentage below is noise at this size; read it as a list, not a rate.</p>`
            : ''
        }
        <div class="cards">${cards}</div>
        ${thresholdsBlock(m)}
      </div>

      <div style="margin-top:40px" id="compare-slot"></div>

      <div style="margin-top:40px">
        <h2>What the numbers look like</h2>

        <figure>
          <figcaption><b>${pct(m.staleShare)}</b> of open roles are older than 90 days. Median time on market is ${m.medianAge ?? '—'} days, p90 is ${m.p90 ?? '—'}, and ${nf(m.stale180)} roles have been open for more than six months.</figcaption>
          <div data-chart="age"></div>
        </figure>

        <figure>
          <figcaption><b>Posting volume by month.</b> Read the shape, not the absolute numbers — boards are often republished in bulk.</figcaption>
          <div data-chart="monthly"></div>
        </figure>

        <figure>
          <figcaption><b>Where the roles are.</b> ${nf(m.countryCount)} countries, top 12 shown; ${nf(m.thinCountries)} have two or fewer.</figcaption>
          <div data-chart="countries"></div>
        </figure>

        <figure>
          <figcaption><b>Where the hiring is concentrated.</b> Share of open roles by ${esc(m.grouping?.label ?? 'business area')}.</figcaption>
          <div data-chart="gba"></div>
        </figure>

        <figure>
          <figcaption><b>Seniority mix.</b> ${pct(m.entryShare)} of roles are entry level or internships.</figcaption>
          <div data-chart="seniority"></div>
        </figure>

        <figure>
          <figcaption><b>Duplicate clusters.</b> ${nf(m.duplicates.postings)} postings repeat a title already open in the same city.</figcaption>
          <div data-chart="duplicates"></div>
        </figure>

      </div>

      <div style="margin-top:40px" id="deep-slot"></div>
    </section>`;

  limitsSection.hidden = false;

  footMeta.innerHTML = `
    Live data: ${fmtDateTime(state.fetchedAt)} ·
    <button type="button" class="ghost" id="refresh" style="font-size:12px;padding:3px 9px;margin-left:6px">Refresh</button>`;
  document.getElementById('refresh')?.addEventListener('click', () =>
    load(state.company, { refresh: true, vs: state.vs })
  );

  paintCharts();
  renderComparison();
  renderDeep(ai);
}

function thresholdsBlock(m) {
  return `
    <details class="method">
      <summary>Where these lines come from</summary>
      <div class="method-body">
        <p>These are judgment calls, not industry benchmarks. They are set so a typical board lands in “worth a look”, not so that every board fails.</p>
        <ul>
          <li><b>90 days</b> — roughly where an open role is either genuinely hard to fill or already dead and nobody took it down.</li>
          <li><b>10% / 25%</b> — the share of the board past that line before it changes the story rather than being a handful of edge cases.</li>
          <li><b>2 postings per country</b> — below this a country has no local hiring engine, only a presence.</li>
          <li><b>30 postings</b> — under this every percentage is noise, so nothing gets a verdict colour.</li>
        </ul>
        <p class="mono">Thresholds live in <code>docs/metrics.js</code>. Every number on this page is reproducible:</p>
        <p class="mono"><code>python3 -m http.server 8000 --directory docs</code> → <code>/?company=${esc(state.company)}${state.vs ? `&amp;vs=${esc(state.vs)}` : ''}</code></p>
      </div>
    </details>`;
}

/** The actual postings behind a number. A count you cannot inspect is an opinion. */
function drillDown(id, m, postings) {
  if (!postings?.length) return '';
  const count = offenders(id, postings, m).length;
  if (!count) return '';
  return `
    <details class="drill" data-drill="${id}">
      <summary>${nf(count)} ${count === 1 ? 'role' : 'roles'} behind this number</summary>
      <div class="drill-body" data-drill-body></div>
    </details>`;
}

/**
 * Built on first open: six lists of up to 200 rows is a lot of DOM to create
 * for something most readers never expand.
 */
function fillDrill(details) {
  const body = details.querySelector('[data-drill-body]');
  if (!body || body.dataset.filled) return;
  body.dataset.filled = '1';

  const m = state.metrics;
  const id = details.dataset.drill;
  const rows = offenders(id, state.postings, m);
  const now = new Date(m.generatedAt);

  const sorted = [...rows].sort((a, b) => {
    if (id === 'duplicates') return a.title.localeCompare(b.title);
    return (ageDays(b, now) ?? -1) - (ageDays(a, now) ?? -1);
  });
  const shown = sorted.slice(0, MAX_ROWS);
  const showMissing = id === 'hygiene';

  const trs = shown
    .map((p) => {
      const place = [p.city, p.country ?? p.countryCode].filter(Boolean).join(', ');
      const sub = [place, p.ref].filter(Boolean).join(' · ');
      const days = ageDays(p, now);
      const title = p.url
        ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
        : esc(p.title);
      const missing = showMissing
        ? `<td class="why">${esc(hygieneReasons(p, m.published).join(', ') || '—')}</td>`
        : '';
      return `<tr><td>${title}<span class="sub">${esc(sub)}</span></td><td class="num">${days ?? '—'}</td>${missing}</tr>`;
    })
    .join('');

  body.innerHTML = `
    <div class="tw">
      <table>
        <thead><tr><th>Role</th><th class="num">Days</th>${showMissing ? '<th>Missing</th>' : ''}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
    <p class="hint">
      ${shown.length < rows.length ? `Showing ${nf(shown.length)} of ${nf(rows.length)}, oldest first. ` : ''}
      <a href="https://jobs.smartrecruiters.com/${esc(state.company)}" target="_blank" rel="noopener">Open the board →</a>
    </p>`;
}

function countryName(code) {
  return state.metrics.countryNames?.get(code) || code;
}

function paintCharts() {
  const m = state.metrics;
  if (!m) return;
  const width = Math.max(280, app.clientWidth - 34);

  const builders = {
    age: () => charts.histogram(m.ageBuckets, { width }),
    monthly: () => {
      const last2 = m.monthly.slice(-2).reduce((s, p) => s + p.n, 0);
      const share = m.total ? last2 / m.total : 0;
      let note = '';
      if (m.bulkDay && m.bulkDay.share > 0.08) {
        note = `${nf(m.bulkDay.count)} postings share one release date (${fmtDate(m.bulkDay.date)}). Dates are bulk-set — read the shape, not the peak.`;
      } else if (share > 0.4) {
        note = `${Math.round(share * 100)}% of postings are dated in the last two months — likely a bulk republish.`;
      }
      return charts.lineArea(m.monthly, { width, note });
    },
    countries: () =>
      charts.barH(
        m.countries.slice(0, 12).map((c) => ({
          label: countryName(c.name),
          value: c.n,
          display: nf(c.n),
        })),
        { width }
      ),
    gba: () =>
      charts.stackedBar(
        (m.grouping?.items ?? m.gbas).slice(0, 7).map((g) => ({ label: g.name, value: g.n })),
        { width }
      ),
    seniority: () =>
      charts.stackedBar(
        m.seniority.slice(0, 6).map((g) => ({
          label: g.name,
          value: g.n,
          color: String(g.name).toLowerCase() === 'not applicable' ? '#c9ccd1' : undefined,
        })),
        { width }
      ),
    duplicates: () =>
      charts.barH(
        m.duplicates.top.map((d) => ({
          label: `${d.title} · ${d.cities} ${d.cities === 1 ? 'city' : 'cities'}`,
          value: d.postings,
          display: `${d.postings}×`,
        })),
        { width, max: Math.max(...m.duplicates.top.map((d) => d.postings), 1) }
      ),
  };

  for (const node of app.querySelectorAll('[data-chart]')) {
    const build = builders[node.dataset.chart];
    if (build) node.innerHTML = build();
  }
}

const per1000 = (m, key) => {
  if (!m?.total) return 0;
  if (key === 'stale') return (m.stale90 / m.total) * 1000;
  if (key === 'duplicates') return (m.duplicates.postings / m.total) * 1000;
  if (key === 'entry') return (m.entryCount / m.total) * 1000;
  return 0;
};

const numOrDash = (v) => (v == null ? '—' : nf(v));
const pctOrDash = (v) => (v == null ? '—' : pct(v));

/** Union of two breakdowns, sorted by the larger of the two. */
function mixItems(a, b, totalA, totalB, limit = 8) {
  const map = new Map();
  for (const it of a) map.set(it.name, { label: it.name, a: it.n, b: 0 });
  for (const it of b) {
    const cur = map.get(it.name) ?? { label: it.name, a: 0, b: 0 };
    cur.b = it.n;
    map.set(it.name, cur);
  }
  return [...map.values()]
    .sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b) || x.label.localeCompare(y.label))
    .slice(0, limit)
    .map((d) => ({
      ...d,
      aPct: totalA ? d.a / totalA : 0,
      bPct: totalB ? d.b / totalB : 0,
    }));
}

function comparisonRows(m, v) {
  const rows = [
    { label: 'Open roles', a: m.total, b: v.total, fmt: numOrDash, delta: 'n', tone: 'neutral' },
    { label: 'Countries hiring', a: m.countryCount, b: v.countryCount, fmt: numOrDash, delta: 'n', tone: 'neutral' },
    { label: 'Median days on market', a: m.medianAge, b: v.medianAge, fmt: numOrDash, delta: 'd', tone: 'lower' },
    { label: '90th percentile days', a: m.p90, b: v.p90, fmt: numOrDash, delta: 'd', tone: 'lower' },
    { label: 'Roles older than 90 days', a: m.staleShare, b: v.staleShare, fmt: pctOrDash, delta: 'pp', tone: 'lower' },
    { label: 'Duplicate postings', a: m.duplicates.share, b: v.duplicates.share, fmt: pctOrDash, delta: 'pp', tone: 'lower' },
    { label: 'Entry-level roles', a: m.entryShare, b: v.entryShare, fmt: pctOrDash, delta: 'pp', tone: 'higher' },
    { label: 'AI in job titles', a: m.aiInTitle.share, b: v.aiInTitle.share, fmt: pctOrDash, delta: 'pp', tone: 'neutral' },
  ];

  return rows
    .map((r) => {
      const cells = `<td>${esc(r.label)}</td><td class="num">${r.fmt(r.a)}</td><td class="num">${r.fmt(r.b)}</td>`;
      if (r.a == null || r.b == null) return `<tr>${cells}<td class="num delta flat">—</td></tr>`;

      const diff = r.a - r.b;
      const scaled = r.delta === 'pp' ? diff * 100 : diff;
      const decimals = r.delta === 'pp' ? 1 : 0;
      const shown = Math.abs(scaled).toFixed(decimals);
      const unit = r.delta === 'pp' ? 'pp' : r.delta === 'd' ? 'd' : '';

      if (Number(shown) === 0) {
        return `<tr>${cells}<td class="num delta flat">—</td></tr>`;
      }

      const sign = scaled > 0 ? '+' : '−';
      let tone = 'flat';
      if (r.tone === 'lower') tone = diff < 0 ? 'good' : 'bad';
      else if (r.tone === 'higher') tone = diff > 0 ? 'good' : 'bad';

      return `<tr>${cells}<td class="num delta ${tone}">${sign}${shown}${unit}</td></tr>`;
    })
    .join('');
}

function renderComparison() {
  const slot = document.getElementById('compare-slot');
  if (!slot) return;
  const m = state.metrics;

  if (!state.vs) {
    slot.innerHTML = `
      <p class="hint" style="margin:0">
        Add <code>&amp;vs=AFRY</code> to the URL to put two boards side by side.
      </p>`;
    return;
  }

  if (state.vsError) {
    slot.innerHTML = `
      <div class="state" style="text-align:left;padding:18px 20px">
        <h3 style="font-size:15px">Could not load <code>${esc(state.vs)}</code></h3>
        <p style="margin:0;font-size:14px">${esc(state.vsError)}</p>
        <div class="examples" style="justify-content:flex-start;margin-top:12px">
          <button type="button" class="chip" id="retry-vs">Retry comparison</button>
        </div>
      </div>`;
    document.getElementById('retry-vs')?.addEventListener('click', () => {
      state.vsError = null;
      renderComparison();
      loadComparison(state.vs, state.controller?.signal);
    });
    return;
  }

  const v = state.vsMetrics;
  if (!v) {
    slot.innerHTML = `
      <figure>
        <figcaption><b>Loading comparison board <code>${esc(state.vs)}</code>…</b></figcaption>
        <div class="skeleton" style="height:120px"></div>
      </figure>`;
    return;
  }

  const width = Math.max(280, app.clientWidth - 34);
  const nameA = m.companyName ?? state.company;
  const nameB = v.companyName ?? state.vs;

  // Time on market: same buckets, share of each board.
  const ageData = m.ageBuckets.map((bucket, i) => ({
    label: `${bucket.label} days`,
    series: [
      {
        value: m.total ? (bucket.n / m.total) * 100 : 0,
        display: `${m.total ? Math.round((bucket.n / m.total) * 100) : 0}%`,
        color: charts.C.accent,
      },
      {
        value: v.total ? (v.ageBuckets[i].n / v.total) * 100 : 0,
        display: `${v.total ? Math.round((v.ageBuckets[i].n / v.total) * 100) : 0}%`,
        color: charts.C.accentSoft,
      },
    ],
  }));

  // Function mix — the one breakdown both boards publish.
  const canMix = m.functions.length > 0 && v.functions.length > 0;
  const mix = canMix ? mixItems(m.functions, v.functions, m.total, v.total, 8) : [];
  const mixData = mix.map((it) => ({
    label: it.label,
    series: [
      { value: it.aPct * 100, display: `${Math.round(it.aPct * 100)}%`, color: charts.C.accent },
      { value: it.bPct * 100, display: `${Math.round(it.bPct * 100)}%`, color: charts.C.accentSoft },
    ],
  }));

  slot.innerHTML = `
    <h2>Side by side</h2>
    <figure>
      <figcaption><b>${esc(nameA)} vs ${esc(nameB)}.</b> Both boards read live in the same run.</figcaption>

      <div class="tw">
        <table class="cmp">
          <thead>
            <tr><th></th><th class="num">${esc(nameA)}</th><th class="num">${esc(nameB)}</th><th class="num">Δ</th></tr>
          </thead>
          <tbody>${comparisonRows(m, v)}</tbody>
        </table>
      </div>
      <p class="hint">
        Δ is ${esc(nameA)} minus ${esc(nameB)}. Colour marks which board is ahead on that measure,
        not which company is better. Grey deltas are context only — a bigger board is not a better one.
      </p>

      <div style="margin-top:22px">
        <figcaption><b>Time on market, same buckets.</b> Share of each board in each age band.</figcaption>
        <div id="cmp-age"></div>
        ${charts.legend([
          { label: nameA, color: charts.C.accent },
          { label: nameB, color: charts.C.accentSoft },
        ])}
      </div>

      <div style="margin-top:22px">
        <figcaption><b>Function mix.</b> ${
          canMix
            ? 'Share of each board by job function — the one breakdown both publish.'
            : 'Not comparable: one of the boards does not publish job functions.'
        }</figcaption>
        <div id="cmp-mix"></div>
        ${canMix ? charts.legend([
          { label: nameA, color: charts.C.accent },
          { label: nameB, color: charts.C.accentSoft },
        ]) : ''}
      </div>

      <p class="hint" style="margin-top:14px">
        Month-on-month volume is deliberately not compared: both boards republish in bulk, so a
        monthly line would show the batch, not the hiring.
      </p>
    </figure>`;

  document.getElementById('cmp-age').innerHTML = charts.groupedBars(ageData, { width });
  if (canMix) {
    document.getElementById('cmp-mix').innerHTML = charts.groupedBars(mixData, { width });
  } else {
    document.getElementById('cmp-mix').innerHTML =
      '<p class="hint">Both boards need a published function field for this chart.</p>';
  }
}

function renderDeep(ai) {
  const slot = document.getElementById('deep-slot');
  if (!slot) return;
  const d = state.deep;

  const cards = ai
    .map(
      (r) => `<div class="card">
        <div class="top">
          <span class="name">${esc(r.label)}</span>
          <span class="val">${esc(r.display)}</span>
        </div>
        <div class="detail">${esc(r.note)}</div>
      </div>`
    )
    .join('');

  if (!d) {
    slot.innerHTML = `
      <h2>AI signal</h2>
      <div class="cards">${cards}</div>
      <p class="hint" style="margin-top:10px">
        Full-description analysis is pre-computed per company and not available for this board.
        Titles are read live; descriptions are not.
      </p>`;
    return;
  }

  slot.innerHTML = `
    <h2>AI signal</h2>
    <div class="cards">${cards}</div>
    <figure style="margin-top:16px">
      <figcaption><b>What the descriptions actually say.</b> ${nf(d.aiMentions)} of ${nf(d.analysed)} postings mention AI, machine learning or automation anywhere in the text.</figcaption>
      <div data-chart="terms"></div>
      <p class="hint" style="margin-top:10px">
        Text analysis: snapshot ${fmtDate(d.generatedAt)} ·
        average description ${nf(d.avgWords)} words ·
        ${nf(d.emptyQualifications)} postings with no separate qualifications section.
      </p>
    </figure>`;

  const width = Math.max(280, app.clientWidth - 34);
  const terms = document.querySelector('[data-chart="terms"]');
  if (terms) {
    terms.innerHTML = charts.barH(
      (d.topTerms ?? []).slice(0, 8).map(([term, n]) => ({ label: term, value: n, display: nf(n) })),
      { width }
    );
  }
}

// --- orchestration -------------------------------------------------------

async function load(company, { refresh = false, vs = null } = {}) {
  const id = normalizeCompany(company);
  if (!id) {
    renderEmpty();
    return;
  }
  const vsId = vs ? normalizeCompany(vs) : null;

  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;

  state.company = id;
  state.vs = vsId;
  state.vsMetrics = null;
  state.vsPostings = null;
  state.vsError = null;
  state.diff = null;
  input.value = id;
  goBtn.disabled = true;
  setChips(id);
  syncUrl(id, vsId);

  if (!refresh) {
    const cached = readCache(id);
    if (cached) {
      state.postings = cached.postings;
      state.fetchedAt = cached.ts;
      state.metrics = computeMetrics(cached.postings);
      state.diff = diffAgainstPrevious(id, cached.postings);
      await loadDeep(id);
      renderReport();
      setStatus(`Loaded ${nf(state.metrics.total)} postings for ${state.metrics.companyName ?? id}`);
      goBtn.disabled = false;
      if (vsId) loadComparison(vsId, signal);
      return;
    }
  }

  renderLoading(id);
  try {
    const { total, raw } = await fetchBoard(id, signal, (loaded, all) => {
      const p = document.getElementById('progress');
      if (p) p.textContent = `Fetching postings… ${nf(loaded)} / ${nf(all)}`;
    });

    if (!total || raw.length === 0) {
      renderNotFound(id);
      goBtn.disabled = false;
      return;
    }

    const postings = raw.map((p) => parsePosting(p, id));
    state.postings = postings;
    state.fetchedAt = Date.now();
    state.metrics = computeMetrics(postings);
    state.diff = diffAgainstPrevious(id, postings);
    writeCache(id, postings);

    await loadDeep(id);
    renderReport();
    setStatus(`Loaded ${nf(state.metrics.total)} postings for ${state.metrics.companyName ?? id}`);
    goBtn.disabled = false;

    if (vsId) loadComparison(vsId, signal);
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderError(id, err.message || 'Network error');
    goBtn.disabled = false;
  }
}

async function loadComparison(vsId, signal) {
  try {
    const { total, raw } = await fetchBoard(vsId, signal);
    if (!total || !raw.length) {
      state.vsError = `No public postings found for ${vsId}.`;
      renderComparison();
      return;
    }
    state.vsPostings = raw.map((p) => parsePosting(p, vsId));
    state.vsMetrics = computeMetrics(state.vsPostings);
    renderComparison();
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.vsError = err.message || 'Network error';
    renderComparison();
  }
}

async function loadDeepIndex() {
  try {
    const res = await fetch('deep/index.json');
    if (res.ok) {
      const data = await res.json();
      state.deepIndex = new Set(data.companies ?? []);
    }
  } catch {
    state.deepIndex = null;
  }
}

async function loadDeep(company) {
  state.deep = null;
  const key = company.toLowerCase();
  if (state.deepIndex && !state.deepIndex.has(key)) return;
  try {
    const res = await fetch(`deep/${key}.json`);
    if (res.ok) state.deep = await res.json();
  } catch {
    /* optional */
  }
}

function setChips(company) {
  for (const chip of chips.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.company === company));
  }
}

function syncUrl(company, vs) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('company', company);
    if (vs) url.searchParams.set('vs', vs);
    else url.searchParams.delete('vs');
    history.replaceState(null, '', url);
  } catch {
    /* file:// or sandboxed context */
  }
}

// --- wiring --------------------------------------------------------------

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const vs = new URLSearchParams(window.location.search).get('vs');
  load(input.value, { vs });
});

// `toggle` does not bubble, so listen in the capture phase.
app.addEventListener(
  'toggle',
  (e) => {
    if (e.target instanceof HTMLDetailsElement && e.target.open && e.target.dataset.drill) {
      fillDrill(e.target);
    }
  },
  true
);

// One delegated handler covers the preset chips and the in-state buttons.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-company]');
  if (btn?.dataset.company) load(btn.dataset.company);
});

let resizeTimer = null;
let lastWidth = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = app.clientWidth;
    if (Math.abs(w - lastWidth) < 24) return;
    lastWidth = w;
    if (state.metrics) {
      paintCharts();
      renderComparison();
      renderDeep(aiSignal(state.metrics, state.deep));
    }
  }, 160);
});

// --- boot ----------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const initial = params.get('company');
const initialVs = params.get('vs');
if (initial) {
  loadDeepIndex().then(() => load(initial, { vs: initialVs }));
} else {
  renderEmpty();
}
lastWidth = app.clientWidth;
