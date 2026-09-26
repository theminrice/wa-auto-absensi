'use strict';

// WA_TESTING_CHECKIN_HISTORY_READONLY_AUDIT_V1
// Reads recent messages from the exact Testing group using the existing
// RemoteAuth V3 ACTIVE session. No WhatsApp send and no MongoDB write.

const crypto = require('crypto');
const mongoose = require('mongoose');

const {
  Client,
  RemoteAuth
} = require('whatsapp-web.js');

const {
  createMongoStore,
  getRemoteAuthDataPath,
  getPuppeteerOptions
} = require('./remote-auth');

const {
  REMOTE_AUTH_V3_CLIENT_ID,
  REMOTE_AUTH_V3_ACTIVE_SESSION
} = require('./remote-auth-v3');

const MONGODB_URI = process.env.MONGODB_URI;
const DATA_PATH = getRemoteAuthDataPath();
const EXPECTED_GROUP_NAME = 'Testing';
const FETCH_LIMIT = 100;
const READY_TIMEOUT_MS = 180000;

const EXPECTED_FIRST_TIMESTAMP = 1790393005;
const EXPECTED_SECOND_TIMESTAMP = 1790393806;
const CHECKIN_FIRST_LINE =
  'Check In, Sabtu 26 September 2026';

let client = null;
let finished = false;

function hashText(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function safeLine(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/, 1)[0]
    .trim();
}

