'use strict';

const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');

const {
  Client
} = require('whatsapp-web.js');

const {
  REMOTE_AUTH_V3_ACTIVE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION,
  createRemoteAuthV3,
  getRemoteAuthDataPath,
  getPuppeteerOptions
} = require('./remote-auth-v3');

const MONGODB_URI =
  process.env.MONGODB_URI;

const DATA_PATH =
  getRemoteAuthDataPath();

const GLOBAL_TIMEOUT_MS =
  10 * 60 * 1000;

const VERIFY_ATTEMPTS = 48;
const VERIFY_WAIT_MS = 5000;

let client = null;
let finished = false;
let readyStarted = false;
let savedEventSeen = false;

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

async function safeFinish(code) {
  if (finished) {
    return;
  }

  finished = true;

  try {
    if (client) {
      await client.destroy();

      console.log(
        'REMOTE_V3_CLIENT_DESTROYED=YES'
      );
    }
  } catch (error) {
    console.log(
      'REMOTE_V3_CLIENT_DESTROY_ERROR=YES'
    );
  }

  try {
    if (
      mongoose.connection.readyState !== 0
    ) {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    }
  } catch (_) {}

  setTimeout(
    () => process.exit(code),
    500
  );
}

async function waitForVerifiedActive(
  store
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= VERIFY_ATTEMPTS;
    attempt += 1
  ) {
    console.log(
      \`REMOTE_V3_ACTIVE_VERIFY_ATTEMPT=\${attempt}\`
    );

    try {
      await store.verifyActiveSnapshot();

      console.log(
        'REMOTE_V3_ACTIVE_ROUNDTRIP=PASS'
      );

      return true;
    } catch (error) {
      lastError = error;

      console.log(
        \`REMOTE_V3_ACTIVE_VERIFY_WAIT_ERROR=\${error.message}\`
      );
    }

    if (
      attempt < VERIFY_ATTEMPTS
    ) {
      await sleep(
        VERIFY_WAIT_MS
      );
    }
  }

  throw (
    lastError ||
    new Error(
      'REMOTE_V3_ACTIVE_VERIFY_TIMEOUT'
    )
  );
}

async function main() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI_MISSING'
    );
  }

  console.log(
    '============================================================'
  );

  console.log(
    'WA AUTO ABSENSI - REMOTEAUTH V3 HARDENED BOOTSTRAP'
  );

  console.log(
    'NO WHATSAPP MESSAGE WILL BE SENT'
  );

  console.log(
    'V2 SESSION WILL NOT BE DELETED'
  );

  console.log(
    '============================================================'
  );

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
    'MONGODB_CONNECTED=YES'
  );

  const {
    store,
    authStrategy
  } =
    createRemoteAuthV3(
      mongoose,
      DATA_PATH
    );

  const activeBefore =
    await store.sessionExists({
      session:
        REMOTE_AUTH_V3_ACTIVE_SESSION
    });

  const lastGoodBefore =
    await store.sessionExists({
      session:
        REMOTE_AUTH_V3_LAST_GOOD_SESSION
    });

  console.log(
    \`REMOTE_V3_SESSION_EXISTS_BEFORE=\${activeBefore ? 'YES' : 'NO'}\`
  );

  console.log(
    \`REMOTE_V3_LAST_GOOD_EXISTS_BEFORE=\${lastGoodBefore ? 'YES' : 'NO'}\`
  );

  client =
    new Client({
      authStrategy,
      puppeteer:
        getPuppeteerOptions()
    });

  client.on(
    'qr',
    qr => {
      console.log('');
      console.log(
        '========================================'
      );
      console.log(
        'REMOTE_V3_QR_REQUIRED=YES'
      );
      console.log(
        'SCAN FROM WHATSAPP > LINKED DEVICES'
      );
      console.log(
        'NO MESSAGE WILL BE SENT'
      );
      console.log(
        '========================================'
      );

      qrcode.generate(
        qr,
        {
          small: true
        }
      );

      console.log(
        '========================================'
      );
      console.log('');
    }
  );

  client.on(
    'authenticated',
    () => {
      console.log(
        'REMOTE_V3_AUTHENTICATED=YES'
      );
    }
  );

  client.on(
    'auth_failure',
    async message => {
      console.log(
        'REMOTE_V3_AUTH_FAILURE=YES'
      );

      console.log(
        \`REMOTE_V3_AUTH_FAILURE_MESSAGE=\${message}\`
      );

      await safeFinish(20);
    }
  );

  client.on(
    'remote_session_saved',
    () => {
      savedEventSeen = true;

      console.log(
        'REMOTE_V3_SESSION_SAVED_EVENT=YES'
      );
    }
  );

  client.on(
    'ready',
    async () => {
      if (readyStarted) {
        console.log(
          'REMOTE_V3_READY_REENTRY_IGNORED=YES'
        );

        return;
      }

      readyStarted = true;

      console.log(
        'REMOTE_V3_WHATSAPP_READY=YES'
      );

      try {
        await waitForVerifiedActive(
          store
        );

        console.log(
          \`REMOTE_V3_SESSION_SAVED_EVENT_SEEN=\${savedEventSeen ? 'YES' : 'NO'}\`
        );

        console.log(
          'REMOTE_V3_BOOTSTRAP=PASS'
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        await safeFinish(0);
      } catch (error) {
        console.log(
          'REMOTE_V3_BOOTSTRAP_VERIFY=FAIL'
        );

        console.log(
          \`REMOTE_V3_BOOTSTRAP_VERIFY_ERROR=\${error.message}\`
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        await safeFinish(21);
      }
    }
  );

  console.log(
    'REMOTE_V3_INITIALIZE_START=YES'
  );

  await client.initialize();

  console.log(
    'REMOTE_V3_INITIALIZE_RESOLVED=YES'
  );
}

const timer =
  setTimeout(
    async () => {
      console.log(
        'REMOTE_V3_BOOTSTRAP_TIMEOUT=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await safeFinish(30);
    },
    GLOBAL_TIMEOUT_MS
  );

main()
  .catch(
    async error => {
      console.log(
        'REMOTE_V3_BOOTSTRAP_ERROR=YES'
      );

      console.log(
        \`REMOTE_V3_BOOTSTRAP_ERROR_MESSAGE=\${error.message}\`
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await safeFinish(1);
    }
  )
  .finally(
    () => {
      if (finished) {
        clearTimeout(timer);
      }
    }
  );
