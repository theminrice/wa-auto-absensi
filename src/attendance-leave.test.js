'use strict';

const assert = require('assert');

const {
  parseLeaveCommand,
  jakartaDateKey,
  evaluateLeaveForDate
} = require('./attendance-leave');

const sent =
  new Date('2026-09-19T01:00:00.000Z');

const jakarta =
  iso => new Date(iso);

assert.deepStrictEqual(
  parseLeaveCommand('l:19/9', sent),
  {
    startDate: '2026-09-19',
    endDate: '2026-09-19'
  }
);

assert.deepStrictEqual(
  parseLeaveCommand(' L: 19/9 - 21/9 ', sent),
  {
    startDate: '2026-09-19',
    endDate: '2026-09-21'
  }
);

assert.deepStrictEqual(
  parseLeaveCommand('l:30/9-2/10', sent),
  {
    startDate: '2026-09-30',
    endDate: '2026-10-02'
  }
);

assert.deepStrictEqual(
  parseLeaveCommand('l:30/12-2/1', sent),
  {
    startDate: '2026-12-30',
    endDate: '2027-01-02'
  }
);

assert.deepStrictEqual(
  parseLeaveCommand(
    'l:19/9/2027-21/9/2027',
    sent
  ),
  {
    startDate: '2027-09-19',
    endDate: '2027-09-21'
  }
);

// WIB year derives from the original message timestamp.
assert.deepStrictEqual(
  parseLeaveCommand(
    'l:1/1',
    jakarta('2026-12-31T18:00:00.000Z')
  ),
  {
    startDate: '2027-01-01',
    endDate: '2027-01-01'
  }
);

assert.deepStrictEqual(
  parseLeaveCommand('l:29/2/2028', sent),
  {
    startDate: '2028-02-29',
    endDate: '2028-02-29'
  }
);

for (const invalid of [
  'l:',
  'l:abc',
  'l:31/2',
  'l:29/2/2026',
  'l:0/9',
  'l:19/13',
  'l:21/9-19/9',
  'l:1/1/2027-31/12/2026',
  'l:19/9-',
  'l:19/9-21/9-23/9',
  'l:19/9/26'
]) {
  assert.throws(
    () => parseLeaveCommand(invalid, sent),
    /LEAVE_(COMMAND_INVALID_FORMAT|DATE_INVALID|DATE_RANGE_REVERSED)/
  );
}

assert.strictEqual(
  parseLeaveCommand('p: audit', sent),
  null
);

assert.strictEqual(
  parseLeaveCommand('p:x', sent),
  null
);

assert.strictEqual(
  parseLeaveCommand('hello', sent),
  null
);

assert.strictEqual(
  jakartaDateKey(
    jakarta('2026-09-18T17:01:00.000Z')
  ),
  '2026-09-19'
);

const leave = {
  startDate: '2026-09-19',
  endDate: '2026-09-21'
};

assert.strictEqual(
  evaluateLeaveForDate(
    leave,
    jakarta('2026-09-18T16:59:00.000Z')
  ).onLeave,
  false
);

assert.strictEqual(
  evaluateLeaveForDate(
    leave,
    jakarta('2026-09-18T17:01:00.000Z')
  ).onLeave,
  true
);

assert.strictEqual(
  evaluateLeaveForDate(
    leave,
    jakarta('2026-09-21T16:59:00.000Z')
  ).onLeave,
  true
);

assert.strictEqual(
  evaluateLeaveForDate(
    leave,
    jakarta('2026-09-21T17:01:00.000Z')
  ).onLeave,
  false
);

assert.strictEqual(
  evaluateLeaveForDate(null, sent).onLeave,
  false
);

for (const corrupt of [
  { startDate: '2026-02-31', endDate: '2026-03-02' },
  { startDate: '2026-09-22', endDate: '2026-09-19' },
  { startDate: '2026-09-19', endDate: null }
]) {
  assert.throws(
    () => evaluateLeaveForDate(corrupt, sent),
    /LEAVE_(STORED_RANGE_INVALID|DATE_INVALID)/
  );
}

console.log('ATTENDANCE_LEAVE_PARSER_TEST=PASS');
console.log('ATTENDANCE_LEAVE_WIB_TEST=PASS');
console.log('ATTENDANCE_LEAVE_RANGE_TEST=PASS');
console.log('ATTENDANCE_LEAVE_INVALID_GUARD=PASS');
