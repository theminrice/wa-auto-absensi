'use strict';

// REMOTEAUTH_V3_CANDIDATE_GUARDED_CLEANUP_V1
// Phase 1 preflight: read only, print content-bound fingerprint.
// Phase 2 cleanup: exact approved fingerprint, copy ALL 261 chunks to
// a separate durable MongoDB backup collection, verify, then delete
// ONLY those exact Candidate chunk _ids. ACTIVE/LAST_GOOD never written.
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  REMOTE_AUTH_V3_CANDIDATE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION
} = require('./remote-auth-v3');

const MODE = process.env.CANDIDATE_CLEANUP_MODE || 'preflight';
const BACKUP_COLLECTION =
  'wa_remoteauth_v3_candidate_orphans_backup_20260923';
const CANDIDATE_BUCKET = 'whatsapp-' + REMOTE_AUTH_V3_CANDIDATE_SESSION;
const LAST_GOOD_BUCKET = 'whatsapp-' + REMOTE_AUTH_V3_LAST_GOOD_SESSION;
const EXPECTED_FILE_ROWS = 0;
const EXPECTED_CHUNKS = 261;
const EXPECTED_GROUPS = 3;
const EXPECTED_LAST_GOOD_BYTES = 23987708;
const EXPECTED_LAST_GOOD_LINKED = 92;
const EXPECTED_LAST_GOOD_ORPHANS = 52;

function fail(code) {
  throw new Error(code);
}

function objectIdKey(value) {
  if (!value || typeof value.toHexString !== 'function') {
    fail('CHUNK_OBJECT_ID_INVALID');
  }
  return value.toHexString();
}

function dataBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && Buffer.isBuffer(value.buffer)) return value.buffer;
  fail('CHUNK_BINARY_DATA_INVALID');
}

function snapshot(chunks) {
  const groupSet = new Set();
  const chunkIdSet = new Set();
  const groupPositions = new Set();
  const details = [];
  for (const chunk of chunks) {
    const id = objectIdKey(chunk._id);
    const groupId = objectIdKey(chunk.files_id);
    if (!Number.isSafeInteger(chunk.n) || chunk.n < 0) {
      fail('CHUNK_N_INVALID');
    }
    const data = dataBuffer(chunk.data);
    if (data.length === 0 || data.length > 262144) {
      fail('CHUNK_SIZE_INVALID');
    }
    if (chunkIdSet.has(id)) fail('CHUNK_ID_DUPLICATE');
    chunkIdSet.add(id);
    groupSet.add(groupId);
    const positionKey = groupId + ':' + chunk.n;
    if (groupPositions.has(positionKey)) {
      fail('CHUNK_GROUP_POSITION_DUPLICATE');
    }
    groupPositions.add(positionKey);
    const digest = crypto.createHash('sha256')
      .update(data).digest('hex');
    details.push(id + ':' + groupId + ':' + chunk.n + ':' +
      data.length + ':' + digest);
  }
  details.sort();
  return {
    count: chunks.length,
    groups: groupSet.size,
    fingerprint: crypto.createHash('sha256')
      .update(details.join('\n')).digest('hex')
  };
}

async function exists(db, name) {
  const rows = await db.listCollections(
    { name }, { nameOnly: true }
  ).toArray();
  return rows.some(row => row.name === name);
}

async function readCandidate(db) {
  console.log('CANDIDATE_CLEANUP_STAGE=CHECK_CANDIDATE_FILES');
  const filesName = CANDIDATE_BUCKET + '.files';
  const chunksName = CANDIDATE_BUCKET + '.chunks';
  if (!(await exists(db, filesName)) ||
      !(await exists(db, chunksName))) {
    fail('CANDIDATE_COLLECTIONS_MISSING');
  }
  const filesCount = await db.collection(filesName)
    .countDocuments({});
  console.log('CANDIDATE_FILE_ROWS=' + filesCount);
  if (filesCount !== EXPECTED_FILE_ROWS) {
    fail('CANDIDATE_FILE_ROWS_CHANGED');
  }
  console.log('CANDIDATE_CLEANUP_STAGE=READ_CANDIDATE_CHUNKS');
  const chunks = await db.collection(chunksName)
    .find({}).toArray();
  const result = snapshot(chunks);
  console.log('CANDIDATE_TOTAL_CHUNKS=' + result.count);
  console.log('CANDIDATE_ORPHAN_GROUPS=' + result.groups);
  if (result.count !== EXPECTED_CHUNKS ||
      result.groups !== EXPECTED_GROUPS) {
    fail('CANDIDATE_COUNTS_CHANGED');
  }
  console.log('CANDIDATE_ORPHAN_FINGERPRINT=' +
    result.fingerprint);
  return { chunks, ...result };
}

