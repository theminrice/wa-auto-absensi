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

// WA_AUTO_ABSENSI_CHECKOUT_LATEST_AVAILABLE_DOCUMENTATION_V2
// A photo from yesterday is still eligible if it is the newest
// documentation known to the canonical MongoDB store.
const { getLatestDocumentation } =
  require('./attendance-input-store');

const docOlder = {
  kind: 'documentation',
  _id: 1,
  createdAt: new Date('2026-09-20T09:00:00Z')
};
const docNewestAvailable = {
  kind: 'documentation',
  _id: 2,
  createdAt: new Date('2026-09-21T09:00:00Z')
};
const newerProject = {
  kind: 'project',
  _id: 3,
  createdAt: new Date('2026-09-23T02:00:00Z')
};

function mockDocumentationConnection(rows) {
  return {
    db: {
      collection() {
        return {
          findOne(filter, options) {
            assert.deepStrictEqual(
              filter, { kind: 'documentation' }
            );
            assert.deepStrictEqual(
              options.sort, { createdAt: -1, _id: -1 }
            );
            const matching = rows
              .filter(row => row.kind === filter.kind)
              .sort((a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                b._id - a._id
              );
            return Promise.resolve(matching[0] || null);
          }
        };
      }
    }
  };
}

Promise.resolve()
  .then(async () => {
    const latest = await getLatestDocumentation(
      mockDocumentationConnection([
        docOlder, newerProject, docNewestAvailable
      ])
    );
    assert.strictEqual(latest, docNewestAvailable);
    const none = await getLatestDocumentation(
      mockDocumentationConnection([newerProject])
    );
    assert.strictEqual(none, null);
    console.log('CHECKOUT_LATEST_AVAILABLE_DOC_TEST=PASS');
    require('./attendance-leave.test');
    console.log('TESTS=PASS');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
