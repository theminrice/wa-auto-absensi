'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const unzipper = require('unzipper');

const {
  RemoteAuth
} = require('whatsapp-web.js');

const {
  createMongoStore,
  getRemoteAuthDataPath,
  getPuppeteerOptions
} = require('./remote-auth');

const REMOTE_AUTH_V3_CLIENT_ID =
  'wa-auto-absensi-remote-v3';

const REMOTE_AUTH_V3_ACTIVE_SESSION =
  `RemoteAuth-${REMOTE_AUTH_V3_CLIENT_ID}`;

const REMOTE_AUTH_V3_CANDIDATE_SESSION =
  `${REMOTE_AUTH_V3_ACTIVE_SESSION}-candidate`;

const REMOTE_AUTH_V3_LAST_GOOD_SESSION =
  `${REMOTE_AUTH_V3_ACTIVE_SESSION}-last-good`;

const REMOTE_AUTH_V3_BACKUP_MS = 60000;

function safeLabel(value) {
  return String(value || 'UNKNOWN')
    .replace(/[^A-Za-z0-9_.-]/g, '_');
}

function sha256File(filePath) {
  const hash =
    crypto.createHash('sha256');

  const bytes =
    fs.readFileSync(filePath);

  hash.update(bytes);

  return hash.digest('hex');
}

async function validateZipFile(
  zipPath,
  label
) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(
      `REMOTE_V3_ZIP_MISSING_${safeLabel(label)}`
    );
  }

  const size =
    fs.statSync(zipPath).size;

  if (size < 1000) {
    throw new Error(
      `REMOTE_V3_ZIP_TOO_SMALL_${safeLabel(label)}_${size}`
    );
  }

  const directory =
    await unzipper.Open.file(
      zipPath
    );

  if (
    !directory ||
    !Array.isArray(directory.files) ||
    directory.files.length === 0
  ) {
    throw new Error(
      `REMOTE_V3_ZIP_EMPTY_${safeLabel(label)}`
    );
  }

  let inflatedBytes = 0;

  for (const entry of directory.files) {
    if (
      entry.type === 'File'
    ) {
      const buffer =
        await entry.buffer();

      inflatedBytes +=
        buffer.length;
    }
  }

  if (inflatedBytes === 0) {
    throw new Error(
      `REMOTE_V3_ZIP_NO_FILE_BYTES_${safeLabel(label)}`
    );
  }

  const sha256 =
    sha256File(zipPath);

  console.log(
    `REMOTE_V3_ZIP_VALIDATION=${safeLabel(label)}:PASS`
  );

  console.log(
    `REMOTE_V3_ZIP_SIZE_${safeLabel(label)}=${size}`
  );

  console.log(
    `REMOTE_V3_ZIP_ENTRIES_${safeLabel(label)}=${directory.files.length}`
  );

  console.log(
    `REMOTE_V3_ZIP_INFLATED_BYTES_${safeLabel(label)}=${inflatedBytes}`
  );

  console.log(
    `REMOTE_V3_ZIP_SHA256_${safeLabel(label)}=${sha256}`
  );

  return {
    size,
    entryCount:
      directory.files.length,
    inflatedBytes,
    sha256
  };
}

function sessionZipPath(
  dataPath,
  session
) {
  return path.resolve(
    dataPath,
    `${session}.zip`
  );
}

async function rmFile(filePath) {
  try {
    await fs.promises.rm(
      filePath,
      {
        force: true
      }
    );
  } catch (_) {}
}

async function createTempZipPath(
  prefix
) {
  const dir =
    await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        `${safeLabel(prefix)}-`
      )
    );

  return {
    dir,
    zipPath:
      path.join(
        dir,
        'snapshot.zip'
      )
  };
}

async function rmTemp(temp) {
  if (
    temp &&
    temp.dir
  ) {
    try {
      await fs.promises.rm(
        temp.dir,
        {
          recursive: true,
          force: true,
          maxRetries: 3
        }
      );
    } catch (_) {}
  }
}

