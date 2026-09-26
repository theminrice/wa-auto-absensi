'use strict';

// WA_REMOTEAUTH_V3_STARTUP_STATE_DIAGNOSTIC_V1
// READ ONLY against MongoDB: restore existing V3 session only.
// No WhatsApp messages, no RemoteAuth save/delete, no attendance reads/writes.

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
const HARD_TIMEOUT_MS = 120000;
const POLL_MS = 5000;

function safeError(error) {
  return String(error && error.message || error || 'UNKNOWN')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pageState(client) {
  if (!client || !client.pupPage) {
    return {
      page: 'UNAVAILABLE'
    };
  }

  try {
    return await client.pupPage.evaluate(() => {
      function safeRequire(name) {
        try {
          return window.require?.(name);
        } catch (_) {
          return null;
        }
      }

      const socketModule = safeRequire('WAWebSocketModel');
      const socket = socketModule && socketModule.Socket;
      const meModule = safeRequire('WAWebUserPrefsMeUser');
      let hasMe = false;

      try {
        hasMe = Boolean(
          meModule?.getMaybeMePnUser?.() ||
          meModule?.getMaybeMeLidUser?.()
        );
      } catch (_) {}

      return {
        page: 'AVAILABLE',
        urlOrigin: location.origin,
        path: location.pathname,
        readyState: document.readyState,
        titleLength: String(document.title || '').length,
        debugVersionPresent:
          Boolean(window.Debug && window.Debug.VERSION),
        debugVersion:
          window.Debug && window.Debug.VERSION
            ? String(window.Debug.VERSION).slice(0, 80)
            : 'ABSENT',
        socketState:
          socket && socket.state
            ? String(socket.state)
            : 'UNAVAILABLE',
        socketHasSynced:
          socket && typeof socket.hasSynced !== 'undefined'
            ? Boolean(socket.hasSynced)
            : null,
        wwebjsInjected:
          typeof window.WWebJS !== 'undefined',
        requirePresent:
          typeof window.require === 'function',
        hasMe,
        navigatorOnline:
          navigator.onLine
      };
    });
  } catch (error) {
    return {
      page: 'ERROR',
      error: safeError(error)
    };
  }
}

function printState(index, state) {
  const values = [
    'DIAG_POLL=' + index,
    'PAGE=' + (state.page || 'UNKNOWN'),
    'ORIGIN=' + (state.urlOrigin || 'UNKNOWN'),
    'PATH=' + (state.path || 'UNKNOWN'),
    'DOCUMENT_READY=' + (state.readyState || 'UNKNOWN'),
    'TITLE_LENGTH=' +
      (typeof state.titleLength === 'number'
        ? state.titleLength : 'UNKNOWN'),
    'DEBUG_VERSION_PRESENT=' +
      (state.debugVersionPresent === true ? 'YES'
        : state.debugVersionPresent === false ? 'NO'
        : 'UNKNOWN'),
    'DEBUG_VERSION=' + (state.debugVersion || 'UNKNOWN'),
    'SOCKET_STATE=' + (state.socketState || 'UNKNOWN'),
    'SOCKET_HAS_SYNCED=' +
      (state.socketHasSynced === true ? 'YES'
        : state.socketHasSynced === false ? 'NO'
        : 'UNKNOWN'),
    'WWEBJS_INJECTED=' +
      (state.wwebjsInjected === true ? 'YES'
        : state.wwebjsInjected === false ? 'NO'
        : 'UNKNOWN'),
    'REQUIRE_PRESENT=' +
      (state.requirePresent === true ? 'YES'
        : state.requirePresent === false ? 'NO'
        : 'UNKNOWN'),
    'HAS_ME=' +
      (state.hasMe === true ? 'YES'
        : state.hasMe === false ? 'NO'
        : 'UNKNOWN'),
    'NAVIGATOR_ONLINE=' +
      (state.navigatorOnline === true ? 'YES'
        : state.navigatorOnline === false ? 'NO'
        : 'UNKNOWN')
  ];

  if (state.error) {
    values.push('PAGE_STATE_ERROR=' + safeError(state.error));
  }

  console.log(values.join(' '));
}

async function main() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI_MISSING');
  }

  console.log('============================================================');
  console.log('WA REMOTEAUTH V3 STARTUP STATE DIAGNOSTIC V1');
  console.log('RESTORE ONLY / NO SEND / NO MONGODB WRITE');
  console.log('============================================================');
  console.log('DIAG_MONGODB_WRITE=NO');
  console.log('DIAG_REMOTEAUTH_SAVE=BLOCKED');
  console.log('DIAG_REMOTEAUTH_DELETE=BLOCKED');
  console.log('DIAG_WHATSAPP_SEND=NO');

  await mongoose.connect(MONGODB_URI, {
    dbName: 'wa_auto_absensi',
    serverSelectionTimeoutMS: 30000
  });

  console.log('DIAG_MONGODB_CONNECTED=YES');

  const baseStore = createMongoStore(
    mongoose,
    DATA_PATH
  );

  const activeExists =
    await baseStore.sessionExists({
      session: REMOTE_AUTH_V3_ACTIVE_SESSION
    });

  console.log(
    'DIAG_ACTIVE_SESSION_EXISTS=' +
      (activeExists ? 'YES' : 'NO')
  );

  if (!activeExists) {
    throw new Error('DIAG_ACTIVE_SESSION_MISSING');
  }

  const readOnlyStore = {
    sessionExists: options =>
      baseStore.sessionExists(options),

    extract: options =>
      baseStore.extract(options),

    save: async () => {
      console.log('DIAG_STORE_SAVE_BLOCKED=YES');
    },

    delete: async () => {
      console.log('DIAG_STORE_DELETE_BLOCKED=YES');
    }
  };

  const authStrategy = new RemoteAuth({
    clientId: REMOTE_AUTH_V3_CLIENT_ID,
    dataPath: DATA_PATH,
    store: readOnlyStore,
    backupSyncIntervalMs: 60000
  });

  const client = new Client({
    authStrategy,
    puppeteer: getPuppeteerOptions()
  });

  let ready = false;
  let authenticated = false;
  let qrSeen = false;
  let authFailure = false;
  let disconnected = null;
  let initializeResolved = false;
  let initializeError = null;

  client.on('ready', () => {
    ready = true;
    console.log('DIAG_EVENT_READY=YES');
  });

  client.on('authenticated', () => {
    authenticated = true;
    console.log('DIAG_EVENT_AUTHENTICATED=YES');
  });

  client.on('qr', () => {
    qrSeen = true;
    console.log('DIAG_EVENT_QR=YES');
  });

  client.on('auth_failure', message => {
    authFailure = true;
    console.log('DIAG_EVENT_AUTH_FAILURE=YES');
    console.log(
      'DIAG_EVENT_AUTH_FAILURE_MESSAGE=' +
        safeError(message)
    );
  });

  client.on('disconnected', reason => {
    disconnected = safeError(reason);
    console.log(
      'DIAG_EVENT_DISCONNECTED=' +
        disconnected
    );
  });

  console.log('DIAG_INITIALIZE_START=YES');

  const initializePromise =
    client.initialize()
      .then(() => {
        initializeResolved = true;
        console.log('DIAG_INITIALIZE_RESOLVED=YES');
      })
      .catch(error => {
        initializeError = safeError(error);
        console.log('DIAG_INITIALIZE_ERROR=YES');
        console.log(
          'DIAG_INITIALIZE_ERROR_MESSAGE=' +
            initializeError
        );
      });

  const deadline = Date.now() + HARD_TIMEOUT_MS;
  let poll = 0;

  while (Date.now() < deadline) {
    poll += 1;
    const state = await pageState(client);
    printState(poll, state);

    if (
      ready ||
      qrSeen ||
      authFailure ||
      disconnected ||
      initializeError
    ) {
      break;
    }

    await sleep(POLL_MS);
  }

  // Give initialize promise one final chance to settle without
  // extending the diagnostic beyond the fixed hard deadline.
  await Promise.race([
    initializePromise,
    sleep(250)
  ]);

  const finalState = await pageState(client);
  printState('FINAL', finalState);

  console.log(
    'DIAG_SUMMARY_READY=' +
      (ready ? 'YES' : 'NO')
  );
  console.log(
    'DIAG_SUMMARY_AUTHENTICATED=' +
      (authenticated ? 'YES' : 'NO')
  );
  console.log(
    'DIAG_SUMMARY_QR_SEEN=' +
      (qrSeen ? 'YES' : 'NO')
  );
  console.log(
    'DIAG_SUMMARY_AUTH_FAILURE=' +
      (authFailure ? 'YES' : 'NO')
  );
  console.log(
    'DIAG_SUMMARY_INITIALIZE_RESOLVED=' +
      (initializeResolved ? 'YES' : 'NO')
  );
  console.log(
    'DIAG_SUMMARY_INITIALIZE_ERROR=' +
      (initializeError ? 'YES' : 'NO')
  );

  try {
    await client.destroy();
    console.log('DIAG_CLIENT_DESTROYED=YES');
  } catch (error) {
    console.log(
      'DIAG_CLIENT_DESTROY_ERROR=' +
        safeError(error)
    );
  }

  await mongoose.disconnect();
  console.log('DIAG_MONGODB_DISCONNECTED=YES');

  if (
    ready &&
    !qrSeen &&
    !authFailure &&
    !initializeError
  ) {
    console.log('DIAG_RESULT=READY');
    return;
  }

  if (qrSeen) {
    console.log('DIAG_RESULT=QR_REQUIRED');
    process.exitCode = 20;
    return;
  }

  if (authFailure) {
    console.log('DIAG_RESULT=AUTH_FAILURE');
    process.exitCode = 21;
    return;
  }

  if (initializeError) {
    console.log('DIAG_RESULT=INITIALIZE_ERROR');
    process.exitCode = 22;
    return;
  }

  console.log('DIAG_RESULT=NO_READY_WITHIN_TIMEOUT');
  process.exitCode = 23;
}

main().catch(async error => {
  console.log(
    'DIAG_FATAL_ERROR=' +
      safeError(error)
  );

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log('DIAG_MONGODB_DISCONNECTED=YES');
    }
  } catch (_) {}

  process.exitCode = 1;
});
