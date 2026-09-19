'use strict';

const assert = require('assert');

const {
  saveLeave,
  getLatestLeave,
  getLatestProject
} = require('./attendance-input-store');

async function main() {
  let nextId = 1;
  const rows = [
    {
      _id: 'project-1',
      kind: 'project',
      project: 'Melanjutkan audit',
      createdAt: new Date(
        '2026-09-18T01:00:00Z'
      )
    },
    {
      _id: 'documentation-1',
      kind: 'documentation',
      filename: 'dokumentasi.jpg',
      createdAt: new Date(
        '2026-09-18T02:00:00Z'
      )
    }
  ];

  const preserved = JSON.stringify(rows);

  const collection = {
    find(query) {
      return {
        sort() {
          return {
            async toArray() {
              return rows
                .filter(row =>
                  row.kind === query.kind
                )
                .sort((a, b) =>
                  b.createdAt - a.createdAt
                )
                .map(row => ({ ...row }));
            }
          };
        }
      };
    },

    async findOne(query) {
      return rows
        .filter(row =>
          row.kind === query.kind
        )
        .sort((a, b) =>
          b.createdAt - a.createdAt
        )[0] || null;
    },

    async insertOne(document) {
      const id =
        'insert-' + nextId++;

      rows.push({
        ...document,
        _id: id
      });

      return {
        insertedId: id
      };
    },

    async updateOne(query, patch, options) {
      let row = rows.find(item => {
        if (query._id) {
          return item._id === query._id;
        }

        return item.kind === query.kind;
      });

      if (!row && options && options.upsert) {
        row = {
          _id: 'upsert-' + nextId++,
          kind: query.kind
        };

        rows.push(row);
      }

      if (!row) {
        return { matchedCount: 0 };
      }

      if (patch.$setOnInsert) {
        Object.assign(
          row,
          patch.$setOnInsert
        );
      }

      if (patch.$set) {
        Object.assign(
          row,
          patch.$set
        );
      }

      if (patch.$unset) {
        for (const key of Object.keys(patch.$unset)) {
          delete row[key];
        }
      }

      if (patch.$addToSet) {
        const add =
          patch.$addToSet.sourceMessageId;

        const ids =
          add && Array.isArray(add.$each)
            ? add.$each
            : [add];

        row.sourceMessageId =
          Array.from(new Set([
            ...(
              Array.isArray(row.sourceMessageId)
                ? row.sourceMessageId
                : row.sourceMessageId
                  ? [row.sourceMessageId]
                  : []
            ),
            ...ids
          ]));
      }

      return {
        matchedCount: 1
      };
    },

    async deleteMany(query) {
      const doomed = [];

      for (const row of rows) {
        if (
          row.kind === query.kind &&
          row._id !== query._id.$ne
        ) {
          doomed.push(row);
        }
      }

      for (const row of doomed) {
        rows.splice(
          rows.indexOf(row),
          1
        );
      }
    }
  };

  const connection = {
    db: {
      collection(name) {
        assert.strictEqual(
          name,
          'attendance_inputs'
        );

        return collection;
      }
    }
  };

  const first = await saveLeave(
    connection,
    {
      startDate: '2026-09-19',
      endDate: '2026-09-21'
    },
    new Date('2026-09-19T01:00:00Z')
  );

  assert.strictEqual(
    rows.filter(row =>
      row.kind === 'leave'
    ).length,
    1
  );

  assert.deepStrictEqual(
    {
      startDate: first.startDate,
      endDate: first.endDate
    },
    {
      startDate: '2026-09-19',
      endDate: '2026-09-21'
    }
  );

  const leaveRow =
    rows.find(row =>
      row.kind === 'leave'
    );

  leaveRow.sourceMessageId =
    'first-leave-message';

  const second = await saveLeave(
    connection,
    {
      startDate: '2026-10-01',
      endDate: '2026-10-02'
    },
    new Date('2026-09-30T01:00:00Z')
  );

  assert.strictEqual(
    second._id,
    first._id
  );

  assert.strictEqual(
    rows.filter(row =>
      row.kind === 'leave'
    ).length,
    1
  );

  const latest =
    await getLatestLeave(connection);

  assert.strictEqual(
    latest.startDate,
    '2026-10-01'
  );

  assert.strictEqual(
    latest.endDate,
    '2026-10-02'
  );

  const dedup =
    rows.find(row =>
      row.kind === 'ingest-dedup'
    );

  assert(
    dedup.sourceMessageId.includes(
      'first-leave-message'
    )
  );

  assert.deepStrictEqual(
    await getLatestProject(connection)
      .then(row => row.project),
    'Melanjutkan audit'
  );

  const originalRows =
    rows
      .filter(row =>
        row.kind === 'project' ||
        row.kind === 'documentation'
      );

  assert.strictEqual(
    JSON.stringify(originalRows),
    preserved
  );

  await assert.rejects(
    saveLeave(
      connection,
      {
        startDate: '2026-02-31',
        endDate: '2026-03-02'
      }
    ),
    /LEAVE_DATE_INVALID/
  );

  console.log(
    'ATTENDANCE_LEAVE_STORE_TEST=PASS'
  );

  console.log(
    'ATTENDANCE_PROJECT_PRESERVED=YES'
  );

  console.log(
    'ATTENDANCE_DOCUMENTATION_PRESERVED=YES'
  );

  console.log(
    'ATTENDANCE_LEAVE_CURRENT_ROW_COUNT=1'
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