function createHardenedRemoteAuthV3Store(
  mongoose,
  dataPath = getRemoteAuthDataPath()
) {
  const resolvedDataPath =
    path.resolve(dataPath);

  const baseStore =
    createMongoStore(
      mongoose,
      resolvedDataPath
    );

  const original = {
    save:
      baseStore.save.bind(baseStore),
    extract:
      baseStore.extract.bind(baseStore),
    sessionExists:
      baseStore.sessionExists.bind(baseStore),
    delete:
      baseStore.delete.bind(baseStore)
  };

  let saveQueue =
    Promise.resolve();

  async function snapshotExists(
    session
  ) {
    return Boolean(
      await original.sessionExists({
        session
      })
    );
  }

  async function verifyStoredSnapshot(
    session,
    label
  ) {
    const temp =
      await createTempZipPath(
        `remote-v3-verify-${label}`
      );

    try {
      await original.extract({
        session,
        path:
          temp.zipPath
      });

      const validation =
        await validateZipFile(
          temp.zipPath,
          label
        );

      return {
        temp,
        zipPath:
          temp.zipPath,
        validation
      };
    } catch (error) {
      await rmTemp(temp);
      throw error;
    }
  }

  async function saveZipAsSession(
    sourceZip,
    targetSession,
    label
  ) {
    await validateZipFile(
      sourceZip,
      `${label}_SOURCE`
    );

    const targetLocalZip =
      sessionZipPath(
        resolvedDataPath,
        targetSession
      );

    await fs.promises.mkdir(
      resolvedDataPath,
      {
        recursive: true
      }
    );

    await fs.promises.copyFile(
      sourceZip,
      targetLocalZip
    );

    try {
      await original.save({
        session:
          targetSession
      });
    } finally {
      await rmFile(
        targetLocalZip
      );
    }

    const verified =
      await verifyStoredSnapshot(
        targetSession,
        `${label}_ROUNDTRIP`
      );

    console.log(
      `REMOTE_V3_STORE_SAVE_${safeLabel(label)}=PASS`
    );

    return verified;
  }

  async function preserveActiveAsLastGood() {
    const activeExists =
      await snapshotExists(
        REMOTE_AUTH_V3_ACTIVE_SESSION
      );

    if (!activeExists) {
      console.log(
        'REMOTE_V3_LAST_GOOD_REFRESH=SKIPPED_NO_ACTIVE'
      );

      return false;
    }

    let activeSnapshot = null;

    try {
      activeSnapshot =
        await verifyStoredSnapshot(
          REMOTE_AUTH_V3_ACTIVE_SESSION,
          'ACTIVE_BEFORE_PROMOTION'
        );

      const lastGood =
        await saveZipAsSession(
          activeSnapshot.zipPath,
          REMOTE_AUTH_V3_LAST_GOOD_SESSION,
          'LAST_GOOD_REFRESH'
        );

      await rmTemp(
        lastGood.temp
      );

      console.log(
        'REMOTE_V3_LAST_GOOD_REFRESH=PASS'
      );

      return true;
    } catch (error) {
      console.log(
        'REMOTE_V3_LAST_GOOD_REFRESH=SKIPPED_ACTIVE_INVALID'
      );

      console.log(
        `REMOTE_V3_LAST_GOOD_REFRESH_ERROR=${error.message}`
      );

      return false;
    } finally {
      if (activeSnapshot) {
        await rmTemp(
          activeSnapshot.temp
        );
      }
    }
  }

  async function rollbackActiveFromLastGood() {
    const lastGoodExists =
      await snapshotExists(
        REMOTE_AUTH_V3_LAST_GOOD_SESSION
      );

    if (!lastGoodExists) {
      console.log(
        'REMOTE_V3_ACTIVE_ROLLBACK=UNAVAILABLE'
      );

      return false;
    }

    let lastGood = null;

    try {
      lastGood =
        await verifyStoredSnapshot(
          REMOTE_AUTH_V3_LAST_GOOD_SESSION,
          'LAST_GOOD_FOR_ROLLBACK'
        );

      const restored =
        await saveZipAsSession(
          lastGood.zipPath,
          REMOTE_AUTH_V3_ACTIVE_SESSION,
          'ACTIVE_ROLLBACK'
        );

      await rmTemp(
        restored.temp
      );

      console.log(
        'REMOTE_V3_ACTIVE_ROLLBACK=PASS'
      );

      return true;
    } catch (error) {
      console.log(
        'REMOTE_V3_ACTIVE_ROLLBACK=FAIL'
      );

      console.log(
        `REMOTE_V3_ACTIVE_ROLLBACK_ERROR=${error.message}`
      );

      return false;
    } finally {
      if (lastGood) {
        await rmTemp(
          lastGood.temp
        );
      }
    }
  }

  async function hardenedSave(options) {
    if (
      !options ||
      options.session !==
        REMOTE_AUTH_V3_ACTIVE_SESSION
    ) {
      return original.save(
        options
      );
    }

    const sourceZip =
      sessionZipPath(
        resolvedDataPath,
        REMOTE_AUTH_V3_ACTIVE_SESSION
      );

    console.log(
      'REMOTE_V3_SAVE_PIPELINE_START=YES'
    );

    await validateZipFile(
      sourceZip,
      'LOCAL_ACTIVE_CANDIDATE'
    );

    let candidate = null;

    try {
      candidate =
        await saveZipAsSession(
          sourceZip,
          REMOTE_AUTH_V3_CANDIDATE_SESSION,
          'CANDIDATE'
        );

      console.log(
        'REMOTE_V3_CANDIDATE_ROUNDTRIP=PASS'
      );

      await preserveActiveAsLastGood();

      try {
        const promoted =
          await saveZipAsSession(
            candidate.zipPath,
            REMOTE_AUTH_V3_ACTIVE_SESSION,
            'ACTIVE_PROMOTION'
          );

        await rmTemp(
          promoted.temp
        );

        console.log(
          'REMOTE_V3_ACTIVE_PROMOTION=PASS'
        );
      } catch (promotionError) {
        console.log(
          'REMOTE_V3_ACTIVE_PROMOTION=FAIL'
        );

        console.log(
          `REMOTE_V3_ACTIVE_PROMOTION_ERROR=${promotionError.message}`
        );

        const rolledBack =
          await rollbackActiveFromLastGood();

        if (!rolledBack) {
          throw new Error(
            `REMOTE_V3_PROMOTION_AND_ROLLBACK_FAILED_${promotionError.message}`
          );
        }

        throw promotionError;
      }

      try {
        if (
          await snapshotExists(
            REMOTE_AUTH_V3_CANDIDATE_SESSION
          )
        ) {
          await original.delete({
            session:
              REMOTE_AUTH_V3_CANDIDATE_SESSION
          });
        }

        console.log(
          'REMOTE_V3_CANDIDATE_CLEANUP=PASS'
        );
      } catch (error) {
        console.log(
          'REMOTE_V3_CANDIDATE_CLEANUP=BEST_EFFORT_FAIL'
        );

        console.log(
          `REMOTE_V3_CANDIDATE_CLEANUP_ERROR=${error.message}`
        );
      }

      console.log(
        'REMOTE_V3_SAVE_PIPELINE=PASS'
      );
    } finally {
      if (candidate) {
        await rmTemp(
          candidate.temp
        );
      }
    }
  }

  baseStore.save =
    function queuedHardenedSave(
      options
    ) {
      const operation =
        saveQueue.then(
          () =>
            hardenedSave(
              options
            )
        );

      saveQueue =
        operation.catch(
          () => undefined
        );

      return operation;
    };

  baseStore.extract =
    async function hardenedExtract(
      options
    ) {
      if (
        !options ||
        options.session !==
          REMOTE_AUTH_V3_ACTIVE_SESSION
      ) {
        return original.extract(
          options
        );
      }

      const targetPath =
        path.resolve(
          options.path
        );

      try {
        await original.extract({
          session:
            REMOTE_AUTH_V3_ACTIVE_SESSION,
          path:
            targetPath
        });

        await validateZipFile(
          targetPath,
          'ACTIVE_RESTORE'
        );

        console.log(
          'REMOTE_V3_ACTIVE_RESTORE=PASS'
        );

        console.log(
          'REMOTE_V3_FALLBACK_USED=NO'
        );

        return;
      } catch (activeError) {
        console.log(
          'REMOTE_V3_ACTIVE_RESTORE=FAIL'
        );

        console.log(
          `REMOTE_V3_ACTIVE_RESTORE_ERROR=${activeError.message}`
        );

        await rmFile(
          targetPath
        );
      }

      const lastGoodExists =
        await snapshotExists(
          REMOTE_AUTH_V3_LAST_GOOD_SESSION
        );

      if (!lastGoodExists) {
        console.log(
          'REMOTE_V3_LAST_GOOD_RESTORE=UNAVAILABLE'
        );

        throw new Error(
          'REMOTE_V3_ACTIVE_INVALID_AND_LAST_GOOD_MISSING'
        );
      }

      await original.extract({
        session:
          REMOTE_AUTH_V3_LAST_GOOD_SESSION,
        path:
          targetPath
      });

      await validateZipFile(
        targetPath,
        'LAST_GOOD_RESTORE'
      );

      console.log(
        'REMOTE_V3_LAST_GOOD_RESTORE=PASS'
      );

      console.log(
        'REMOTE_V3_FALLBACK_USED=YES'
      );

      try {
        const healed =
          await saveZipAsSession(
            targetPath,
            REMOTE_AUTH_V3_ACTIVE_SESSION,
            'ACTIVE_SELF_HEAL'
          );

        await rmTemp(
          healed.temp
        );

        console.log(
          'REMOTE_V3_ACTIVE_SELF_HEAL=PASS'
        );
      } catch (error) {
        console.log(
          'REMOTE_V3_ACTIVE_SELF_HEAL=BEST_EFFORT_FAIL'
        );

        console.log(
          `REMOTE_V3_ACTIVE_SELF_HEAL_ERROR=${error.message}`
        );
      }
    };

  baseStore.sessionExists =
    async function hardenedSessionExists(
      options
    ) {
      if (
        !options ||
        options.session !==
          REMOTE_AUTH_V3_ACTIVE_SESSION
      ) {
        return original.sessionExists(
          options
        );
      }

      const activeExists =
        await snapshotExists(
          REMOTE_AUTH_V3_ACTIVE_SESSION
        );

      if (activeExists) {
        return true;
      }

      const lastGoodExists =
        await snapshotExists(
          REMOTE_AUTH_V3_LAST_GOOD_SESSION
        );

      if (lastGoodExists) {
        console.log(
          'REMOTE_V3_SESSION_EXISTS_VIA_LAST_GOOD=YES'
        );
      }

      return lastGoodExists;
    };

  baseStore.delete =
    async function hardenedDelete(
      options
    ) {
      if (
        !options ||
        options.session !==
          REMOTE_AUTH_V3_ACTIVE_SESSION
      ) {
        return original.delete(
          options
        );
      }

      const snapshots = [
        REMOTE_AUTH_V3_ACTIVE_SESSION,
        REMOTE_AUTH_V3_CANDIDATE_SESSION,
        REMOTE_AUTH_V3_LAST_GOOD_SESSION
      ];

      for (const session of snapshots) {
        try {
          if (
            await snapshotExists(
              session
            )
          ) {
            await original.delete({
              session
            });
          }
        } catch (error) {
          console.log(
            `REMOTE_V3_DELETE_BEST_EFFORT_FAIL_${safeLabel(session)}=${error.message}`
          );
        }
      }
    };

  baseStore.seedLastGoodFromActive =
    async function seedLastGoodFromActive() {
      const active =
        await verifyStoredSnapshot(
          REMOTE_AUTH_V3_ACTIVE_SESSION,
          'ACTIVE_FOR_LAST_GOOD_SEED'
        );

      try {
        const seeded =
          await saveZipAsSession(
            active.zipPath,
            REMOTE_AUTH_V3_LAST_GOOD_SESSION,
            'LAST_GOOD_SEED'
          );

        await rmTemp(
          seeded.temp
        );

        console.log(
          'REMOTE_V3_LAST_GOOD_SEED=PASS'
        );

        return true;
      } finally {
        await rmTemp(
          active.temp
        );
      }
    };

  baseStore.verifyActiveSnapshot =
    async function verifyActiveSnapshot() {
      const activeExists =
        await snapshotExists(
          REMOTE_AUTH_V3_ACTIVE_SESSION
        );

      const lastGoodExists =
        await snapshotExists(
          REMOTE_AUTH_V3_LAST_GOOD_SESSION
        );

      console.log(
        `REMOTE_V3_ACTIVE_EXISTS=${activeExists ? 'YES' : 'NO'}`
      );

      console.log(
        `REMOTE_V3_LAST_GOOD_EXISTS=${lastGoodExists ? 'YES' : 'NO'}`
      );

      if (!activeExists) {
        throw new Error(
          'REMOTE_V3_ACTIVE_NOT_FOUND'
        );
      }

      const verified =
        await verifyStoredSnapshot(
          REMOTE_AUTH_V3_ACTIVE_SESSION,
          'ACTIVE_PROBE'
        );

      await rmTemp(
        verified.temp
      );

      console.log(
        'REMOTE_V3_ACTIVE_PROBE=PASS'
      );

      return true;
    };

  return baseStore;
}

function createRemoteAuthV3(
  mongoose,
  dataPath = getRemoteAuthDataPath()
) {
  const store =
    createHardenedRemoteAuthV3Store(
      mongoose,
      dataPath
    );

  const authStrategy =
    new RemoteAuth({
      clientId:
        REMOTE_AUTH_V3_CLIENT_ID,
      dataPath:
        path.resolve(dataPath),
      store,
      backupSyncIntervalMs:
        REMOTE_AUTH_V3_BACKUP_MS
    });

  return {
    store,
    authStrategy
  };
}

module.exports = {
  REMOTE_AUTH_V3_CLIENT_ID,
  REMOTE_AUTH_V3_ACTIVE_SESSION,
  REMOTE_AUTH_V3_CANDIDATE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION,
  REMOTE_AUTH_V3_BACKUP_MS,
  validateZipFile,
  createHardenedRemoteAuthV3Store,
  createRemoteAuthV3,
  getRemoteAuthDataPath,
  getPuppeteerOptions
};
