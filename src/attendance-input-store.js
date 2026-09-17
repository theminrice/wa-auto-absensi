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

  const collection =
    getInputCollection(connection);

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

  try {
    const result =
      await collection.insertOne(document);

    return {
      ...document,
      _id: result.insertedId
    };
  } catch (error) {
    try {
      await bucket.delete(fileId);
    } catch (_) {}

    throw error;
  }
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
  getLatestProject,
  getLatestDocumentationAfter,
  downloadDocumentation
};