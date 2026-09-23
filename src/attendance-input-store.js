'use strict';

const mongoose = require('mongoose');

const INPUT_COLLECTION = 'attendance_inputs';
const DOC_BUCKET = 'attendance_docs';
const STORAGE_VERSION = 1;

function normalizeProject(value) {
  if (typeof value !== 'string') {
    throw new TypeError('PROJECT_MUST_BE_STRING');
  }

  const project = value.trim();

  if (!project) {
    throw new Error('PROJECT_EMPTY');
  }

  if (project.length > 1000) {
    throw new Error('PROJECT_TOO_LONG');
  }

  return project;
}

function normalizeDate(value) {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('INVALID_TIMESTAMP');
  }

  return date;
}

function validateImageMime(mimetype) {
  if (typeof mimetype !== 'string') {
    throw new TypeError('IMAGE_MIMETYPE_MUST_BE_STRING');
  }

  const normalized = mimetype
    .trim()
    .toLowerCase();

  if (!normalized.startsWith('image/')) {
    throw new Error('DOCUMENTATION_MUST_BE_IMAGE');
  }

  return normalized;
}

function requireConnection(connection) {
  if (
    !connection ||
    !connection.db
  ) {
    throw new Error('MONGODB_CONNECTION_NOT_READY');
  }

  return connection;
}

function getInputCollection(connection) {
  const safeConnection =
    requireConnection(connection);

  return safeConnection.db.collection(
    INPUT_COLLECTION
  );
}

function getDocumentBucket(connection) {
  const safeConnection =
    requireConnection(connection);

  return new mongoose.mongo.GridFSBucket(
    safeConnection.db,
    {
      bucketName: DOC_BUCKET
    }
  );
}

async function ensureAttendanceIndexes(connection) {
  const collection =
    getInputCollection(connection);

  await collection.createIndex(
    {
      kind: 1,
      createdAt: -1,
      _id: -1
    },
    {
      name: 'kind_createdAt_desc'
    }
  );
}

// WA_AUTO_ABSENSI_REPLACE_CURRENT_STORAGE_V1D
function collectSourceMessageIds(rows) {
  const ids = new Set();

  for (const row of rows || []) {
    const value =
      row &&
      row.sourceMessageId;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          typeof item === 'string' &&
          item.trim()
        ) {
          ids.add(
            item.trim()
          );
        }
      }

      continue;
    }

    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      ids.add(
        value.trim()
      );
    }
  }

  return Array.from(ids);
}

async function preserveSourceMessageIds(
  collection,
  rows
) {
  const ids =
    collectSourceMessageIds(rows);

  if (ids.length === 0) {
    return;
  }

  const now =
    new Date();

  await collection.updateOne(
    {
      kind: 'ingest-dedup'
    },
    {
      $setOnInsert: {
        version: STORAGE_VERSION,
        kind: 'ingest-dedup',
        source: 'system',
        createdAt: now
      },
      $set: {
        updatedAt: now
      },
      $addToSet: {
        sourceMessageId: {
          $each: ids
        }
      }
    },
    {
      upsert: true
    }
  );
}

async function saveProject(
  connection,
  project,
  createdAt = new Date()
) {
  const collection =
    getInputCollection(connection);

  const document = {
    version: STORAGE_VERSION,
    kind: 'project',
    project: normalizeProject(project),
    createdAt: normalizeDate(createdAt),
    source: 'manual'
  };

  const existingRows =
    await collection
      .find(
        {
          kind: 'project'
        },
        {
          projection: {
            _id: 1,
            sourceMessageId: 1,
            createdAt: 1
          }
        }
      )
      .sort({
        createdAt: -1,
        _id: -1
      })
      .toArray();

  await preserveSourceMessageIds(
    collection,
    existingRows
  );

  if (existingRows.length > 0) {
    const canonicalId =
      existingRows[0]._id;

    await collection.deleteMany({
      kind: 'project',
      _id: {
        $ne: canonicalId
      }
    });

    const result =
      await collection.updateOne(
        {
          _id: canonicalId
        },
        {
          $set: document,
          $unset: {
            sourceMessageId: ''
          }
        }
      );

    if (result.matchedCount !== 1) {
      throw new Error(
        'PROJECT_CURRENT_ROW_UPDATE_FAILED'
      );
    }

    return {
      ...document,
      _id: canonicalId
    };
  }

  const result =
    await collection.insertOne(document);

  return {
    ...document,
    _id: result.insertedId
  };
}

