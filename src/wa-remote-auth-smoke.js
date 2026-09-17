'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  Client
} = require('whatsapp-web.js');

const {
  REMOTE_AUTH_SESSION,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createMongoStore,
  createRemoteAuth
} = require('./remote-auth');

const uri =
  process.env.MONGODB_URI;

const dataPath =
  getRemoteAuthDataPath();

const EVENT_TIMEOUT_MS = 180000;

let client = null;
let finished = false;

let qrSeen = false;
let authenticated = false;
let ready = false;
let authFailure = false;
let disconnected = false;
let initializeResolved = false;
let initializeError = null;

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let count = 0;

  for (
    const entry of fs.readdirSync(
      dir,
      {
        withFileTypes: true
      }
    )
  ) {
    const fullPath =
      path.join(
        dir,
        entry.name
      );

    if (entry.isDirectory()) {
      count += countFiles(fullPath);
    }
    else if (entry.isFile()) {
      count++;
    }
  }

  return count;
}

function sanitizeError(value) {
  return String(value || '')
    .replace(
      /mongodb\+srv:\/\/[^@]+@/gi,
      '[MONGODB_URI_REDACTED]'
    );
}

async function finish(code) {
  if (finished) {
    return;
  }

  finished = true;

  try {
    if (client) {
      await client.destroy();

      console.log(
        'WHATSAPP_CLIENT_DESTROYED=YES'
      );
    }
  }
  catch (error) {
    console.log(
      `CLIENT_DESTROY_WARNING=${
        sanitizeError(
          error.message
        )
      }`
    );
  }

  try {
    await mongoose.disconnect();

    console.log(
      'MONGOOSE_DISCONNECTED=YES'
    );
  }
  catch (_) {}

  process.exit(code);
}

