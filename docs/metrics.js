// Aggregation + diagnostics. Pure functions, no DOM.
// Everything here runs on the live list endpoint payload.

const DAY = 86400000;

const AGE_BUCKETS = [
  { label: '0–14', max: 14 },
  { label: '15–30', max: 30 },
  { label: '31–60', max: 60 },
  { label: '61–90', max: 90 },
  { label: '91–180', max: 180 },
  { label: '180+', max: Infinity },
];

const ENTRY_LEVELS = new Set(['entry level', 'internship', 'student']);
const MISSING_LEVELS = new Set(['', 'not applicable', 'n/a', 'na', 'none', '-', '—', 'unspecified']);

const isMissingExperience = (value) =>
  MISSING_LEVELS.has(String(value ?? '').trim().toLowerCase());
const AI_TITLE_RE =
  /\b(ai|a\.i\.|artificial intelligence|machine learning|ml|llm|genai|generative ai)\b/i;

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null || key === '') continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function toSortedArray(map) {
  return [...map.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

export function duplicateKey(p) {
  return `${String(p.title ?? '').toLowerCase()}|${p.city ?? ''}|${p.countryCode ?? ''}`;
}

/** Why a posting fails the hygiene check, given what the board publishes. */
export function hygieneReasons(p, published) {
  const reasons = [];
  if (published.experience && isMissingExperience(p.experience)) reasons.push('experience level');
  if (published.supervisory && !p.org?.manager) reasons.push('manager');
  if (published.costCentre && !p.costCentreCode) reasons.push('cost centre');
  return reasons;
}

export function ageDays(posting, now) {
  if (!posting.released) return null;
  const base = now instanceof Date ? now.getTime() : now;
  return Math.max(0, Math.floor((base - posting.released.getTime()) / DAY));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ageInDays(released, now) {
  return Math.floor((now - released) / DAY);
}

export function computeMetrics(postings, now = new Date()) {
  const ages = [];
  const ageBuckets = AGE_BUCKETS.map((b) => ({ label: b.label, n: 0 }));
  const monthlyMap = new Map();
  const dupMap = new Map();
  const missing = { experience: 0, supervisory: 0, costCentre: 0 };

  // A board that never publishes a field is not a board with bad hygiene.
  const published = {
    experience: postings.some((p) => p.fields?.experience),
    supervisory: postings.some((p) => p.fields?.supervisory),
    costCentre: postings.some((p) => p.fields?.costCentre),
    gba: postings.some((p) => p.fields?.gba),
  };

  let aiTitleCount = 0;
  const aiTitles = [];
  let oldest = null;

  for (const p of postings) {
    if (p.released) {
      const age = Math.max(0, ageInDays(p.released, now));
      ages.push(age);
      const idx = AGE_BUCKETS.findIndex((b) => age <= b.max);
      if (idx >= 0) ageBuckets[idx].n += 1;
      if (oldest == null || age > oldest) oldest = age;
      const key = monthKey(p.released);
      monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + 1);
    }

    if (isMissingExperience(p.experience)) missing.experience += 1;
    if (!p.org?.manager) missing.supervisory += 1;
    if (!p.costCentreCode) missing.costCentre += 1;

    if (AI_TITLE_RE.test(p.title)) {
      aiTitleCount += 1;
      aiTitles.push(p.title);
    }

    if (p.title) dupMap.set(duplicateKey(p), (dupMap.get(duplicateKey(p)) ?? 0) + 1);
  }

  const sortedAges = [...ages].sort((a, b) => a - b);
  const total = postings.length;

  // A single release day holding a large share of the board means the dates
  // were bulk-set, not that the company posted everything that day.
  const byDay = new Map();
  for (const p of postings) {
    if (!p.released) continue;
    const key = p.released.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const bulk = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const bulkDay = bulk
    ? { date: bulk[0], count: bulk[1], share: total ? bulk[1] / total : 0 }
    : null;

  const dupGroups = [...dupMap.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => {
      const [title, city, country] = key.split('|');
      return { title, city, country, n };
    })
    .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));

  const dupPostings = dupGroups.reduce((sum, g) => sum + g.n, 0);

  // Collapse clusters by title: one row per role name, with how many postings
  // and how many cities it spans. "2×" ten times in a row tells nobody anything.
  const byTitle = new Map();
  for (const g of dupGroups) {
    const cur = byTitle.get(g.title) ?? { title: g.title, postings: 0, cities: 0 };
    cur.postings += g.n;
    cur.cities += 1;
    byTitle.set(g.title, cur);
  }
  const dupTop = [...byTitle.values()]
    .sort((a, b) => b.postings - a.postings || a.title.localeCompare(b.title))
    .slice(0, 10);

  // Last 24 months, zero-filled so the line does not lie about gaps.
  const monthly = [];
  for (let i = 23; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    monthly.push({ month: key, n: monthlyMap.get(key) ?? 0 });
  }

  const countries = toSortedArray(countBy(postings, (p) => p.countryCode));
  const countryNames = new Map(
    postings.map((p) => [p.countryCode, p.country]).filter(([c]) => c)
  );

  const stale90 = ages.filter((a) => a > 90).length;
  const stale180 = ages.filter((a) => a > 180).length;

  const entryCount = postings.filter((p) =>
    ENTRY_LEVELS.has((p.experience ?? '').toLowerCase())
  ).length;

  const thinCountries = countries.filter((c) => c.n <= 2).length;

  const checks = [];
  const fieldNames = [];
  if (published.experience) {
    checks.push((p) => isMissingExperience(p.experience));
    fieldNames.push('experience level');
  }
  if (published.supervisory) {
    checks.push((p) => !p.org?.manager);
    fieldNames.push('manager');
  }
  if (published.costCentre) {
    checks.push((p) => !p.costCentreCode);
    fieldNames.push('cost centre');
  }
  const missingAny = checks.length
    ? postings.filter((p) => checks.some((fn) => fn(p))).length
    : 0;

  const gbas = toSortedArray(countBy(postings, (p) => p.gba));
  const hasFunction = postings.some((p) => p.fn);
  let grouping;
  if (published.gba) {
    grouping = { label: 'global business area', items: gbas };
  } else if (hasFunction) {
    grouping = { label: 'function', items: toSortedArray(countBy(postings, (p) => p.fn)) };
  } else {
    grouping = {
      label: 'department',
      items: toSortedArray(countBy(postings, (p) => p.department)),
    };
  }

  return {
    total,
    // Below this, every percentage is noise: 1 of 1 is always 100%.
    smallSample: total > 0 && total < 30,
    companyName: postings.find((p) => p.company)?.company ?? null,
    generatedAt: now.toISOString(),

    ages,
    ageBuckets,
    medianAge: percentile(sortedAges, 0.5),
    p75: percentile(sortedAges, 0.75),
    p90: percentile(sortedAges, 0.9),
    oldest,
    stale90,
    stale180,
    staleShare: total ? stale90 / total : 0,

    countries,
    countryNames,
    countryCount: countries.length,
    thinCountries,
    thinCodes: new Set(countries.filter((c) => c.n <= 2).map((c) => c.name)),
    topCountry: countries[0] ?? null,

    gbas,
    functions: toSortedArray(countBy(postings, (p) => p.fn)),
    grouping,
    published,
    bulkDay,
    seniority: toSortedArray(countBy(postings, (p) => p.experience)),

    managers: new Set(postings.map((p) => p.org?.manager).filter(Boolean)).size,
    orgPaths: new Set(postings.map((p) => p.org?.path).filter(Boolean)).size,
    costCentres: new Set(postings.map((p) => p.costCentreCode).filter(Boolean)).size,
    ambiguousManagers: postings.filter((p) => p.org?.flags?.includes('ambiguous')).length,

    duplicates: {
      groups: dupGroups.length,
      postings: dupPostings,
      share: total ? dupPostings / total : 0,
      top: dupTop,
      raw: dupGroups.slice(0, 10),
      keys: new Set(dupGroups.map((g) => `${g.title}|${g.city}|${g.country}`)),
    },

    monthly,
    missing: {
      ...missing,
      any: missingAny,
      share: total && checks.length ? missingAny / total : 0,
      applicable: checks.length > 0,
      fields: fieldNames,
    },

    entryCount,
    entryShare: total ? entryCount / total : 0,

    aiInTitle: {
      count: aiTitleCount,
      share: total ? aiTitleCount / total : 0,
      titles: aiTitles.slice(0, 10),
    },
  };
}

// --- diagnostics -----------------------------------------------------------

function verdictFor(value, { good, watch }, direction = 'high') {
  if (direction === 'high') {
    if (value < good) return 'good';
    if (value < watch) return 'watch';
    return 'flag';
  }
  if (value > good) return 'good';
  if (value > watch) return 'watch';
  return 'flag';
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

export function diagnostics(m) {
  const out = [];

  out.push({
    id: 'stale',
    label: 'Time on market',
    value: m.staleShare,
    display: pct(m.staleShare),
    detail: `${m.stale90} of ${m.total} roles are older than 90 days · oldest ${m.oldest ?? '—'} days`,
    verdict: verdictFor(m.staleShare, { good: 0.1, watch: 0.25 }),
    soWhat:
      'Roles older than 90 days are either hard to fill or were never taken down. Either way the board stops being a reliable picture of demand.',
    action:
      'Pull the >90-day list before the next campaign and close or refresh what is dead. It is the cheapest credibility win on this page.',
    caveat: 'A long-open role can also be a deliberate rolling hire, not a problem.',
  });

  const hygieneDetail = m.missing.applicable
    ? `${m.missing.any} postings with no ${listJoin(m.missing.fields)}`
    : 'this board does not publish an experience level, manager or cost centre';

  out.push({
    id: 'hygiene',
    label: 'ATS hygiene',
    value: m.missing.share,
    display: m.missing.applicable ? pct(m.missing.share) : 'n/a',
    detail: hygieneDetail,
    verdict: m.missing.applicable
      ? verdictFor(m.missing.share, { good: 0.02, watch: 0.1 })
      : 'na',
    soWhat: m.missing.applicable
      ? 'Empty fields break filtering, reporting, and any analytics built on top of the board — including this one.'
      : 'This board publishes a different field set, so hygiene cannot be measured here. That is a schema difference, not a fault.',
    action: m.missing.applicable
      ? 'Backfill the empty fields. It is an afternoon of data entry, not a project, and it unlocks every downstream report.'
      : 'Nothing to fix on the board. Judge it on the fields it does publish.',
    caveat: 'Some fields are optional by policy, so 0% is not the target.',
  });

  out.push({
    id: 'duplicates',
    label: 'Reposting churn',
    value: m.duplicates.share,
    display: pct(m.duplicates.share),
    detail: `${m.duplicates.postings} postings in ${m.duplicates.groups} duplicate title+location clusters`,
    verdict: verdictFor(m.duplicates.share, { good: 0.02, watch: 0.06 }),
    soWhat:
      'The same role published twice splits applications across two records and makes the pipeline look bigger than it is.',
    action: 'Deduplicate on title + city before publishing, and merge the existing pairs.',
    caveat: 'Genuine multi-headcount roles legitimately appear more than once.',
  });

  const thinShare = m.countryCount ? m.thinCountries / m.countryCount : 0;
  out.push({
    id: 'thin',
    label: 'Geographic thinness',
    value: thinShare,
    display: pct(thinShare),
    detail: `${m.thinCountries} of ${m.countryCount} countries have 2 or fewer open roles`,
    verdict: verdictFor(thinShare, { good: 0.2, watch: 0.4 }),
    soWhat:
      'A country with one or two open roles has no local hiring engine behind it — it is presence, not investment.',
    action: 'Either consolidate to real hubs or staff the thin markets deliberately.',
    caveat: 'Small offices often hire in bursts; a single snapshot understates them.',
  });

  const topShare = m.topCountry && m.total ? m.topCountry.n / m.total : 0;
  out.push({
    id: 'concentration',
    label: 'Market concentration',
    value: topShare,
    display: pct(topShare),
    detail: m.topCountry
      ? `${m.topCountry.name} alone is ${m.topCountry.n} of ${m.total} open roles`
      : 'no country data',
    verdict: verdictFor(topShare, { good: 0.35, watch: 0.5 }),
    soWhat:
      'When one market dominates the board, the hiring risk is that market\u2019s risk — one slowdown moves the whole picture.',
    action: 'Check whether the concentration matches the revenue mix, or is just where recruiting is easiest.',
    caveat: 'Concentration is not inherently bad. It may simply be the core market.',
  });

  out.push({
    id: 'entry',
    label: 'Entry pipeline',
    value: m.entryShare,
    display: pct(m.entryShare),
    detail: `${m.entryCount} entry-level or internship roles`,
    verdict: verdictFor(m.entryShare, { good: 0.15, watch: 0.08 }, 'low'),
    soWhat:
      'A board with almost no entry-level roles shows no visible route in for juniors — whatever the graduate strategy says.',
    action: 'If graduates are part of the plan, the board should show it. If not, say so and stop claiming it.',
    caveat: 'Graduate hiring is seasonal and may sit on a separate board entirely.',
  });

  return out;
}

export function aiSignal(m, deep) {
  const rows = [
    {
      id: 'ai-title',
      label: 'AI in job titles',
      value: m.aiInTitle.count,
      display: `${m.aiInTitle.count} of ${m.total}`,
      note: 'live · from the posting list',
    },
  ];
  if (deep && typeof deep.aiMentions === 'number' && typeof deep.analysed === 'number') {
    rows.push({
      id: 'ai-text',
      label: 'AI mentioned in full description',
      value: deep.aiMentions,
      display: `${deep.aiMentions} of ${deep.analysed}`,
      note: `snapshot · ${new Date(deep.generatedAt).toLocaleDateString('en-GB')}`,
    });
  }
  return rows;
}

export function headline(m, ds) {
  const flagged = ds.filter((d) => d.verdict === 'flag').sort((a, b) => b.value - a.value);
  if (flagged.length) return flagged[0];
  const watched = ds.filter((d) => d.verdict === 'watch').sort((a, b) => b.value - a.value);
  return watched[0] ?? null;
}

/**
 * The actual postings behind a diagnostic. A number without the list behind it
 * is an opinion; the list is what someone can act on.
 */
export function offenders(id, postings, m) {
  const now = new Date(m.generatedAt);
  switch (id) {
    case 'stale':
      return postings.filter((p) => (ageDays(p, now) ?? -1) > 90);
    case 'hygiene':
      return postings.filter((p) => hygieneReasons(p, m.published).length > 0);
    case 'duplicates':
      return postings.filter((p) => m.duplicates.keys.has(duplicateKey(p)));
    case 'thin':
      return postings.filter((p) => m.thinCodes.has(p.countryCode));
    case 'concentration':
      return postings.filter((p) => p.countryCode === m.topCountry?.name);
    case 'entry':
      return postings.filter((p) => ENTRY_LEVELS.has((p.experience ?? '').toLowerCase()));
    default:
      return [];
  }
}
