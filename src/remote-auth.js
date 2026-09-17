'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RemoteAuth
} = require('whatsapp-web.js');

const {
  MongoStore
} = require('wwebjs-mongo');

const REMOTE_AUTH_CLIENT_ID = 'wa-auto-absensi-remote';

const REMOTE_AUTH_SESSION =
  `RemoteAuth-${REMOTE_AUTH_CLIENT_ID}`;

const REMOTE_AUTH_BACKUP_MS = 60000;

function getRemoteAuthDataPath() {
  if (
    process.env.WWEBJS_REMOTE_DATA_PATH &&
    process.env.WWEBJS_REMOTE_DATA_PATH.trim()
  ) {
    return path.resolve(
      process.env.WWEBJS_REMOTE_DATA_PATH
    );
  }

  return path.join(
    os.tmpdir(),
    'wa-auto-absensi-remoteauth'
  );
}

function getPuppeteerOptions() {
  const options = {
    headless: true,

    protocolTimeout: 120000,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  };

  if (
    process.env.CHROME_PATH &&
    process.env.CHROME_PATH.trim()
  ) {
    options.executablePath =
      process.env.CHROME_PATH.trim();
  }

  return options;
}

/*
 * Compatibility bridge for the exact dependency combination
 * currently verified by this project:
 *
 * whatsapp-web.js 1.34.7 creates:
 *   <dataPath>/<session>.zip
 *
 * wwebjs-mongo 1.1.0 save() reads:
 *   <process.cwd()>/<session>.zip
 *
 * Do not patch node_modules. Copy only for the duration of
 * MongoStore.save(), then remove the compatibility copy.
 */
function installMongoStoreSaveCompatibility(
  store,
  dataPath
) {
  if (!store || typeof store.save !== 'function') {
    throw new Error(
      'INVALID_MONGO_STORE'
    );
  }

  if (!dataPath) {
    throw new Error(
      'REMOTE_AUTH_DATA_PATH_REQUIRED'
    );
  }

  const resolvedDataPath =
    path.resolve(dataPath);

  const originalSave =
    store.save.bind(store);

  store.save =
    async function compatibleSave(options) {
      if (
        !options ||
        !options.session
      ) {
        throw new Error(
          'REMOTE_AUTH_SAVE_SESSION_REQUIRED'
        );
      }

      const zipName =
        `${options.session}.zip`;

      const sourceCandidates = [];

      if (
        typeof options.path === 'string' &&
        options.path.trim()
      ) {
        sourceCandidates.push(
          path.resolve(options.path)
        );
      }

      sourceCandidates.push(
        path.resolve(
          resolvedDataPath,
          zipName
        )
      );

      const sourceZip =
        sourceCandidates.find(
          candidate =>
            fs.existsSync(candidate)
        );

      if (!sourceZip) {
        throw new Error(
          'REMOTE_AUTH_SOURCE_ZIP_NOT_FOUND'
        );
      }

      const sourceSize =
        fs.statSync(sourceZip).size;

      if (sourceSize < 1000) {
        throw new Error(
          'REMOTE_AUTH_SOURCE_ZIP_TOO_SMALL'
        );
      }

      const expectedZip =
        path.resolve(
          process.cwd(),
          zipName
        );

      let compatibilityCopyCreated =
        false;

      try {
        const sourceNormalized =
          path.normalize(sourceZip)
            .toLowerCase();

        const expectedNormalized =
          path.normalize(expectedZip)
            .toLowerCase();

        if (
          sourceNormalized !==
          expectedNormalized
        ) {
          fs.copyFileSync(
            sourceZip,
            expectedZip
          );

          compatibilityCopyCreated =
            true;
        }

        if (!fs.existsSync(expectedZip)) {
          throw new Error(
            'REMOTE_AUTH_COMPAT_ZIP_NOT_FOUND'
          );
        }

        await originalSave(options);
      }
      finally {
        if (
          compatibilityCopyCreated &&
          fs.existsSync(expectedZip)
        ) {
          fs.rmSync(
            expectedZip,
            {
              force: true
            }
          );
        }
      }
    };

  return store;
}

function createMongoStore(
  mongoose,
  dataPath = getRemoteAuthDataPath()
) {
  if (!mongoose) {
    throw new Error(
      'MONGOOSE_INSTANCE_REQUIRED'
    );
  }

  const store =
    new MongoStore({
      mongoose
    });

  return installMongoStoreSaveCompatibility(
    store,
    dataPath
  );
}

function createRemoteAuth(
  store,
  dataPath = getRemoteAuthDataPath()
) {
  if (!store) {
    throw new Error(
      'MONGO_STORE_REQUIRED'
    );
  }

  return new RemoteAuth({
    clientId: REMOTE_AUTH_CLIENT_ID,
    dataPath,
    store,
    backupSyncIntervalMs:
      REMOTE_AUTH_BACKUP_MS
  });
}

module.exports = {
  REMOTE_AUTH_CLIENT_ID,
  REMOTE_AUTH_SESSION,
  REMOTE_AUTH_BACKUP_MS,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  installMongoStoreSaveCompatibility,
  createMongoStore,
  createRemoteAuth
};
