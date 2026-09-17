'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');

const {
  Client,
  RemoteAuth
} = require('whatsapp-web.js');

const {
  createMongoStore
} = require('./remote-auth');

const CLIENT_ID =
  'wa-auto-absensi-remote-v2';

const SESSION_NAME =
  `RemoteAuth-${CLIENT_ID}`;

const LEGACY_SESSION_NAME =
  'RemoteAuth-wa-auto-absensi-remote';

const DATA_PATH =
  process.env.WWEBJS_REMOTE_DATA_PATH ||
  path.join(
    os.tmpdir(),
    'wa-auto-absensi-remoteauth-v2'
  );

const EXPECTED_PROJECT =
  String(
    process.env.WA_BOOTSTRAP_EXPECTED_PROJECT ||
    ''
  ).trim();

const MONGODB_URI =
  process.env.MONGODB_URI;

const FETCH_LIMIT = 100;

const PROJECT_WAIT_ATTEMPTS = 30;
const PROJECT_WAIT_MS = 10000;

const SESSION_SAVE_ATTEMPTS = 24;
const SESSION_SAVE_WAIT_MS = 10000;

const GLOBAL_TIMEOUT_MS =
  18 * 60 * 1000;

let client = null;
let finished = false;
let readyStarted = false;
let remoteSessionSavedEvent = false;
let legacySessionExistedBefore = false;

