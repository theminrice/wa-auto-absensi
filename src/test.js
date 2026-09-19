const assert = require('assert');
const {
  normalizeProjectText,
  isCleaningDay,
  buildCheckIn,
  buildCheckOut
} = require('./attendance');

assert.strictEqual(normalizeProjectText('p:Melanjutkan audit sekuritas backend'), 'Melanjutkan audit sekuritas backend');
assert.strictEqual(normalizeProjectText('P: Test Project'), 'Test Project');
assert.strictEqual(normalizeProjectText('hello'), null);

assert.strictEqual(isCleaningDay(1), true);  // Senin
assert.strictEqual(isCleaningDay(4), true);  // Kamis
assert.strictEqual(isCleaningDay(2), false); // Selasa
assert.strictEqual(isCleaningDay(3), false); // Rabu
assert.strictEqual(isCleaningDay(5), false); // Jumat

// 17 Sep 2026 = Kamis
const thursday = new Date('2026-09-17T01:35:00.000Z'); // 08:35 WIB
const checkIn = buildCheckIn({
  project: 'Melanjutkan audit sekuritas backend',
  date: thursday
});
assert(checkIn.includes('Check In, Kamis 17 September 2026'));
assert.strictEqual(
  checkIn,
  [
    'Check In, Kamis 17 September 2026',
    '',
    '- 08.00 : Sampai Kantor',
    '- 08.10 : Membersihkan Ruangan',
    '- 08.30 : Melanjutkan audit sekuritas backend',
    '- 15.55 : Merapikan Dan Membersihkan Ruangan',
    '- 16.00 : Pulang'
  ].join('\n')
);
assert(!/[✅❌]/u.test(checkIn));

const checkOut = buildCheckOut({
  project: 'Melanjutkan audit sekuritas backend',
  date: thursday
});
assert(checkOut.includes('Melanjutkan audit sekuritas backend✅'));
assert(checkOut.includes('Pulang✅'));

require('./attendance-leave.test');

console.log('TESTS=PASS');
