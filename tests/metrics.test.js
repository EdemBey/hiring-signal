import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeMetrics, diagnostics, headline, aiSignal } from '../docs/metrics.js';

const NOW = new Date('2026-10-27T12:00:00Z');

function posting(over = {}) {
  return {
    id: '1',
    title: 'Engineer',
    company: 'Acme',
    released: new Date('2026-10-20T00:00:00Z'),
    city: 'Copenhagen',
    countryCode: 'DK',
    country: 'Denmark',
    gba: 'Energy',
    experience: 'Mid-Senior Level',
    employment: 'Full-time',
    org: { manager: 'Jane Doe', path: 'Energy- Power', flags: [] },
    costCentreCode: '1107145',
    fields: { supervisory: true, costCentre: true, gba: true, experience: true },
    ...over,
  };
}

const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

test('age buckets are exclusive at the top and count correctly', () => {
  const m = computeMetrics(
    [
      posting({ released: daysAgo(0) }),
      posting({ released: daysAgo(14) }),
      posting({ released: daysAgo(15) }),
      posting({ released: daysAgo(90) }),
      posting({ released: daysAgo(91) }),
      posting({ released: daysAgo(400) }),
    ],
    NOW
  );
  assert.deepEqual(
    m.ageBuckets.map((b) => b.n),
    [2, 1, 0, 1, 1, 1]
  );
  assert.equal(m.stale90, 2);
  assert.equal(m.oldest, 400);
});

test('percentiles use the sorted age list', () => {
  const m = computeMetrics(
    [1, 2, 3, 4, 5].map((n) => posting({ released: daysAgo(n) })),
    NOW
  );
  assert.equal(m.medianAge, 3);
  assert.equal(m.p75, 4);
  assert.equal(m.p90, 5);
});

test('duplicates cluster on title + city + country', () => {
  const m = computeMetrics(
    [
      posting({ id: 'a', title: 'Engineer' }),
      posting({ id: 'b', title: 'engineer' }),
      posting({ id: 'c', title: 'Engineer', city: 'Aarhus' }),
      posting({ id: 'd', title: 'Manager' }),
    ],
    NOW
  );
  assert.equal(m.duplicates.groups, 1);
  assert.equal(m.duplicates.postings, 2);
  assert.equal(m.duplicates.top[0].title, 'engineer');
});

test('missing fields are counted once per posting, not once per field', () => {
  const m = computeMetrics(
    [
      posting({ id: 'a', experience: null, org: { manager: null, path: null }, costCentreCode: null }),
      posting({ id: 'b', experience: null }),
      posting({ id: 'c' }),
    ],
    NOW
  );
  assert.equal(m.missing.any, 2);
  assert.equal(m.missing.experience, 2);
  assert.equal(m.missing.share, 2 / 3);
});

test('entry share covers Entry Level and Internship', () => {
  const m = computeMetrics(
    [
      posting({ id: 'a', experience: 'Entry Level' }),
      posting({ id: 'b', experience: 'Internship' }),
      posting({ id: 'c', experience: 'Mid-Senior Level' }),
      posting({ id: 'd', experience: 'Executive' }),
    ],
    NOW
  );
  assert.equal(m.entryCount, 2);
  assert.equal(m.entryShare, 0.5);
});

test('AI in title matches whole words only', () => {
  const m = computeMetrics(
    [
      posting({ id: 'a', title: 'AI Intern' }),
      posting({ id: 'b', title: 'Machine Learning Engineer' }),
      posting({ id: 'c', title: 'Sustainability Consultant' }),
      posting({ id: 'd', title: 'Retail Assistant' }),
    ],
    NOW
  );
  assert.equal(m.aiInTitle.count, 2);
  assert.deepEqual(m.aiInTitle.titles.sort(), ['AI Intern', 'Machine Learning Engineer']);
});