function timeout(promise, ms, label) {
  let timer;

  const timeoutPromise =
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label}_TIMEOUT_${ms}MS`
            )
          ),
        ms
      );
    });

  return Promise
    .race([
      promise,
      timeoutPromise
    ])
    .finally(() => clearTimeout(timer));
}

function wait(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function parseProject(body) {
  const text =
    String(body || '').trim();

  const match =
    text.match(/^p\s*:\s*(.+)$/i);

  if (!match) {
    return null;
  }

  const project =
    match[1].trim();

  return project.length
    ? project
    : null;
}

function idServer(id) {
  const text =
    String(id || '');

  const parts =
    text.split('@');

  return parts.length === 2
    ? parts[1]
    : 'unknown';
}

async function safeSessionExists(
  store,
  sessionName
) {
  try {
    return Boolean(
      await store.sessionExists({
        session: sessionName
      })
    );
  } catch (error) {
    console.error(
      'SESSION_EXISTS_CHECK_ERROR=YES'
    );

    console.error(error);

    return false;
  }
}

async function resolveSelfCandidates() {
  const selfId =
    client &&
    client.info &&
    client.info.wid &&
    client.info.wid._serialized;

  if (!selfId) {
    throw new Error(
      'SELF_ID_MISSING'
    );
  }

  const ids = [selfId];

  if (
    typeof client.getContactLidAndPhone ===
    'function'
  ) {
    try {
      const mappings =
        await timeout(
          client.getContactLidAndPhone(
            [selfId]
          ),
          30000,
          'SELF_LID_LOOKUP'
        );

      for (
        const mapping of mappings || []
      ) {
        const lid =
          mapping && mapping.lid;

        if (
          typeof lid === 'string' &&
          lid.endsWith('@lid') &&
          !ids.includes(lid)
        ) {
          ids.push(lid);
        }
      }
    } catch (error) {
      console.log(
        'SELF_LID_LOOKUP_RESULT=ERROR'
      );

      console.log(
        `SELF_LID_LOOKUP_ERROR=${
          error && error.message
            ? error.message
            : String(error)
        }`
      );
    }
  }

  console.log(
    `SELF_CHAT_ID_CANDIDATE_COUNT=${ids.length}`
  );

  return ids;
}

async function findExpectedProject() {
  if (!EXPECTED_PROJECT) {
    throw new Error(
      'EXPECTED_PROJECT_EMPTY'
    );
  }

  const candidateIds =
    await resolveSelfCandidates();

  for (
    let attempt = 1;
    attempt <= PROJECT_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    console.log(
      `PROJECT_SYNC_ATTEMPT=${attempt}`
    );

    for (
      const candidateId of candidateIds
    ) {
      const server =
        idServer(candidateId);

      try {
        const chat =
          await timeout(
            client.getChatById(
              candidateId
            ),
            30000,
            'SELF_CHAT_LOOKUP'
          );

        if (!chat) {
          console.log(
            `SELF_CHAT_${server}_FOUND=NO`
          );

          continue;
        }

        if (
          typeof chat.syncHistory ===
          'function'
        ) {
          try {
            const syncResult =
              await timeout(
                chat.syncHistory(),
                15000,
                'SELF_CHAT_SYNC_HISTORY'
              );

            console.log(
              `SELF_CHAT_${server}_SYNC_RESULT=${syncResult}`
            );
          } catch (error) {
            console.log(
              `SELF_CHAT_${server}_SYNC_RESULT=ERROR`
            );
          }
        }

        const messages =
          await timeout(
            chat.fetchMessages({
              limit: FETCH_LIMIT,
              fromMe: true
            }),
            60000,
            'SELF_CHAT_FETCH'
          );

        console.log(
          `SELF_CHAT_${server}_MESSAGE_COUNT=${messages.length}`
        );

        const projects =
          messages
            .map(msg => ({
              project:
                parseProject(msg.body),

              timestamp:
                Number(
                  msg.timestamp || 0
                )
            }))
            .filter(
              item => item.project
            )
            .sort(
              (a, b) =>
                b.timestamp -
                a.timestamp
            );

        const matched =
          projects.find(
            item =>
              item.project ===
              EXPECTED_PROJECT
          );

        if (matched) {
          console.log(
            'REMOTE_V2_PROJECT_FOUND=YES'
          );

          console.log(
            `REMOTE_V2_PROJECT=${matched.project}`
          );

          console.log(
            `REMOTE_V2_PROJECT_SOURCE_SERVER=${server}`
          );

          console.log(
            `REMOTE_V2_PROJECT_TIMESTAMP=${matched.timestamp}`
          );

          return true;
        }

        console.log(
          `REMOTE_V2_PROJECT_FOUND_ON_${server}=NO`
        );
      } catch (error) {
        console.log(
          `SELF_CHAT_${server}_READ_ERROR=YES`
        );

        console.log(
          `SELF_CHAT_${server}_READ_ERROR_MESSAGE=${
            error && error.message
              ? error.message
              : String(error)
          }`
        );
      }
    }

    if (
      attempt <
      PROJECT_WAIT_ATTEMPTS
    ) {
      await wait(
        PROJECT_WAIT_MS
      );
    }
  }

  console.log(
    'REMOTE_V2_PROJECT_FOUND=NO'
  );

  return false;
}

async function waitForRemoteSession(store) {
  for (
    let attempt = 1;
    attempt <= SESSION_SAVE_ATTEMPTS;
    attempt += 1
  ) {
    const exists =
      await safeSessionExists(
        store,
        SESSION_NAME
      );

    console.log(
      `REMOTE_V2_SESSION_SAVE_CHECK_${attempt}=${
        exists ? 'YES' : 'NO'
      }`
    );

    if (exists) {
      return true;
    }

    if (
      attempt <
      SESSION_SAVE_ATTEMPTS
    ) {
      await wait(
        SESSION_SAVE_WAIT_MS
      );
    }
  }

  return false;
}

async function cleanup(code) {
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
  } catch (error) {
    console.log(
      'WHATSAPP_CLIENT_DESTROY_ERROR=YES'
    );
  }

  try {
    await mongoose.disconnect();

    console.log(
      'MONGOOSE_DISCONNECTED=YES'
    );
  } catch (error) {
    console.log(
      'MONGOOSE_DISCONNECT_ERROR=YES'
    );
  }

  setTimeout(
    () => process.exit(code),
    1000
  );
}

async function main() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI_MISSING'
    );
  }

  if (!EXPECTED_PROJECT) {
    throw new Error(
      'WA_BOOTSTRAP_EXPECTED_PROJECT_MISSING'
    );
  }

  console.log(
    '============================================================'
  );

  console.log(
    'WA AUTO ABSENSI - REMOTEAUTH V2 BOOTSTRAP'
  );

  console.log(
    'NEW PARALLEL SESSION'
  );

  console.log(
    'NO WHATSAPP MESSAGE WILL BE SENT'
  );

  console.log(
    '============================================================'
  );

  console.log(
    `REMOTE_V2_CLIENT_ID=${CLIENT_ID}`
  );

  console.log(
    `EXPECTED_PROJECT=${EXPECTED_PROJECT}`
  );

  await fs.promises.mkdir(
    DATA_PATH,
    {
      recursive: true
    }
  );

  console.log(
    'REMOTE_V2_DATA_PATH_READY=YES'
  );

  await mongoose.connect(
    MONGODB_URI,
    {
      serverSelectionTimeoutMS: 30000
    }
  );

  console.log(
    'MONGODB_CONNECTED=YES'
  );

  const store =
    createMongoStore(
      mongoose,
      DATA_PATH
    );

  console.log(
    'MONGO_STORE_READY=YES'
  );

  legacySessionExistedBefore =
    await safeSessionExists(
      store,
      LEGACY_SESSION_NAME
    );

  console.log(
    `LEGACY_REMOTE_SESSION_EXISTS_BEFORE=${
      legacySessionExistedBefore
        ? 'YES'
        : 'NO'
    }`
  );

  const v2ExistsBefore =
    await safeSessionExists(
      store,
      SESSION_NAME
    );

  console.log(
    `REMOTE_V2_SESSION_EXISTS_BEFORE=${
      v2ExistsBefore
        ? 'YES'
        : 'NO'
    }`
  );

  const authStrategy =
    new RemoteAuth({
      clientId: CLIENT_ID,
      store,
      backupSyncIntervalMs: 600000,
      dataPath: DATA_PATH
    });

  const puppeteer = {
    headless: true,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  };

  if (process.env.CHROME_PATH) {
    puppeteer.executablePath =
      process.env.CHROME_PATH;
  }

  client =
    new Client({
      authStrategy,
      puppeteer
    });

  client.on(
    'qr',
    qr => {
      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        'REMOTE_V2_QR_REQUIRED=YES'
      );

      console.log(
        'SCAN THIS QR FROM WHATSAPP LINKED DEVICES'
      );

      console.log(
        'THIS CREATES V2 ONLY'
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
        'REMOTE_V2_AUTHENTICATED=YES'
      );
    }
  );

  client.on(
    'auth_failure',
    async message => {
      console.error(
        'REMOTE_V2_AUTH_FAILURE=YES'
      );

      console.error(message);

      await cleanup(20);
    }
  );

  client.on(
    'remote_session_saved',
    () => {
      remoteSessionSavedEvent =
        true;

      console.log(
        'REMOTE_V2_SESSION_SAVED_EVENT=YES'
      );
    }
  );

  client.on(
    'ready',
    async () => {
      if (readyStarted) {
        console.log(
          'REMOTE_V2_READY_REENTRY_IGNORED=YES'
        );

        return;
      }

      readyStarted = true;

      console.log(
        'REMOTE_V2_WHATSAPP_READY=YES'
      );

      try {
        const projectFound =
          await findExpectedProject();

        if (!projectFound) {
          console.log(
            'REMOTE_V2_PROJECT_VERIFY=FAIL'
          );

          console.log(
            'MESSAGE_SENT=NO'
          );

          return await cleanup(21);
        }

        console.log(
          'REMOTE_V2_PROJECT_VERIFY=PASS'
        );

        const sessionSaved =
          await waitForRemoteSession(
            store
          );

        console.log(
          `REMOTE_V2_SESSION_EXISTS_AFTER=${
            sessionSaved
              ? 'YES'
              : 'NO'
          }`
        );

        console.log(
          `REMOTE_V2_SESSION_SAVED_EVENT_SEEN=${
            remoteSessionSavedEvent
              ? 'YES'
              : 'NO'
          }`
        );

        if (!sessionSaved) {
          console.log(
            'REMOTE_V2_SESSION_SAVE=FAIL'
          );

          console.log(
            'MESSAGE_SENT=NO'
          );

          return await cleanup(22);
        }

        const legacyAfter =
          await safeSessionExists(
            store,
            LEGACY_SESSION_NAME
          );

        console.log(
          `LEGACY_REMOTE_SESSION_EXISTS_AFTER=${
            legacyAfter
              ? 'YES'
              : 'NO'
          }`
        );

        if (
          legacySessionExistedBefore &&
          !legacyAfter
        ) {
          console.log(
            'LEGACY_REMOTE_SESSION_PRESERVED=NO'
          );

          console.log(
            'MESSAGE_SENT=NO'
          );

          return await cleanup(23);
        }

        console.log(
          'LEGACY_REMOTE_SESSION_PRESERVED=YES'
        );

        console.log(
          'REMOTE_V2_BOOTSTRAP=PASS'
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        await cleanup(0);
      } catch (error) {
        console.error(
          'REMOTE_V2_READY_ERROR=YES'
        );

        console.error(error);

        console.log(
          'MESSAGE_SENT=NO'
        );

        await cleanup(24);
      }
    }
  );

  client.on(
    'disconnected',
    reason => {
      console.log(
        `REMOTE_V2_DISCONNECTED=${reason}`
      );
    }
  );

  console.log(
    'REMOTE_V2_CLIENT_INITIALIZE_START=YES'
  );

  await client.initialize();

  console.log(
    'REMOTE_V2_CLIENT_INITIALIZE_RESOLVED=YES'
  );
}

const globalTimer =
  setTimeout(
    async () => {
      console.error(
        'REMOTE_V2_BOOTSTRAP_TIMEOUT=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await cleanup(30);
    },
    GLOBAL_TIMEOUT_MS
  );

main()
  .catch(
    async error => {
      console.error(
        'REMOTE_V2_BOOTSTRAP_ERROR=YES'
      );

      console.error(error);

      console.log(
        'MESSAGE_SENT=NO'
      );

      await cleanup(1);
    }
  )
  .finally(
    () => {
      if (finished) {
        clearTimeout(
          globalTimer
        );
      }
    }
  );