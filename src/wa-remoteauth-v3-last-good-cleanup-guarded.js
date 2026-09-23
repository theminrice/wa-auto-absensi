'use strict';

// REMOTEAUTH_V3_LAST_GOOD_GUARDED_CLEANUP_V1
// Preflight is read only. Cleanup requires explicit approval and exact
// preflight fingerprint; it backs up ONLY the 52 orphan chunks durably,
// verifies the backup, and deletes ONLY their original _ids.
// The 1 valid LAST_GOOD zip / 92 linked chunks are content-verified
// before and after; ACTIVE is never read or written.
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  REMOTE_AUTH_V3_CANDIDATE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION
} = require('./remote-auth-v3');

const MODE = process.env.LAST_GOOD_CLEANUP_MODE || 'preflight';
const BUCKET = 'whatsapp-' + REMOTE_AUTH_V3_LAST_GOOD_SESSION;
const CANDIDATE_BUCKET = 'whatsapp-' + REMOTE_AUTH_V3_CANDIDATE_SESSION;
const CANDIDATE_BACKUP =
  'wa_remoteauth_v3_candidate_orphans_backup_20260923';
const BACKUP =
  'wa_remoteauth_v3_last_good_orphans_backup_20260923';
const EXPECTED_LAST_GOOD_FILE_BYTES = 23987708;
const EXPECTED_VALID_CHUNKS = 92;
const EXPECTED_ORPHANS = 52;
const EXPECTED_ORPHAN_GROUPS = 1;

function fail(code) {
  throw new Error(code);
}

function idKey(value) {
  if (!value || typeof value.toHexString !== 'function') {
    fail('LAST_GOOD_CHUNK_OBJECT_ID_INVALID');
  }
  return value.toHexString();
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && Buffer.isBuffer(value.buffer)) return value.buffer;
  fail('LAST_GOOD_CHUNK_BINARY_DATA_INVALID');
}

function snapshot(chunks) {
  const chunkIds = new Set();
  const groups = new Set();
  const positions = new Set();
  const fingerprints = [];
  let length = 0;
  for (const chunk of chunks) {
    const chunkId = idKey(chunk._id);
    const filesId = idKey(chunk.files_id);
    if (!Number.isSafeInteger(chunk.n) || chunk.n < 0) {
      fail('LAST_GOOD_CHUNK_NUMBER_INVALID');
    }
    if (chunkIds.has(chunkId)) fail('LAST_GOOD_CHUNK_ID_DUPLICATE');
    chunkIds.add(chunkId);
    const position = filesId + ':' + chunk.n;
    if (positions.has(position)) {
      fail('LAST_GOOD_CHUNK_POSITION_DUPLICATE');
    }
    positions.add(position);
    const data = bytes(chunk.data);
    if (data.length < 1 || data.length > 262144) {
      fail('LAST_GOOD_CHUNK_SIZE_INVALID');
    }
    length += data.length;
    groups.add(filesId);
    fingerprints.push(
      chunkId + ':' + filesId + ':' + chunk.n + ':' +
      data.length + ':' +
      crypto.createHash('sha256').update(data).digest('hex')
    );
  }
  fingerprints.sort();
  return {
    count: chunks.length,
    groups: groups.size,
    totalBytes: length,
    fingerprint: crypto.createHash('sha256')
      .update(fingerprints.join('\n')).digest('hex')
  };
}

async function collectionExists(db, name) {
  const found = await db.listCollections(
    { name }, { nameOnly: true }
  ).toArray();
  return found.some(x => x.name === name);
}

async function checkCandidatePreserved(db) {
  console.log('LAST_GOOD_CLEANUP_STAGE=CHECK_CANDIDATE_PRESERVED');
  const files = CANDIDATE_BUCKET + '.files';
  const chunks = CANDIDATE_BUCKET + '.chunks';
  if (!(await collectionExists(db, files)) ||
      !(await collectionExists(db, chunks)) ||
      !(await collectionExists(db, CANDIDATE_BACKUP))) {
    fail('CANDIDATE_BASELINE_COLLECTION_MISSING');
  }
  const fileCount = await db.collection(files).countDocuments({});
  const chunkCount = await db.collection(chunks).countDocuments({});
  const backupCount = await db.collection(CANDIDATE_BACKUP)
    .countDocuments({});
  console.log('CANDIDATE_FILE_ROWS=' + fileCount);
  console.log('CANDIDATE_CHUNKS=' + chunkCount);
  console.log('CANDIDATE_BACKUP_CHUNKS=' + backupCount);
  if (fileCount !== 0 || chunkCount !== 0 ||
      backupCount !== 261) {
    fail('CANDIDATE_BASELINE_CHANGED');
  }
  console.log('CANDIDATE_PRESERVED_GUARD=PASS');
}

