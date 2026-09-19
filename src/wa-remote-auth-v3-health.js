'use strict';

const mongoose = require('mongoose');

const {
  Client
} = require('whatsapp-web.js');

const {
  createRemoteAuthV3,
  getRemoteAuthDataPath,
  getPuppeteerOptions
} = require('./remote-auth-v3');

const MONGODB_URI =
  process.env.MONGODB_URI;

const DATA_PATH =
  getRemoteAuthDataPath();

const GLOBAL_TIMEOUT_MS =
  4 * 60 * 1000;

let client = null;
let finished = false;
let readyStarted = false;
let qrSeen = false;

async function finish(code) {
  if (finished) {
    return;
  }

  finished = true;

  try {
    if (client) {
      await client.destroy();

      console.log(
        'REMOTE_V3_HEALTH_CLIENT_DESTROYED=YES'
      );
    }
  } catch (_) {}

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
    'WA AUTO ABSENSI - REMOTEAUTH V3 HEALTH'
  );

  console.log(
    'RESTORE ONLY - NO WHATSAPP SEND'
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

  await store.verifyActiveSnapshot();

  console.log(
    'REMOTE_V3_PRE_INITIALIZE_ACTIVE=PASS'
  );

  client =
    new Client({
      authStrategy,
      puppeteer:
        getPuppeteerOptions()
    });

  client.on(
    'qr',
    async () => {
      qrSeen = true;

      console.log(
        'REMOTE_V3_HEALTH_QR_REQUIRED=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(20);
    }
  );

  client.on(
    'auth_failure',
    async message => {
      console.log(
        'REMOTE_V3_HEALTH_AUTH_FAILURE=YES'
      );

      console.log(
        \`REMOTE_V3_HEALTH_AUTH_FAILURE_MESSAGE=\${message}\`
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(21);
    }
  );

  client.on(
    'ready',
    async () => {
      if (readyStarted) {
        return;
      }

      readyStarted = true;

      console.log(
        'REMOTE_V3_HEALTH_WHATSAPP_READY=YES'
      );

      try {
        await store.verifyActiveSnapshot();

        console.log(
          'REMOTE_V3_POST_READY_ACTIVE=PASS'
        );

        console.log(
          \`REMOTE_V3_HEALTH_QR_SEEN=\${qrSeen ? 'YES' : 'NO'}\`
        );

        if (qrSeen) {
          throw new Error(
            'REMOTE_V3_HEALTH_UNEXPECTED_QR'
          );
        }

        console.log(
          'REMOTE_V3_HEALTH=PASS'
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        await finish(0);
      } catch (error) {
        console.log(
          'REMOTE_V3_HEALTH=FAIL'
        );

        console.log(
          \`REMOTE_V3_HEALTH_ERROR=\${error.message}\`
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        await finish(22);
      }
    }
  );

  console.log(
    'REMOTE_V3_HEALTH_INITIALIZE_START=YES'
  );

  await client.initialize();

  console.log(
    'REMOTE_V3_HEALTH_INITIALIZE_RESOLVED=YES'
  );
}

const timer =
  setTimeout(
    async () => {
      console.log(
        'REMOTE_V3_HEALTH_TIMEOUT=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(30);
    },
    GLOBAL_TIMEOUT_MS
  );

main()
  .catch(
    async error => {
      console.log(
        'REMOTE_V3_HEALTH_STARTUP_ERROR=YES'
      );

      console.log(
        \`REMOTE_V3_HEALTH_STARTUP_ERROR_MESSAGE=\${error.message}\`
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(1);
    }
  )
  .finally(
    () => {
      if (finished) {
        clearTimeout(timer);
      }
    }
  );
