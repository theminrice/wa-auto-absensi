'use strict';

const crypto = require('crypto');
const fs = require('fs');
const mongoose = require('mongoose');

const {
  INPUT_COLLECTION,
  DOC_BUCKET
} = require('./attendance-input-store');

const MONGODB_URI =
  process.env.MONGODB_URI;

function stableNormalize(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return {
      __date:
        value.toISOString()
    };
  }

  if (
    value &&
    typeof value === 'object' &&
    typeof value.toHexString === 'function'
  ) {
    return {
      __objectId:
        value.toHexString()
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      __bufferSha256:
        crypto
          .createHash('sha256')
          .update(value)
          .digest('hex'),
      __bufferLength:
        value.length
    };
  }

  if (Array.isArray(value)) {
    return value.map(
      item =>
        stableNormalize(item)
    );
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const output = {};

    for (
      const key of
      Object.keys(value).sort()
    ) {
      output[key] =
        stableNormalize(
          value[key]
        );
    }

    return output;
  }

  return value;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        stableNormalize(value)
      )
    )
    .digest('hex');
}

function hashGridFsFile(
  bucket,
  fileId
) {
  return new Promise(
    (resolve, reject) => {
      const hash =
        crypto.createHash(
          'sha256'
        );

      let size = 0;

      const stream =
        bucket.openDownloadStream(
          fileId
        );

      stream.on(
        'data',
        chunk => {
          size +=
            chunk.length;

          hash.update(
            chunk
          );
        }
      );

      stream.once(
        'error',
        reject
      );

      stream.once(
        'end',
        () => {
          resolve({
            sha256:
              hash.digest('hex'),
            size
          });
        }
      );
    }
  );
}

async function canonicalState() {
  const collection =
    mongoose.connection.db.collection(
      INPUT_COLLECTION
    );

  const bucket =
    new mongoose.mongo.GridFSBucket(
      mongoose.connection.db,
      {
        bucketName:
          DOC_BUCKET
      }
    );

  const projectCount =
    await collection.countDocuments({
      kind: 'project'
    });

  const documentationCount =
    await collection.countDocuments({
      kind: 'documentation'
    });

  const project =
    await collection.findOne(
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

  const documentation =
    await collection.findOne(
      {
        kind: 'documentation'
      },
      {
        sort: {
          createdAt: -1,
          _id: -1
        }
      }
    );

  let documentationFile = null;

  if (
    documentation &&
    documentation.fileId
  ) {
    documentationFile =
      await hashGridFsFile(
        bucket,
        documentation.fileId
      );
  }

  const state = {
    projectCount,
    documentationCount,
    projectSha256:
      project
        ? sha256Json(project)
        : null,
    documentationSha256:
      documentation
        ? sha256Json(
            documentation
          )
        : null,
    documentationFileSha256:
      documentationFile
        ? documentationFile.sha256
        : null,
    documentationFileSize:
      documentationFile
        ? documentationFile.size
        : null
  };

  return {
    ...state,
    overallSha256:
      sha256Json(state)
  };
}

async function main() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI_MISSING'
    );
  }

  const args =
    process.argv.slice(2);

  const snapshotIndex =
    args.indexOf('--snapshot');

  const compareIndex =
    args.indexOf('--compare');

  if (
    snapshotIndex === -1 &&
    compareIndex === -1
  ) {
    throw new Error(
      'MODE_REQUIRED_SNAPSHOT_OR_COMPARE'
    );
  }

  if (
    snapshotIndex !== -1 &&
    compareIndex !== -1
  ) {
    throw new Error(
      'MODE_CONFLICT'
    );
  }

  const modeIndex =
    snapshotIndex !== -1
      ? snapshotIndex
      : compareIndex;

  const filePath =
    args[modeIndex + 1];

  if (!filePath) {
    throw new Error(
      'STATE_FILE_REQUIRED'
    );
  }

  await mongoose.connect(
    MONGODB_URI,
    {
      dbName:
        'wa_auto_absensi',
      serverSelectionTimeoutMS:
        30000
    }
  );

  console.log(
    'CANONICAL_GUARD_MONGODB_CONNECTED=YES'
  );

  const current =
    await canonicalState();

  console.log(
    `CANONICAL_OVERALL_SHA256=${current.overallSha256}`
  );

  console.log(
    `CANONICAL_PROJECT_COUNT=${current.projectCount}`
  );

  console.log(
    `CANONICAL_DOCUMENTATION_COUNT=${current.documentationCount}`
  );

  if (
    snapshotIndex !== -1
  ) {
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        current,
        null,
        2
      ) + '\n',
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    console.log(
      'CANONICAL_SNAPSHOT=PASS'
    );
  } else {
    const expected =
      JSON.parse(
        fs.readFileSync(
          filePath,
          'utf8'
        )
      );

    const projectMatch =
      expected.projectCount ===
        current.projectCount &&
      expected.projectSha256 ===
        current.projectSha256;

    const documentationMatch =
      expected.documentationCount ===
        current.documentationCount &&
      expected.documentationSha256 ===
        current.documentationSha256 &&
      expected.documentationFileSha256 ===
        current.documentationFileSha256 &&
      expected.documentationFileSize ===
        current.documentationFileSize;

    const overallMatch =
      expected.overallSha256 ===
      current.overallSha256;

    console.log(
      `CANONICAL_PROJECT_MATCH=${projectMatch ? 'YES' : 'NO'}`
    );

    console.log(
      `CANONICAL_DOCUMENTATION_MATCH=${documentationMatch ? 'YES' : 'NO'}`
    );

    console.log(
      `CANONICAL_OVERALL_MATCH=${overallMatch ? 'YES' : 'NO'}`
    );

    if (
      !projectMatch ||
      !documentationMatch ||
      !overallMatch
    ) {
      throw new Error(
        'CANONICAL_STATE_CHANGED'
      );
    }

    console.log(
      'CANONICAL_COMPARE=PASS'
    );
  }

  await mongoose.disconnect();

  console.log(
    'CANONICAL_GUARD_MONGOOSE_DISCONNECTED=YES'
  );
}

main().catch(
  async error => {
    console.log(
      'CANONICAL_GUARD=FAIL'
    );

    console.log(
      'CANONICAL_GUARD_ERROR=' +
      error.message
    );

    try {
      await mongoose.disconnect();
    } catch (_) {}

    process.exit(1);
  }
);
