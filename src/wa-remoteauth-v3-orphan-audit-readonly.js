'use strict';

// REMOTEAUTH_V3_ORPHAN_READONLY_AUDIT_V1
// Read only. Inspect ONLY Candidate and LAST_GOOD GridFS buckets.
// No WhatsApp client; no change to ACTIVE, LAST_GOOD, Candidate or chunks.

const mongoose = require('mongoose');
const {
  REMOTE_AUTH_V3_CANDIDATE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION
} = require('./remote-auth-v3');

function key(id) {
  if (id && typeof id.toHexString === 'function') {
    return id.toHexString();
  }
  return String(id);
}

async function auditBucket(db, session, label) {
  const bucket = 'whatsapp-' + session;
  const filesName = bucket + '.files';
  const chunksName = bucket + '.chunks';
  // Exact-name metadata queries avoid MongoDB listCollections filter
  // incompatibilities with $in. ACTIVE bucket contents are never read.
  console.log('REMOTE_V3_ORPHAN_' + label + '_STAGE=LIST_COLLECTIONS');
  const names = new Set();
  for (const name of [filesName, chunksName]) {
    const found = await db.listCollections(
      { name }, { nameOnly: true }
    ).toArray();
    if (found.some(item => item.name === name)) {
      names.add(name);
    }
  }
  console.log('REMOTE_V3_ORPHAN_' + label + '_STAGE=READ_FILES');

  const files = names.has(filesName)
    ? await db.collection(filesName).find({}, {
      projection: { _id: 1, filename: 1, length: 1,
        chunkSize: 1, uploadDate: 1 }
    }).toArray() : [];
  const allowed = session + '.zip';
  const fileIds = new Set(files.map(x => key(x._id)));
  const current = files.filter(x => x.filename === allowed);
  let chunkCount = 0;
  let linkedCount = 0;
  let orphanCount = 0;
  const orphanGroups = new Map();
  const linkedGroups = new Map();
  let malformedCount = 0;
  console.log('REMOTE_V3_ORPHAN_' + label + '_STAGE=COUNT_CHUNKS');
  if (names.has(chunksName)) {
    for await (const chunk of db.collection(chunksName).find({}, {
      projection: { files_id: 1, n: 1 }
    })) {
      chunkCount++;
      const id = key(chunk.files_id);
      if (!Number.isInteger(chunk.n) || chunk.n < 0 ||
          chunk.files_id === undefined || chunk.files_id === null) {
        malformedCount++;
      }
      if (fileIds.has(id)) {
        linkedCount++;
        linkedGroups.set(id, (linkedGroups.get(id) || 0) + 1);
      } else {
        orphanCount++;
        orphanGroups.set(id, (orphanGroups.get(id) || 0) + 1);
      }
    }
  }

  const report = {
    label,
    filesCollectionPresent: names.has(filesName),
    chunksCollectionPresent: names.has(chunksName),
    totalFileRows: files.length,
    expectedNamedFileRows: current.length,
    unexpectedFilenameRows: files.length - current.length,
    totalChunkRows: chunkCount,
    chunksLinkedToExistingFiles: linkedCount,
    orphanChunkRows: orphanCount,
    orphanFileIdGroups: orphanGroups.size,
    linkedFileIdGroups: linkedGroups.size,
    malformedChunkRows: malformedCount,
    currentFileSize: current.length === 1 ? current[0].length : null,
    currentFileChunkCount: current.length === 1
      ? (linkedGroups.get(key(current[0]._id)) || 0) : null
  };

  console.log('REMOTE_V3_ORPHAN_' + label + '=' +
    JSON.stringify(report));

  if (chunkCount !== linkedCount + orphanCount) {
    throw new Error('CHUNK_ACCOUNTING_FAILED_' + label);
  }
  return report;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI_MISSING');
  }
  console.log('REMOTE_V3_ORPHAN_AUDIT=READ_ONLY');
  console.log('REMOTE_V3_ORPHAN_AUDIT_ACTIVE_BUCKET_ACCESSED=NO');
  console.log('REMOTE_V3_ORPHAN_AUDIT_WHATSAPP_INITIALIZED=NO');
  console.log('REMOTE_V3_ORPHAN_AUDIT_DB_WRITES=NO');
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    console.log('MONGODB_PING=PASS');
    const candidate = await auditBucket(
      db, REMOTE_AUTH_V3_CANDIDATE_SESSION, 'CANDIDATE'
    );
    const lastGood = await auditBucket(
      db, REMOTE_AUTH_V3_LAST_GOOD_SESSION, 'LAST_GOOD'
    );
    console.log('REMOTE_V3_ORPHAN_HISTORIC_EXPECTED_261_52=' +
      (candidate.orphanChunkRows === 261 &&
       lastGood.orphanChunkRows === 52 ? 'MATCH' : 'DIFFERENT'));
    console.log('REMOTE_V3_ORPHAN_AUDIT=PASS');
    // No cleanup authorized or performed by this audit.
    console.log('REMOTE_V3_ORPHAN_DELETED_COUNT=0');
  } finally {
    await mongoose.disconnect();
    console.log('MONGODB_DISCONNECTED=YES');
  }
}

main().catch(error => {
  const safeMessage = String(error && error.message || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 180);
  console.error('REMOTE_V3_ORPHAN_AUDIT_ERROR_CODE=' +
    (safeMessage || 'UNKNOWN'));
  console.error('REMOTE_V3_ORPHAN_AUDIT_ERROR_NAME=' +
    String(error && error.name || 'UNKNOWN')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
  process.exitCode = 1;
});
