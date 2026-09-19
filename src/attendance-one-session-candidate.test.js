'use strict';

// No network, MongoDB connection, browser startup, or WhatsApp sending.
// The candidate path remains opt-in and isolated from the deployed workflow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const ingestPath = path.join(
  __dirname,
  'wa-self-chat-ingest-production-v3.js'
);

const ingest = fs.readFileSync(
  ingestPath,
  'utf8'
);

const senderPaths = [
  'wa-send-checkin-production.js',
  'wa-send-checkout-production.js'
];

assert.equal(
  ingest.includes('if (require.main === module) {'),
  true,
  'Production sync must still run as CLI only'
);

const {
  syncPaleluWithClient
} = require('./wa-self-chat-ingest-production-v3');

assert.equal(
  typeof syncPaleluWithClient,
  'function'
);

// Importing ingestion must not launch a second WhatsApp client or
// attempt to connect to MongoDB.
assert.notEqual(mongoose.connection.readyState, 1);

async function main() {
  await assert.rejects(
    syncPaleluWithClient(null),
    /ONE_SESSION_CLIENT_INVALID/
  );

  await assert.rejects(
    syncPaleluWithClient({
      getChats() {}
    }),
    /ONE_SESSION_CLIENT_INVALID/
  );

  await assert.rejects(
    syncPaleluWithClient({
      getChats() {},
      getChatById() {}
    }),
    /ONE_SESSION_MONGODB_NOT_READY/
  );

  assert.equal(
    ingest.includes(
      'await startupCatchupPaleluStable();'
    ),
    true
  );

  assert.equal(
    ingest.includes(
      'await ensureAttendanceIndexes('
    ),
    true
  );

  assert.equal(
    ingest.includes(
      'await client.destroy();'
    ),
    true,
    'Legacy CLI shutdown is preserved'
  );

  assert.equal(
    ingest.includes(
      '// Never destroy the sender\'s WhatsApp client'
    ),
    true
  );

  for (const senderPath of senderPaths) {
    const source = fs.readFileSync(
      path.join(__dirname, senderPath),
      'utf8'
    );

    assert.equal(
      (source.match(
        /ATTENDANCE_ONE_SESSION_CANDIDATE === 'YES'/g
      ) || []).length,
      1,
      senderPath
    );

    assert.equal(
      (source.match(
        /await syncPaleluWithClient\(client\);/g
      ) || []).length,
      1,
      senderPath
    );

    const sync = source.indexOf(
      'await syncPaleluWithClient(client);'
    );

    const verify = source.indexOf(
      "console.log('TARGET_GROUP_VERIFY_START=YES');"
    );

    const send = source.indexOf(
      "console.log('SEND_START=YES');"
    );

    assert.ok(
      sync >= 0 && sync < verify && verify < send,
      'Palelu must synchronize before any send: ' +
        senderPath
    );

    assert.equal(
      source.includes(
        'ONE_SESSION_REUSED_WHATSAPP_CLIENT=YES'
      ),
      true
    );
  }

  const productionWorkflow = fs.readFileSync(
    path.join(
      __dirname,
      '../.github/workflows/wa-attendance-production-v1.yml'
    ),
    'utf8'
  );

  assert.equal(
    productionWorkflow.includes(
      'npm run attendance:sync-once-production-v3'
    ),
    true,
    'Deployed baseline workflow must remain intact'
  );

  assert.equal(
    productionWorkflow.includes(
      'ATTENDANCE_ONE_SESSION_CANDIDATE'
    ),
    false,
    'Candidate must not be enabled in production workflow'
  );

  console.log('ONE_SESSION_MODULE_IMPORT_SAFE=PASS');
  console.log('ONE_SESSION_CLIENT_GUARD=PASS');
  console.log('ONE_SESSION_MONGODB_GUARD=PASS');
  console.log('ONE_SESSION_BEFORE_SEND=PASS');
  console.log('ONE_SESSION_BOTH_SENDERS=PASS');
  console.log('ONE_SESSION_BASELINE_WORKFLOW_PRESERVED=YES');
  console.log('ONE_SESSION_WHATSAPP_SEND=NO');
  console.log('ONE_SESSION_RUNTIME_E2E=NOT_TESTED');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