async function main() {
  if (!uri) {
    throw new Error(
      'MONGODB_URI_NOT_SET'
    );
  }

  console.log(
    '============================================================'
  );

  console.log(
    'WA AUTO ABSENSI REMOTEAUTH SMOKE V2'
  );

  console.log(
    'WAIT FOR READY EVENT'
  );

  console.log(
    'REMOTE SESSION RESTORE ONLY'
  );

  console.log(
    'QR MUST NOT APPEAR'
  );

  console.log(
    'MESSAGE SEND DISABLED'
  );

  console.log(
    '============================================================'
  );

  // ==========================================================
  // MongoDB
  // ==========================================================

  await mongoose.connect(
    uri,
    {
      dbName: 'wa_auto_absensi',
      serverSelectionTimeoutMS: 15000
    }
  );

  console.log(
    'MONGODB_CONNECTED=YES'
  );

  const store =
    createMongoStore(
      mongoose,
      dataPath
    );

  console.log(
    'MONGO_STORE_READY=YES'
  );

  const existsBefore =
    await store.sessionExists({
      session:
        REMOTE_AUTH_SESSION
    });

  console.log(
    `REMOTE_SESSION_EXISTS_BEFORE=${
      existsBefore ? 'YES' : 'NO'
    }`
  );

  if (!existsBefore) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=REMOTE_SESSION_MISSING'
    );

    return finish(20);
  }

  // ==========================================================
  // Client
  // ==========================================================

  client =
    new Client({
      authStrategy:
        createRemoteAuth(
          store,
          dataPath
        ),

      puppeteer:
        getPuppeteerOptions()
    });

  let settleOutcome = null;

  const outcomePromise =
    new Promise(resolve => {
      let settled = false;

      settleOutcome =
        outcome => {
          if (settled) {
            return;
          }

          settled = true;

          resolve(outcome);
        };
    });

  client.on(
    'qr',
    () => {
      qrSeen = true;

      console.log(
        'QR_RECEIVED_UNEXPECTED=YES'
      );

      console.log(
        'DO_NOT_SCAN_QR=YES'
      );

      settleOutcome('qr');
    }
  );

  client.on(
    'authenticated',
    () => {
      authenticated = true;

      console.log(
        'AUTHENTICATED=YES'
      );
    }
  );

  client.on(
    'ready',
    () => {
      ready = true;

      console.log(
        'WHATSAPP_READY=YES'
      );

      settleOutcome('ready');
    }
  );

  client.on(
    'auth_failure',
    message => {
      authFailure = true;

      console.log(
        'AUTH_FAILURE=YES'
      );

      console.log(
        `AUTH_FAILURE_MESSAGE=${
          sanitizeError(message)
        }`
      );

      settleOutcome(
        'auth_failure'
      );
    }
  );

  client.on(
    'disconnected',
    reason => {
      disconnected = true;

      console.log(
        `WHATSAPP_DISCONNECTED=${
          sanitizeError(reason)
        }`
      );

      if (!ready) {
        settleOutcome(
          'disconnected'
        );
      }
    }
  );

  // ==========================================================
  // Important:
  //
  // Do NOT assume initialize() resolution means READY.
  // Start initialization, then wait explicitly for one
  // terminal authentication event.
  // ==========================================================

  console.log(
    'CLIENT_INITIALIZE_START=YES'
  );

  const initializePromise =
    client.initialize()
      .then(() => {
        initializeResolved = true;

        console.log(
          'CLIENT_INITIALIZE_RESOLVED=YES'
        );
      })
      .catch(error => {
        initializeError = error;

        console.log(
          'CLIENT_INITIALIZE_ERROR=YES'
        );

        console.log(
          `CLIENT_INITIALIZE_ERROR_MESSAGE=${
            sanitizeError(
              error.message
            )
          }`
        );

        settleOutcome(
          'initialize_error'
        );
      });

  const timeoutPromise =
    new Promise(resolve => {
      setTimeout(
        () => resolve('timeout'),
        EVENT_TIMEOUT_MS
      );
    });

  const outcome =
    await Promise.race([
      outcomePromise,
      timeoutPromise
    ]);

  console.log(
    `CLIENT_EVENT_OUTCOME=${outcome}`
  );

  // Let closely-spaced events settle.
  await sleep(2000);

  // Do not leave rejected initialize promise unobserved.
  if (initializeResolved) {
    await initializePromise;
  }

  // ==========================================================
  // Verify remote + restored local state
  // ==========================================================

  const existsAfter =
    await store.sessionExists({
      session:
        REMOTE_AUTH_SESSION
    });

  const localProfilePath =
    path.resolve(
      dataPath,
      REMOTE_AUTH_SESSION
    );

  const localProfileFiles =
    countFiles(
      localProfilePath
    );

  console.log('');
  console.log(
    `INITIALIZE_RESOLVED_FINAL=${
      initializeResolved
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `INITIALIZE_ERROR_FINAL=${
      initializeError
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `QR_SEEN_FINAL=${
      qrSeen
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `AUTHENTICATED_FINAL=${
      authenticated
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `READY_FINAL=${
      ready
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `AUTH_FAILURE_FINAL=${
      authFailure
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `DISCONNECTED_FINAL=${
      disconnected
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `REMOTE_SESSION_EXISTS_AFTER=${
      existsAfter
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `LOCAL_RESTORED_PROFILE_FILES=${
      localProfileFiles
    }`
  );

  // ==========================================================
  // Strict guards
  // ==========================================================

  if (outcome === 'timeout') {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=READY_EVENT_TIMEOUT'
    );

    return finish(60);
  }

  if (qrSeen) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=QR_REQUIRED'
    );

    return finish(61);
  }

  if (initializeError) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=INITIALIZE_ERROR'
    );

    return finish(62);
  }

  if (authFailure) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=AUTH_FAILURE'
    );

    return finish(63);
  }

  if (!authenticated) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=NOT_AUTHENTICATED'
    );

    return finish(64);
  }

  if (!ready) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=NOT_READY'
    );

    return finish(65);
  }

  if (!existsAfter) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=REMOTE_SESSION_DISAPPEARED'
    );

    return finish(66);
  }

  if (localProfileFiles < 10) {
    console.log(
      'REMOTE_AUTH_SMOKE=FAIL'
    );

    console.log(
      'REASON=LOCAL_RESTORE_INCOMPLETE'
    );

    return finish(67);
  }

  // ==========================================================
  // PASS
  // ==========================================================

  console.log('');
  console.log(
    '============================================================'
  );

  console.log(
    'REMOTE_AUTH_SMOKE=PASS'
  );

  console.log(
    'EVENT_WAIT_LOGIC=PASS'
  );

  console.log(
    'REMOTE_SESSION_RESTORE=PASS'
  );

  console.log(
    'QR_REQUIRED=NO'
  );

  console.log(
    'AUTHENTICATION_FROM_REMOTE_SESSION=PASS'
  );

  console.log(
    'WHATSAPP_READY_FROM_REMOTE_SESSION=PASS'
  );

  console.log(
    'MESSAGE_SENT=NO'
  );

  console.log(
    'STEP_4_2E_V2_SMOKE=PASS'
  );

  console.log(
    '============================================================'
  );

  return finish(0);
}

process.on(
  'SIGINT',
  async () => {
    console.log(
      'SIGINT_RECEIVED=YES'
    );

    await finish(130);
  }
);

process.on(
  'unhandledRejection',
  async error => {
    console.log(
      'UNHANDLED_REJECTION=YES'
    );

    console.log(
      `ERROR=${
        sanitizeError(
          error &&
          error.message
        )
      }`
    );

    await finish(90);
  }
);

main().catch(
  async error => {
    console.log(
      'REMOTE_AUTH_SMOKE_ERROR=YES'
    );

    console.log(
      `ERROR_NAME=${
        sanitizeError(
          error.name
        )
      }`
    );

    console.log(
      `ERROR_MESSAGE=${
        sanitizeError(
          error.message
        )
      }`
    );

    await finish(1);
  }
);