async function checkLastGood(db) {
  console.log('CANDIDATE_CLEANUP_STAGE=VERIFY_LAST_GOOD_READ_ONLY');
  const filesName = LAST_GOOD_BUCKET + '.files';
  const chunksName = LAST_GOOD_BUCKET + '.chunks';
  if (!(await exists(db, filesName)) ||
      !(await exists(db, chunksName))) {
    fail('LAST_GOOD_COLLECTIONS_MISSING');
  }
  const files = await db.collection(filesName)
    .find({}, { projection: {
      _id: 1, filename: 1, length: 1
    } }).toArray();
  if (files.length !== 1 ||
      files[0].filename !== REMOTE_AUTH_V3_LAST_GOOD_SESSION +
        '.zip' ||
      files[0].length !== EXPECTED_LAST_GOOD_BYTES) {
    fail('LAST_GOOD_FILE_BASELINE_CHANGED');
  }
  const linked = await db.collection(chunksName)
    .countDocuments({ files_id: files[0]._id });
  const total = await db.collection(chunksName)
    .countDocuments({});
  console.log('LAST_GOOD_VALID_LINKED_CHUNKS=' + linked);
  console.log('LAST_GOOD_ORPHAN_CHUNKS=' + (total - linked));
  if (linked !== EXPECTED_LAST_GOOD_LINKED ||
      total - linked !== EXPECTED_LAST_GOOD_ORPHANS) {
    fail('LAST_GOOD_CHUNK_BASELINE_CHANGED');
  }
  console.log('LAST_GOOD_READONLY_GUARD=PASS');
}

async function main() {
  if (!['preflight', 'cleanup'].includes(MODE)) {
    fail('CLEANUP_MODE_INVALID');
  }
  if (!process.env.MONGODB_URI) fail('MONGODB_URI_MISSING');
  console.log('CANDIDATE_CLEANUP_MODE=' + MODE);
  console.log('ACTIVE_BUCKET_READ_OR_WRITE=NO');
  console.log('LAST_GOOD_BUCKET_WRITE=NO');
  console.log('WHATSAPP_INITIALIZED=NO');
  console.log('MESSAGE_SENT=NO');
  console.log('CANDIDATE_CLEANUP_EXPECTED=261_ORPHANS_3_GROUPS');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    console.log('MONGODB_PING=PASS');
    await checkLastGood(db);
    const current = await readCandidate(db);
    if (MODE === 'preflight') {
      console.log('CANDIDATE_BACKUP_WRITES=0');
      console.log('CANDIDATE_CHUNKS_DELETED=0');
      console.log('CANDIDATE_PREFLIGHT=PASS');
      return;
    }

    const approved = process.env.CANDIDATE_EXPECTED_FINGERPRINT || '';
    const confirmed = process.env.CANDIDATE_CLEANUP_CONFIRM || '';
    if (confirmed !== 'Delete-261-Candidate-Orphans' ||
        !/^[a-f0-9]{64}$/.test(approved)) {
      fail('CANDIDATE_CLEANUP_EXPLICIT_APPROVAL_REQUIRED');
    }
    if (approved !== current.fingerprint) {
      fail('CANDIDATE_FINGERPRINT_CHANGED');
    }
    if (await exists(db, BACKUP_COLLECTION)) {
      fail('BACKUP_COLLECTION_ALREADY_EXISTS');
    }

    console.log('CANDIDATE_CLEANUP_STAGE=BACKUP_261_CHUNKS');
    // Preserve the actual GridFS BSON documents, including binary bytes,
    // _id, files_id and n, in a separate MongoDB collection.
    const inserted = await db.collection(BACKUP_COLLECTION)
      .insertMany(current.chunks, { ordered: true });
    if (inserted.insertedCount !== EXPECTED_CHUNKS) {
      fail('CANDIDATE_BACKUP_INSERT_COUNT_MISMATCH');
    }
    const backed = await db.collection(BACKUP_COLLECTION)
      .find({}).toArray();
    const backupState = snapshot(backed);
    if (backupState.count !== EXPECTED_CHUNKS ||
        backupState.groups !== EXPECTED_GROUPS ||
        backupState.fingerprint !== approved) {
      fail('CANDIDATE_BACKUP_READBACK_MISMATCH');
    }
    console.log('CANDIDATE_BACKUP_READBACK=PASS');
    console.log('CANDIDATE_BACKUP_COLLECTION=' +
      BACKUP_COLLECTION);
    console.log('CANDIDATE_BACKUP_CHUNKS=261');

    // Fail closed if anything changed during backup.
    await checkLastGood(db);
    const beforeDelete = await readCandidate(db);
    if (beforeDelete.fingerprint !== approved) {
      fail('CANDIDATE_CHANGED_DURING_BACKUP');
    }
    const originalIds = current.chunks.map(chunk => chunk._id);
    const result = await db.collection(CANDIDATE_BUCKET + '.chunks')
      .deleteMany({ _id: { $in: originalIds } });
    console.log('CANDIDATE_CHUNKS_DELETED=' +
      result.deletedCount);
    if (result.deletedCount !== EXPECTED_CHUNKS) {
      fail('CANDIDATE_DELETE_COUNT_MISMATCH_CHECK_BACKUP');
    }
    const remaining = await db.collection(CANDIDATE_BUCKET +
      '.chunks').countDocuments({});
    const remainingFiles = await db.collection(CANDIDATE_BUCKET +
      '.files').countDocuments({});
    if (remaining !== 0 || remainingFiles !== 0) {
      fail('CANDIDATE_POSTCHECK_NONEMPTY_CHECK_BACKUP');
    }
    await checkLastGood(db);
    console.log('CANDIDATE_POSTCHECK_FILES=0');
    console.log('CANDIDATE_POSTCHECK_CHUNKS=0');
    console.log('CANDIDATE_BACKUP_PRESERVED=YES');
    console.log('CANDIDATE_GUARDED_CLEANUP=PASS');
  } finally {
    await mongoose.disconnect();
    console.log('MONGODB_DISCONNECTED=YES');
  }
}

main().catch(error => {
  console.error('CANDIDATE_CLEANUP_ERROR_CODE=' +
    String(error && error.message || 'UNKNOWN')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_')
      .slice(0, 150));
  process.exitCode = 1;
});