async function readLastGood(db, expectedValidFingerprint = '') {
  console.log('LAST_GOOD_CLEANUP_STAGE=READ_FILE_METADATA');
  const filesName = BUCKET + '.files';
  const chunksName = BUCKET + '.chunks';
  if (!(await collectionExists(db, filesName)) ||
      !(await collectionExists(db, chunksName))) {
    fail('LAST_GOOD_COLLECTIONS_MISSING');
  }

  const fileRows = await db.collection(filesName).find({})
    .toArray();
  const valid = fileRows[0];
  if (fileRows.length !== 1 || !valid ||
      valid.filename !== REMOTE_AUTH_V3_LAST_GOOD_SESSION + '.zip' ||
      valid.length !== EXPECTED_LAST_GOOD_FILE_BYTES ||
      !Number.isSafeInteger(valid.chunkSize) ||
      valid.chunkSize < 1 || valid.chunkSize > 262144) {
    fail('LAST_GOOD_FILE_BASELINE_CHANGED');
  }
  const validId = idKey(valid._id);

  console.log('LAST_GOOD_CLEANUP_STAGE=READ_CHUNKS');
  const all = await db.collection(chunksName).find({}).toArray();
  const linked = [];
  const orphan = [];
  for (const chunk of all) {
    if (idKey(chunk.files_id) === validId) linked.push(chunk);
    else orphan.push(chunk);
  }

  const good = snapshot(linked);
  const bad = snapshot(orphan);
  console.log('LAST_GOOD_FILE_ROWS=' + fileRows.length);
  console.log('LAST_GOOD_VALID_LINKED_CHUNKS=' + good.count);
  console.log('LAST_GOOD_ORPHAN_CHUNKS=' + bad.count);
  console.log('LAST_GOOD_ORPHAN_GROUPS=' + bad.groups);

  if (good.count !== EXPECTED_VALID_CHUNKS ||
      bad.count !== EXPECTED_ORPHANS ||
      bad.groups !== EXPECTED_ORPHAN_GROUPS ||
      all.length !== EXPECTED_VALID_CHUNKS + EXPECTED_ORPHANS ||
      good.totalBytes !== valid.length ||
      Math.ceil(valid.length / valid.chunkSize) !== good.count) {
    fail('LAST_GOOD_COUNTS_OR_VALID_FILE_SIZE_CHANGED');
  }
  const positions = new Set(linked.map(chunk => chunk.n));
  for (let n = 0; n < EXPECTED_VALID_CHUNKS; n++) {
    if (!positions.has(n)) fail('LAST_GOOD_VALID_SEQUENCE_INVALID');
  }
  if (expectedValidFingerprint &&
      expectedValidFingerprint !== good.fingerprint) {
    fail('LAST_GOOD_VALID_FILE_CHANGED_DURING_CLEANUP');
  }
  console.log('LAST_GOOD_VALID_FILE_CONTENT_GUARD=PASS');
  console.log('LAST_GOOD_VALID_FINGERPRINT=' + good.fingerprint);
  console.log('LAST_GOOD_ORPHAN_FINGERPRINT=' + bad.fingerprint);
  return { orphan, good, bad, validId };
}

