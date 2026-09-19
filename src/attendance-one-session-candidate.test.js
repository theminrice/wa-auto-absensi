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

  const proofSenders = [
    'wa-send-checkin-v3-proof-testing.js',
    'wa-send-checkout-v3-proof-testing.js'
  ];

  for (const senderPath of proofSenders) {
    const source = fs.readFileSync(
      path.join(__dirname, senderPath),
      'utf8'
    );

    assert.equal(
      source.includes("EXPECTED_GROUP_NAME = 'Testing'"),
      true,
      senderPath + ': testing target required'
    );

    assert.equal(
      source.includes('Aktif Tim Magang OCN'),
      false,
      senderPath + ': main group forbidden'
    );

    assert.equal(
      (source.match(
        /await syncPaleluWithClient\(client\);/g
      ) || []).length,
      1,
      senderPath + ': exactly one Palelu sync'
    );

    assert.ok(
      source.indexOf('await syncPaleluWithClient(client);') <
      source.indexOf("console.log('SEND_START=YES');"),
      senderPath + ': Palelu before SEND'
    );
  }

  const candidateWorkflow = fs.readFileSync(
    path.join(
      __dirname,
      '../.github/workflows/wa-production-v3-all-proof-testing.yml'
    ),
    'utf8'
  );

  for (const marker of [
    "refs/heads/feat/palelu-one-session-candidate-v1",
    'Testing-One-Session-V1',
    'ONE_SESSION_STANDALONE_SYNC=NO',
    'ONE_SESSION_TESTING_FINAL=PASS',
    'FULL_PROOF_MAIN_GROUP_TOUCHED=NO',
    'ATLAS_IP_CLEANUP=PASS'
  ]) {
    assert.equal(
      candidateWorkflow.includes(marker),
      true,
      'Candidate proof marker missing: ' + marker
    );
  }

  assert.equal(
    (candidateWorkflow.match(
      /ATTENDANCE_ONE_SESSION_CANDIDATE: 'YES'/g
    ) || []).length,
    2,
    'Only Testing senders opt into one-session mode'
  );

  assert.equal(
    candidateWorkflow.includes(
      'npm run attendance:sync-once-production-v3'
    ),
    false,
    'No extra standalone Palelu sync in candidate'
  );

  assert.equal(
    (candidateWorkflow.match(
      /mkdir -p "\\$WWEBJS_REMOTE_DATA_PATH"/g
    ) || []).length,
    2,
    'Each Testing sender must create local RemoteAuth data dir'
  );

  assert.equal(
    (candidateWorkflow.match(
      /ONE_SESSION_REMOTE_DATA_DIR_READY=YES/g
    ) || []).length,
    2,
    'Each Testing sender must confirm local RemoteAuth data dir'
  );

  assert.equal(
    candidateWorkflow.includes(
      'group: wa-attendance-production-cloud'
    ),
    true,
    'Share production concurrency lock to avoid session conflicts'
  );

  assert.equal(
    candidateWorkflow.includes(
      "if: github.ref == 'refs/heads/feat/palelu-one-session-candidate-v1'"
    ),
    true,
    'Fail closed when dispatched on main or another branch'
  );

  assert.equal(
    candidateWorkflow.includes(
      'FULL_PROOF_TOTAL_REAL_SENDS=2'
    ),
    true,
    'At most exactly two proof sends verified'
  );

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
  console.log('ONE_SESSION_TESTING_PROOFS_LOCKED=PASS');
  console.log('ONE_SESSION_TESTING_WORKFLOW_STATIC_GUARD=PASS');
  console.log('ONE_SESSION_BASELINE_WORKFLOW_PRESERVED=YES');
  console.log('ONE_SESSION_WHATSAPP_SEND=NO');
  console.log('ONE_SESSION_RUNTIME_E2E=NOT_TESTED');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
