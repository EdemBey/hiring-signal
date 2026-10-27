// Pure parsers for SmartRecruiters public posting payloads.
// No DOM, no network. Imported by app.js and by tests/parse.test.js.

/** Read a custom field value from a posting. */
export function customField(posting, label) {
  const fields = posting && posting.customField;
  if (!Array.isArray(fields)) return null;
  const hit = fields.find((f) => f && f.fieldLabel === label);
  if (!hit) return null;
  return hit.valueLabel ?? null;
}

// "{org path} ({name}- {name}) - {SO code}"
// SO codes in the wild: SO9063, SOIN9245, SOB1310, SOVP185, SOEn5031, SO0949.
const SUPERVISORY_RE =
  /^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*-\s*(SO[A-Za-z]*\d+)\s*$/;

const INHERITED_RE = /\(\s*inherited\s*\)/i;
const ON_LEAVE_RE = /\(\s*on\s+leave\s*\)/i;
const MARKER_RE = /\s*\(\s*(?:inherited|on\s+leave)\s*\)\s*/gi;

/**
 * The name block is "{Name}- {Name}" (duplicated), but:
 *   - the name itself may contain hyphens  (Miguel Granado-Ibáñez)
 *   - markers may be appended             (Ian Lanchbury (Inherited))
 *   - the two halves may be different people (Doug Feeney- David A Smith)
 */
export function splitName(raw) {
  const flags = [];
  if (raw == null) return { manager: null, alt: null, flags };

  let s = String(raw);
  if (INHERITED_RE.test(s)) flags.push('inherited');
  if (ON_LEAVE_RE.test(s)) flags.push('on leave');

  s = s.replace(MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { manager: null, alt: null, flags };

  const parts = s
    .split(/\s*-\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return { manager: null, alt: null, flags };
  if (parts.length === 1) return { manager: parts[0], alt: null, flags };

  // Duplicated halves: "A B- A B" or "A-B- A-B".
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    const left = parts.slice(0, half).join('-');
    const right = parts.slice(half).join('-');
    if (left === right) return { manager: left, alt: null, flags };
  }

  // Not a duplicate. Either two different people, or one hyphenated surname.
  // A full name has a space in its first token; "Jean-Pierre" does not.
  if (/\s/.test(parts[0])) {
    flags.push('ambiguous');
    return { manager: parts[0], alt: parts.slice(1).join('-'), flags };
  }

  return { manager: parts.join('-'), alt: null, flags };
}

/** @returns {{path: string|null, code: string|null, manager: string|null, alt: string|null, flags: string[], raw: string|null}} */
export function parseSupervisory(raw) {
  const empty = {
    path: null,
    code: null,
    manager: null,
    alt: null,
    flags: [],
    raw: typeof raw === 'string' ? raw : null,
  };
  if (typeof raw !== 'string' || !raw.trim()) return empty;

  const m = raw.match(SUPERVISORY_RE);
  if (!m) return empty;

  const name = splitName(m[2]);
  return {
    path: m[1].trim() || null,
    code: m[3],
    manager: name.manager,
    alt: name.alt,
    flags: name.flags,
    raw,
  };
}

/** "1107145 Digital Operations" -> {code: "1107145", name: "Digital Operations"} */
export function parseCostCentre(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { code: null, name: null, raw: null };
  }
  const m = raw.match(/^(\d+)\s+(.+)$/);
  if (!m) return { code: null, name: raw.trim(), raw };
  return { code: m[1], name: m[2].trim(), raw };
}

/** "Energy- Global Engineering Centre- Power Systems - Electrical" -> 4 levels. */
export function splitOrgPath(path) {
  if (!path) return [];
  return path
    .split(/\s+-\s+|-(?=\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Full normalisation of one raw posting. */
export function parsePosting(posting, company) {
  const loc = posting.location || {};
  const rawSupervisory = customField(posting, 'Supervisory organisation');
  const rawCostCentre = customField(posting, 'Cost Centers');
  const rawGba = customField(posting, 'Global Business Area');
  const org = parseSupervisory(rawSupervisory);
  const cost = parseCostCentre(rawCostCentre);
  const released = posting.releasedDate ? new Date(posting.releasedDate) : null;

  return {
    id: String(posting.id ?? ''),
    ref: posting.refNumber || null,
    title: (posting.name || '').trim(),
    company: posting.company?.name || company || null,
    url:
      posting.id != null && company
        ? `https://jobs.smartrecruiters.com/${company}/${posting.id}`
        : null,
    released: released && !Number.isNaN(released.getTime()) ? released : null,
    city: loc.city || null,
    countryCode: loc.country ? String(loc.country).toUpperCase() : null,
    country: customField(posting, 'Country/Region'),
    remote: !!loc.remote,
    gba: rawGba,
    fn: posting.function?.label || null,
    department: posting.department?.label || null,
    experience: posting.experienceLevel?.label || null,
    org,
    costCentreCode: cost.code,
    // Which fields this board actually publishes. Companies do not share a
    // schema: one board may have no supervisory organisation at all, and
    // "missing" must not be confused with "not collected".
    fields: {
      supervisory: rawSupervisory != null,
      costCentre: rawCostCentre != null,
      gba: rawGba != null,
      experience: !!posting.experienceLevel?.label,
    },
  };
}