function uploadBuffer(
  bucket,
  filename,
  buffer,
  options
) {
  return new Promise((resolve, reject) => {
    const stream =
      bucket.openUploadStream(
        filename,
        options
      );

    stream.once('error', reject);

    stream.once('finish', () => {
      resolve(stream.id);
    });

    stream.end(buffer);
  });
}

async function saveDocumentation(
  connection,
  {
    buffer,
    filename,
    mimetype,
    createdAt = new Date()
  }
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(
      'DOCUMENTATION_BUFFER_REQUIRED'
    );
  }

  if (buffer.length === 0) {
    throw new Error(
      'DOCUMENTATION_BUFFER_EMPTY'
    );
  }

  if (
    typeof filename !== 'string' ||
    !filename.trim()
  ) {
    throw new Error(
      'DOCUMENTATION_FILENAME_REQUIRED'
    );
  }

  const safeMime =
    validateImageMime(mimetype);

  const safeCreatedAt =
    normalizeDate(createdAt);

  const bucket =
    getDocumentBucket(connection);

  const collection =
    getInputCollection(connection);

  const existingRows =
    await collection
      .find(
        {
          kind: 'documentation'
        },
        {
          projection: {
            _id: 1,
            fileId: 1,
            sourceMessageId: 1,
            createdAt: 1
          }
        }
      )
      .sort({
        createdAt: -1,
        _id: -1
      })
      .toArray();

  await preserveSourceMessageIds(
    collection,
    existingRows
  );

  const fileId =
    await uploadBuffer(
      bucket,
      filename.trim(),
      buffer,
      {
        contentType: safeMime,
        metadata: {
          type: 'attendance_documentation',
          createdAt: safeCreatedAt,
          version: STORAGE_VERSION
        }
      }
    );

  const document = {
    version: STORAGE_VERSION,
    kind: 'documentation',
    fileId,
    filename: filename.trim(),
    mimetype: safeMime,
    size: buffer.length,
    createdAt: safeCreatedAt,
    source: 'manual'
  };

  let storedId = null;
  let metadataCommitted = false;

  try {
    if (existingRows.length > 0) {
      storedId =
        existingRows[0]._id;

      await collection.deleteMany({
        kind: 'documentation',
        _id: {
          $ne: storedId
        }
      });

      const result =
        await collection.updateOne(
          {
            _id: storedId
          },
          {
            $set: document,
            $unset: {
              sourceMessageId: ''
            }
          }
        );

      if (result.matchedCount !== 1) {
        throw new Error(
          'DOCUMENTATION_CURRENT_ROW_UPDATE_FAILED'
        );
      }

      metadataCommitted = true;
    } else {
      const result =
        await collection.insertOne(
          document
        );

      storedId =
        result.insertedId;

      metadataCommitted = true;
    }
  } catch (error) {
    if (!metadataCommitted) {
      try {
        await bucket.delete(fileId);
      } catch (_) {}
    }

    throw error;
  }

  try {
    const staleFiles =
      await bucket
        .find({
          'metadata.type':
            'attendance_documentation',
          _id: {
            $ne: fileId
          }
        })
        .toArray();

    for (const staleFile of staleFiles) {
      if (
        !staleFile ||
        !staleFile._id
      ) {
        continue;
      }

      try {
        await bucket.delete(
          staleFile._id
        );
      } catch (cleanupError) {
        console.warn(
          'STALE_DOCUMENTATION_FILE_DELETE_FAILED=' +
          String(
            cleanupError &&
            cleanupError.message
              ? cleanupError.message
              : cleanupError
          )
        );
      }
    }
  } catch (cleanupError) {
    console.warn(
      'STALE_DOCUMENTATION_SCAN_FAILED=' +
      String(
        cleanupError &&
        cleanupError.message
          ? cleanupError.message
          : cleanupError
      )
    );
  }

  return {
    ...document,
    _id: storedId
  };
}