function wib(timestamp) {
  if (!Number.isFinite(Number(timestamp))) {
    return 'UNKNOWN';
  }

  return new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }
  )
    .format(
      new Date(Number(timestamp) * 1000)
    )
    .replace(',', '');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(
          new Error(label + '_TIMEOUT')
        ),
        ms
      );
    })
  ]);
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
        'HISTORY_AUDIT_CLIENT_DESTROYED=YES'
      );
    }
  } catch (error) {
    console.log(
      'HISTORY_AUDIT_CLIENT_DESTROY_ERROR=' +
        safeLine(error && error.message)
    );
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log(
        'HISTORY_AUDIT_MONGODB_DISCONNECTED=YES'
      );
    }
  } catch (_) {}

  process.exitCode = code;
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
    'WA TESTING CHECKIN HISTORY READONLY AUDIT V1'
  );
  console.log(
    'NO SEND / NO MONGODB WRITE / REMOTEAUTH SAVE BLOCKED'
  );
  console.log(
    '============================================================'
  );

  console.log(
    'HISTORY_AUDIT_WHATSAPP_SEND=NO'
  );
  console.log(
    'HISTORY_AUDIT_MONGODB_WRITE=NO'
  );
  console.log(
    'HISTORY_AUDIT_REMOTEAUTH_SAVE=BLOCKED'
  );
  console.log(
    'HISTORY_AUDIT_REMOTEAUTH_DELETE=BLOCKED'
  );

  await mongoose.connect(
    MONGODB_URI,
    {
      dbName: 'wa_auto_absensi',
      serverSelectionTimeoutMS: 30000
    }
  );

  console.log(
    'HISTORY_AUDIT_MONGODB_CONNECTED=YES'
  );

  const baseStore =
    createMongoStore(
      mongoose,
      DATA_PATH
    );

  const activeExists =
    await baseStore.sessionExists({
      session:
        REMOTE_AUTH_V3_ACTIVE_SESSION
    });

  console.log(
    'HISTORY_AUDIT_ACTIVE_EXISTS=' +
      (activeExists ? 'YES' : 'NO')
  );

  if (!activeExists) {
    throw new Error(
      'ACTIVE_SESSION_MISSING'
    );
  }

  const readOnlyStore = {
    sessionExists: options =>
      baseStore.sessionExists(options),

    extract: options =>
      baseStore.extract(options),

    save: async () => {
      console.log(
        'HISTORY_AUDIT_STORE_SAVE_BLOCKED=YES'
      );
    },

    delete: async () => {
      console.log(
        'HISTORY_AUDIT_STORE_DELETE_BLOCKED=YES'
      );
    }
  };

  const authStrategy =
    new RemoteAuth({
      clientId:
        REMOTE_AUTH_V3_CLIENT_ID,
      dataPath:
        DATA_PATH,
      store:
        readOnlyStore,
      backupSyncIntervalMs:
        60000
    });

  client =
    new Client({
      authStrategy,
      puppeteer:
        getPuppeteerOptions()
    });

  client.on(
    'qr',
    async () => {
      console.log(
        'HISTORY_AUDIT_QR_REQUIRED=YES'
      );
      await finish(20);
    }
  );

  client.on(
    'auth_failure',
    async message => {
      console.log(
        'HISTORY_AUDIT_AUTH_FAILURE=YES'
      );
      console.log(
        'HISTORY_AUDIT_AUTH_FAILURE_MESSAGE=' +
          safeLine(message)
      );
      await finish(21);
    }
  );

  const readyPromise =
    new Promise((resolve, reject) => {
      client.once(
        'ready',
        resolve
      );

      client.once(
        'disconnected',
        reason => reject(
          new Error(
            'WHATSAPP_DISCONNECTED_' +
              safeLine(reason)
          )
        )
      );
    });

  console.log(
    'HISTORY_AUDIT_INITIALIZE_START=YES'
  );

  await client.initialize();

  console.log(
    'HISTORY_AUDIT_INITIALIZE_RESOLVED=YES'
  );

  await withTimeout(
    readyPromise,
    READY_TIMEOUT_MS,
    'WHATSAPP_READY'
  );

  console.log(
    'HISTORY_AUDIT_WHATSAPP_READY=YES'
  );

  const chats =
    await withTimeout(
      client.getChats(),
      60000,
      'GET_CHATS'
    );

  const matches =
    chats.filter(
      chat =>
        chat &&
        chat.isGroup === true &&
        String(chat.name || '')
          .trim()
          .toLowerCase() ===
        EXPECTED_GROUP_NAME.toLowerCase()
    );

  console.log(
    'HISTORY_AUDIT_TESTING_MATCH_COUNT=' +
      matches.length
  );

  if (matches.length !== 1) {
    throw new Error(
      'TESTING_GROUP_MATCH_COUNT_' +
        matches.length
    );
  }

  const chat =
    matches[0];

  console.log(
    'HISTORY_AUDIT_TARGET_NAME=Testing'
  );
  console.log(
    'HISTORY_AUDIT_TARGET_SAFE=YES'
  );

  const messages =
    await withTimeout(
      chat.fetchMessages({
        limit:
          FETCH_LIMIT,
        fromMe:
          true
      }),
      90000,
      'FETCH_MESSAGES'
    );

  console.log(
    'HISTORY_AUDIT_FETCHED_FROM_ME=' +
      messages.length
  );

  const checkins =
    messages
      .filter(
        message =>
          firstLine(message.body) ===
            CHECKIN_FIRST_LINE
      )
      .sort(
        (a, b) =>
          Number(a.timestamp || 0) -
          Number(b.timestamp || 0)
      );

  console.log(
    'HISTORY_AUDIT_CHECKIN_MATCH_COUNT=' +
      checkins.length
  );

  const uniqueIds =
    new Set();

  checkins.forEach(
    (message, index) => {
      const serialized =
        message &&
        message.id &&
        message.id._serialized
          ? message.id._serialized
          : '';

      const body =
        String(message.body || '');

      if (serialized) {
        uniqueIds.add(serialized);
      }

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_TIMESTAMP=' +
          Number(message.timestamp || 0)
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_WIB=' +
          wib(message.timestamp)
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_ACK=' +
          String(
            message.ack === undefined
              ? 'UNKNOWN'
              : message.ack
          )
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_TYPE=' +
          safeLine(message.type)
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_ID_HASH=' +
          hashText(serialized)
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_BODY_HASH=' +
          hashText(body)
      );

      console.log(
        'HISTORY_AUDIT_MATCH_' +
          (index + 1) +
          '_BODY_LENGTH=' +
          Buffer.byteLength(
            body,
            'utf8'
          )
      );
    }
  );

  const firstFound =
    checkins.some(
      message =>
        Number(message.timestamp) ===
          EXPECTED_FIRST_TIMESTAMP
    );

  const secondFound =
    checkins.some(
      message =>
        Number(message.timestamp) ===
          EXPECTED_SECOND_TIMESTAMP
    );

  console.log(
    'HISTORY_AUDIT_EXPECTED_FIRST_TIMESTAMP=' +
      EXPECTED_FIRST_TIMESTAMP
  );
  console.log(
    'HISTORY_AUDIT_EXPECTED_FIRST_FOUND=' +
      (firstFound ? 'YES' : 'NO')
  );

  console.log(
    'HISTORY_AUDIT_EXPECTED_SECOND_TIMESTAMP=' +
      EXPECTED_SECOND_TIMESTAMP
  );
  console.log(
    'HISTORY_AUDIT_EXPECTED_SECOND_FOUND=' +
      (secondFound ? 'YES' : 'NO')
  );

  console.log(
    'HISTORY_AUDIT_UNIQUE_MESSAGE_IDS=' +
      uniqueIds.size
  );

  if (
    firstFound &&
    secondFound &&
    uniqueIds.size >= 2
  ) {
    console.log(
      'HISTORY_AUDIT_RESULT=BOTH_MESSAGES_PRESENT'
    );
  } else if (
    firstFound &&
    !secondFound
  ) {
    console.log(
      'HISTORY_AUDIT_RESULT=SECOND_MESSAGE_NOT_PRESENT'
    );
  } else {
    console.log(
      'HISTORY_AUDIT_RESULT=INCONCLUSIVE'
    );
  }

  await finish(0);
}

main()
  .catch(
    async error => {
      console.log(
        'HISTORY_AUDIT_FATAL=' +
          safeLine(
            error &&
            error.message
          )
      );

      await finish(1);
    }
  );