async function main() {
  if (!['preflight', 'cleanup'].includes(MODE)) {
    fail('LAST_GOOD_CLEANUP_MODE_INVALID');
  }
  if (!process.env.MONGODB_URI) fail('MONGODB_URI_MISSING');
  console.log('LAST_GOOD_CLEANUP_MODE=' + MODE);
  console.log('ACTIVE_BUCKET_READ_OR_WRITE=NO');
  console.log('VALID_LAST_GOOD_FILE_WRITE=NO');
  console.log('WHATSAPP_INITIALIZED=NO');
  console.log('MESSAGE_SENT=NO');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    console.log('MONGODB_PING=PASS');
    await checkCandidatePreserved(db);
    const current = await readLastGood(db);

    if (MODE === 'preflight') {
      console.log('LAST_GOOD_BACKUP_WRITES=0');
      console.log('LAST_GOOD_CHUNKS_DELETED=0');
      console.log('LAST_GOOD_PREFLIGHT=PASS');
      return;
    }

    const expectedOrphan =
      process.env.LAST_GOOD_EXPECTED_ORPHAN_FINGERPRINT || '';
    const expectedValid =
      process.env.LAST_GOOD_EXPECTED_VALID_FINGERPRINT || '';
    const confirm = process.env.LAST_GOOD_CLEANUP_CONFIRM || '';
    if (confirm !== 'Delete-52-LAST_GOOD-Orphans' ||
        !/^[a-f0-9]{64}$/.test(expectedOrphan) ||
        !/^[a-f0-9]{64}$/.test(expectedValid)) {
      fail('LAST_GOOD_CLEANUP_EXPLICIT_APPROVAL_REQUIRED');
    }
    if (current.bad.fingerprint !== expectedOrphan ||
        current.good.fingerprint !== expectedValid) {
      fail('LAST_GOOD_PREFLIGHT_FINGERPRINT_CHANGED');
    }
    if (await collectionExists(db, BACKUP)) {
      fail('LAST_GOOD_BACKUP_ALREADY_EXISTS');
    }

    console.log('LAST_GOOD_CLEANUP_STAGE=BACKUP_ORPHAN_CHUNKS');
    const inserted = await db.collection(BACKUP).insertMany(
      current.orphan, { ordered: true }
    );
    if (inserted.insertedCount !== EXPECTED_ORPHANS) {
      fail('LAST_GOOD_BACKUP_INSERT_COUNT_MISMATCH');
    }
    const backed = await db.collection(BACKUP).find({}).toArray();
    const backup = snapshot(backed);
    if (backup.count !== EXPECTED_ORPHANS ||
        backup.fingerprint !== expectedOrphan ||
        backup.groups !== EXPECTED_ORPHAN_GROUPS) {
      fail('LAST_GOOD_BACKUP_READBACK_MISMATCH');
    }
    console.log('LAST_GOOD_BACKUP_READBACK=PASS');
    console.log('LAST_GOOD_BACKUP_COLLECTION=' + BACKUP);
    console.log('LAST_GOOD_BACKUP_CHUNKS=' + EXPECTED_ORPHANS);

    await checkCandidatePreserved(db);
    const rechecked = await readLastGood(db, expectedValid);
    if (rechecked.bad.fingerprint !== expectedOrphan ||
        rechecked.validId !== current.validId) {
      fail('LAST_GOOD_CHANGED_DURING_BACKUP');
    }
    const ids = current.orphan.map(chunk => chunk._id);
    const result = await db.collection(BUCKET + '.chunks')
      .deleteMany({ _id: { $in: ids } });
    console.log('LAST_GOOD_CHUNKS_DELETED=' + result.deletedCount);
    if (result.deletedCount !== EXPECTED_ORPHANS) {
      fail('LAST_GOOD_DELETE_COUNT_MISMATCH_CHECK_BACKUP');
    }

    console.log('LAST_GOOD_CLEANUP_STAGE=POSTCHECK');
    const afterFiles = await db.collection(BUCKET + '.files')
      .find({}).toArray();
    const afterChunks = await db.collection(BUCKET + '.chunks')
      .find({}).toArray();
    const afterGood = snapshot(afterChunks);
    if (afterFiles.length !== 1 ||
        idKey(afterFiles[0]._id) !== current.validId ||
        afterChunks.length !== EXPECTED_VALID_CHUNKS ||
        afterGood.fingerprint !== expectedValid ||
        afterGood.groups !== 1 ||
        afterGood.totalBytes !== EXPECTED_LAST_GOOD_FILE_BYTES) {
      fail('LAST_GOOD_VALID_FILE_POSTCHECK_MISMATCH');
    }
    if (await db.collection(BACKUP).countDocuments({}) !==
        EXPECTED_ORPHANS) {
      fail('LAST_GOOD_BACKUP_POSTCHECK_MISMATCH');
    }
    await checkCandidatePreserved(db);
    console.log('LAST_GOOD_POSTCHECK_FILES=1');
    console.log('LAST_GOOD_POSTCHECK_VALID_CHUNKS=92');
    console.log('LAST_GOOD_POSTCHECK_ORPHAN_CHUNKS=0');
    console.log('LAST_GOOD_BACKUP_PRESERVED=YES');
    console.log('LAST_GOOD_GUARDED_CLEANUP=PASS');
  } finally {
    await mongoose.disconnect();
    console.log('MONGODB_DISCONNECTED=YES');
  }
}

main().catch(error => {
  console.error('LAST_GOOD_CLEANUP_ERROR_CODE=' +
    String(error && error.message || 'UNKNOWN')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_')
      .slice(0, 150));
  process.exitCode = 1;
});