// ATTENDANCE_LEAVE_CURRENT_STATE_V1
// A newer l: command replaces the previous leave range only.
// Existing project/documentation rows are never modified.
async function saveLeave(
  connection,
  leave,
  createdAt = new Date()
) {
  const collection =
    getInputCollection(connection);

  if (
    !leave ||
    typeof leave.startDate !== 'string' ||
    typeof leave.endDate !== 'string'
  ) {
    throw new Error(
      'LEAVE_PLAN_INVALID'
    );
  }

  const {
    evaluateLeaveForDate
  } = require('./attendance-leave');

  // Validate stored bounds, even when not currently on leave.
  evaluateLeaveForDate(leave, createdAt);

  const document = {
    version: STORAGE_VERSION,
    kind: 'leave',
    startDate: leave.startDate,
    endDate: leave.endDate,
    createdAt: normalizeDate(createdAt),
    source: 'manual'
  };

  const existingRows =
    await collection
      .find(
        { kind: 'leave' },
        {
          projection: {
            _id: 1,
            sourceMessageId: 1,
            createdAt: 1
          }
        }
      )
      .sort({
        createdAt: -1,
        _id: -1
      })
      .toArray();

  await preserveSourceMessageIds(
    collection,
    existingRows
  );

  if (existingRows.length > 0) {
    const canonicalId =
      existingRows[0]._id;

    const result =
      await collection.updateOne(
        { _id: canonicalId },
        {
          $set: document,
          $unset: {
            sourceMessageId: ''
          }
        }
      );

    if (result.matchedCount !== 1) {
      throw new Error(
        'LEAVE_CURRENT_ROW_UPDATE_FAILED'
      );
    }

    await collection.deleteMany({
      kind: 'leave',
      _id: {
        $ne: canonicalId
      }
    });

    return {
      ...document,
      _id: canonicalId
    };
  }

  const result =
    await collection.insertOne(document);

  return {
    ...document,
    _id: result.insertedId
  };
}

async function getLatestLeave(connection) {
  const collection =
    getInputCollection(connection);

  return collection.findOne(
    { kind: 'leave' },
    {
      sort: {
        createdAt: -1,
        _id: -1
      }
    }
  );
}

async function getLatestProject(connection) {
  const collection =
    getInputCollection(connection);

  return collection.findOne(
    {
      kind: 'project'
    },
    {
      sort: {
        createdAt: -1,
        _id: -1
      }
    }
  );
}

// WA_AUTO_ABSENSI_CHECKOUT_LATEST_AVAILABLE_DOCUMENTATION_V2
// Select the most recent documentation currently in the canonical store,
// regardless of its calendar date or when the latest project was submitted.
// The Palelu sync step runs separately before production Check Out.
// An unavailable newer Palelu message cannot be inferred from this query.
async function getLatestDocumentation(connection) {
  const collection =
    getInputCollection(connection);

  return collection.findOne(
    { kind: 'documentation' },
    {
      sort: {
        createdAt: -1,
        _id: -1
      }
    }
  );
}

async function getLatestDocumentationAfter(
  connection,
  projectTimestamp
) {
  const collection =
    getInputCollection(connection);

  const after =
    normalizeDate(projectTimestamp);

  return collection.findOne(
    {
      kind: 'documentation',
      createdAt: {
        $gte: after
      }
    },
    {
      sort: {
        createdAt: -1,
        _id: -1
      }
    }
  );
}

function downloadGridFsFile(
  bucket,
  fileId
) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const stream =
      bucket.openDownloadStream(fileId);

    stream.on('data', chunk => {
      chunks.push(chunk);
    });

    stream.once('error', reject);

    stream.once('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

async function downloadDocumentation(
  connection,
  documentation
) {
  if (
    !documentation ||
    !documentation.fileId
  ) {
    throw new Error(
      'DOCUMENTATION_FILE_ID_REQUIRED'
    );
  }

  const bucket =
    getDocumentBucket(connection);

  return downloadGridFsFile(
    bucket,
    documentation.fileId
  );
}

module.exports = {
  INPUT_COLLECTION,
  DOC_BUCKET,
  STORAGE_VERSION,
  normalizeProject,
  normalizeDate,
  validateImageMime,
  ensureAttendanceIndexes,
  saveProject,
  saveDocumentation,
  saveLeave,
  getLatestLeave,
  getLatestProject,
  getLatestDocumentationAfter,
  getLatestDocumentation,
  downloadDocumentation
};