test('monthly series is 24 months, zero-filled', () => {
  const m = computeMetrics([posting({ released: daysAgo(0) })], NOW);
  assert.equal(m.monthly.length, 24);
  assert.equal(m.monthly.at(-1).month, '2026-10');
  assert.equal(m.monthly.at(-1).n, 1);
  assert.equal(m.monthly.at(-2).n, 0);
});

test('diagnostics returns six signals with verdicts', () => {
  const ds = diagnostics(computeMetrics([posting()], NOW));
  assert.equal(ds.length, 6);
  for (const d of ds) {
    assert.ok(['good', 'watch', 'flag'].includes(d.verdict), d.id);
    assert.ok(d.soWhat && d.action && d.caveat, d.id);
  }
});

test('verdict thresholds follow the documented scale', () => {
  const build = (over) => diagnostics(computeMetrics([posting(over)], NOW));
  // 0 of 1 stale -> good; 1 of 1 stale -> flag
  assert.equal(build({ released: daysAgo(10) }).find((d) => d.id === 'stale').verdict, 'good');
  assert.equal(build({ released: daysAgo(200) }).find((d) => d.id === 'stale').verdict, 'flag');
});

test('headline prefers the worst flagged signal', () => {
  const m = computeMetrics(
    Array.from({ length: 10 }, (_, i) =>
      posting({ id: String(i), released: daysAgo(200), experience: null })
    ),
    NOW
  );
  const top = headline(m, diagnostics(m));
  assert.ok(top);
  assert.equal(top.verdict, 'flag');
});

test('aiSignal adds the deep row only when the snapshot exists', () => {
  const m = computeMetrics([posting({ title: 'AI Intern' })], NOW);
  assert.equal(aiSignal(m, null).length, 1);
  assert.equal(
    aiSignal(m, { aiMentions: 10, analysed: 100, generatedAt: NOW.toISOString() }).length,
    2
  );
});

test('a board that does not publish a field is not flagged for missing it', () => {
  const bare = { supervisory: false, costCentre: false, gba: false, experience: true };
  const m = computeMetrics(
    [
      posting({ id: 'a', org: { manager: null, path: null }, costCentreCode: null, fields: bare }),
      posting({ id: 'b', org: { manager: null, path: null }, costCentreCode: null, fields: bare }),
    ],
    NOW
  );
  assert.equal(m.published.supervisory, false);
  assert.equal(m.missing.applicable, true);
  assert.equal(m.missing.any, 0);
  assert.deepEqual(m.missing.fields, ['experience level']);
});

test('a board with no measurable hygiene field reports n/a, not a failure', () => {
  const none = { supervisory: false, costCentre: false, gba: false, experience: false };
  const m = computeMetrics(
    [posting({ id: 'a', experience: null, org: { manager: null }, costCentreCode: null, fields: none })],
    NOW
  );
  assert.equal(m.missing.applicable, false);
  const hygiene = diagnostics(m).find((d) => d.id === 'hygiene');
  assert.equal(hygiene.verdict, 'na');
  assert.equal(hygiene.display, 'n/a');
});

test('grouping falls back to function when there is no business area', () => {
  const bare = { supervisory: false, costCentre: false, gba: false, experience: true };
  const m = computeMetrics(
    [
      posting({ id: 'a', gba: null, fn: 'Engineering', fields: bare }),
      posting({ id: 'b', gba: null, fn: 'Engineering', fields: bare }),
      posting({ id: 'c', gba: null, fn: 'Sales', fields: bare }),
    ],
    NOW
  );
  assert.equal(m.grouping.label, 'function');
  assert.equal(m.grouping.items[0].name, 'Engineering');
  assert.equal(m.grouping.items[0].n, 2);
});

test('empty board does not divide by zero', () => {
  const m = computeMetrics([], NOW);
  assert.equal(m.total, 0);
  assert.equal(m.staleShare, 0);
  assert.equal(m.entryShare, 0);
  assert.equal(m.duplicates.share, 0);
  assert.equal(m.missing.share, 0);
  assert.doesNotThrow(() => diagnostics(m));
});
