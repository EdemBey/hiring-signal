import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  customField,
  splitName,
  parseSupervisory,
  parseCostCentre,
  splitOrgPath,
} from '../docs/parse.js';

// Every string below is copied from the live Ramboll board (27 Oct 2026),
// except where marked as synthetic.

test('1. duplicated name collapses to one', () => {
  const r = parseSupervisory(
    'Energy- Global Engineering Centre- Power Systems - Electrical (Rajesh Kannan Nagendiren- Rajesh Kannan Nagendiren) - SO2777'
  );
  assert.equal(r.manager, 'Rajesh Kannan Nagendiren');
  assert.equal(r.alt, null);
  assert.equal(r.code, 'SO2777');
  assert.equal(r.path, 'Energy- Global Engineering Centre- Power Systems - Electrical');
  assert.deepEqual(r.flags, []);
});

test('2. SO code variants all parse', () => {
  const codes = ['SO9063', 'SOIN9245', 'SOB1310', 'SOVP185', 'SOEn5031', 'SO0949'];
  for (const code of codes) {
    const r = parseSupervisory(`Some Unit (John Doe- John Doe) - ${code}`);
    assert.equal(r.code, code, `failed for ${code}`);
    assert.equal(r.manager, 'John Doe');
  }
});

test('3. (Inherited) becomes a flag, not part of the name', () => {
  const r = parseSupervisory(
    'UK Landscape - RB (Ian Lanchbury- Ian Lanchbury (Inherited)) - SO9063'
  );
  assert.equal(r.manager, 'Ian Lanchbury');
  assert.ok(r.flags.includes('inherited'));
  assert.equal(r.path, 'UK Landscape - RB');
});

test('4. (On Leave) becomes a flag, and nested parens survive', () => {
  const r = parseSupervisory(
    'Energy Implementation (Dr. Jörg Fengler (On Leave)- Dr. Jörg Fengler (On Leave)) - SO1505'
  );
  assert.equal(r.manager, 'Dr. Jörg Fengler');
  assert.ok(r.flags.includes('on leave'));
  assert.equal(r.path, 'Energy Implementation');
});

test('5. hyphenated surname, duplicated, stays hyphenated', () => {
  const r = parseSupervisory(
    'Some Unit (Miguel Granado-Ibáñez- Miguel Granado-Ibáñez) - SO1234'
  );
  assert.equal(r.manager, 'Miguel Granado-Ibáñez');
  assert.equal(r.alt, null);
});

test('6. hyphen + duplication: Anne- Catrin Norkauer', () => {
  const r = parseSupervisory('Some Unit (Anne- Catrin Norkauer- Anne- Catrin Norkauer) - SO1234');
  assert.equal(r.manager, 'Anne-Catrin Norkauer');
});

test('7. two different people: first wins, second is alt, flagged ambiguous', () => {
  const r = parseSupervisory('Some Unit (Doug Feeney- David A Smith) - SO1234');
  assert.equal(r.manager, 'Doug Feeney');
  assert.equal(r.alt, 'David A Smith');
  assert.ok(r.flags.includes('ambiguous'));
});

test('8. non-ASCII names survive untouched', () => {
  assert.equal(splitName('Paweł Wojtarkowski- Paweł Wojtarkowski').manager, 'Paweł Wojtarkowski');
  assert.equal(splitName('Anna Sipilä- Anna Sipilä').manager, 'Anna Sipilä');
  assert.equal(splitName('Jörg Fengler- Jörg Fengler').manager, 'Jörg Fengler');
});

test('9. trailing space in org path is trimmed', () => {
  const r = parseSupervisory('Noise & Vibration  (John Doe- John Doe) - SO1234');
  assert.equal(r.path, 'Noise & Vibration');
});

test('10. missing Supervisory organisation yields nulls, no throw', () => {
  for (const raw of [null, undefined, '', '   ', 42]) {
    const r = parseSupervisory(raw);
    assert.equal(r.manager, null);
    assert.equal(r.code, null);
    assert.equal(r.path, null);
    assert.deepEqual(r.flags, []);
  }
});

test('11. malformed string keeps raw, returns nulls', () => {
  const raw = 'this is not the expected shape at all';
  const r = parseSupervisory(raw);
  assert.equal(r.manager, null);
  assert.equal(r.code, null);
  assert.equal(r.raw, raw);
});

test('12. cost centre splits code and name', () => {
  assert.deepEqual(parseCostCentre('1107145 Digital Operations'), {
    code: '1107145',
    name: 'Digital Operations',
    raw: '1107145 Digital Operations',
  });
});

test('13. cost centre without a code keeps the name', () => {
  const r = parseCostCentre('Digital Operations');
  assert.equal(r.code, null);
  assert.equal(r.name, 'Digital Operations');
});

test('14. org path splits on both delimiter styles', () => {
  assert.deepEqual(
    splitOrgPath('Energy- Global Engineering Centre- Power Systems - Electrical'),
    ['Energy', 'Global Engineering Centre', 'Power Systems', 'Electrical']
  );
  assert.deepEqual(splitOrgPath('Noise & Vibration'), ['Noise & Vibration']);
  assert.deepEqual(splitOrgPath('REC HRCB- MEP'), ['REC HRCB', 'MEP']);
});

test('15. customField is null-safe', () => {
  assert.equal(customField(null, 'X'), null);
  assert.equal(customField({}, 'X'), null);
  assert.equal(customField({ customField: [] }, 'X'), null);
  assert.equal(
    customField({ customField: [{ fieldLabel: 'X', valueLabel: 'y' }] }, 'X'),
    'y'
  );
});

test('16. path containing its own parentheses is preserved', () => {
  const r = parseSupervisory(
    'Wind- Transaction Advisory (APAC) (Jane Roe- Jane Roe) - SO1234'
  );
  assert.equal(r.path, 'Wind- Transaction Advisory (APAC)');
  assert.equal(r.manager, 'Jane Roe');
});
