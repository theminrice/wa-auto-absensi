'use strict';

const path = require('path');
const mongoose = require('mongoose');

const {
  Client
} = require('whatsapp-web.js');

const {
  REMOTE_AUTH_V3_ACTIVE_SESSION: REMOTE_AUTH_SESSION,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createRemoteAuthV3
} = require('./remote-auth-v3');

// WA_AUTO_ABSENSI_PRODUCTION_V3_SYNC_V1
// WA_AUTO_ABSENSI_INGEST_REMOTEAUTH_CATCHUP_V1

const {
  INPUT_COLLECTION,
  STORAGE_VERSION,
  ensureAttendanceIndexes,
  saveProject,
  saveDocumentation,
  saveLeave
} = require('./attendance-input-store');

const {
  parseLeaveCommand
} = require('./attendance-leave');

const {
  INPUT_GROUP_NAME,
  findPaleluGroup,
  isPaleluMessage
} = require('./attendance-input-group');

let client = null;
let shuttingDown = false;
let ingestQueue = Promise.resolve();
let readyPipelineStarted = false;

// WA_AUTO_ABSENSI_SYNC_ONCE_V1
const syncOnceMode =
  process.argv.includes('--sync-once');

// PALELU_DIAGNOSTIC_ONLY_V1: fetch metadata; no attendance writes/send.
const diagnosticOnlyMode =
  process.argv.includes('--diagnostic-only');

if (diagnosticOnlyMode && syncOnceMode) {
  throw new Error('DIAGNOSTIC_AND_SYNC_ONCE_MUTUALLY_EXCLUSIVE');
}

let inputGroupId = null;
const processedMessageIds = new Set();

// WA_AUTO_ABSENSI_INGEST_CATCHUP_STABILITY_V2
const REMOTE_POST_READY_SETTLE_MS = 15000;
const STARTUP_CATCHUP_MAX_SWEEPS = 3;
const STARTUP_CATCHUP_RETRY_MS = 5000;

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

function requireMongoUri() {
  const uri = process.env.MONGODB_URI;

  if (
    typeof uri !== 'string' ||
    !uri.trim()
  ) {
    throw new Error(
      'MONGODB_URI_NOT_AVAILABLE'
    );
  }

  return uri;
}

// WA_AUTO_ABSENSI_PALELU_DISCOVERY_V1
async function resolveInputGroup() {
  inputGroupId = null;

  const chats =
    await client.getChats();

  const selected =
    findPaleluGroup(chats);

  inputGroupId =
    selected.id;

  console.log('PALELU_GROUP_FOUND=YES');
  console.log('PALELU_GROUP_NAME=' + INPUT_GROUP_NAME);
  console.log('PALELU_GROUP_SAFE=YES');
  console.log('PALELU_GROUP_ID_FOUND=YES');
}

function parseProject(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const match =
    body.match(
      /^\s*p:\s*(.+?)\s*$/i
    );

  if (!match) {
    return null;
  }

  const project =
    match[1].trim();

  return project || null;
}

function isDocumentationImage(message) {
  if (!message) {
    return false;
  }

  const body =
    typeof message.body === 'string'
      ? message.body.trim().toLowerCase()
      : '';

  const type =
    typeof message.type === 'string'
      ? message.type.toLowerCase()
      : '';

  return (
    message.hasMedia === true &&
    type === 'image' &&
    body === 'p'
  );
}

function messageTimestamp(message) {
  const unix =
    Number(message && message.timestamp);

  if (
    Number.isFinite(unix) &&
    unix > 0
  ) {
    return new Date(
      unix * 1000
    );
  }

  return new Date();
}

function extensionForMime(mimetype) {
  switch (
    String(mimetype || '')
      .toLowerCase()
  ) {
    case 'image/jpeg':
      return '.jpg';

    case 'image/png':
      return '.png';

    case 'image/webp':
      return '.webp';

    case 'image/gif':
      return '.gif';

    case 'image/heic':
      return '.heic';

    default:
      return '.img';
  }
}

function getMessageId(message) {
  if (
    message &&
    message.id &&
    typeof message.id._serialized ===
      'string'
  ) {
    return message.id._serialized;
  }

  return null;
}

async function alreadyPersisted(
  messageId
) {
  if (!messageId) {
    return false;
  }

  if (
    processedMessageIds.has(messageId)
  ) {
    return true;
  }

  const collection =
    mongoose.connection.db.collection(
      INPUT_COLLECTION
    );

  const existing =
    await collection.findOne(
      {
        sourceMessageId: messageId
      },
      {
        projection: {
          _id: 1
        }
      }
    );

  return !!existing;
}

// WA_AUTO_ABSENSI_CURRENT_STATE_REPLAY_GUARD_V1
async function getCurrentCanonical(kind) {
  const collection =
    mongoose.connection.db.collection(
      INPUT_COLLECTION
    );

  return collection.findOne(
    {
      kind
    },
    {
      projection: {
        _id: 1,
        createdAt: 1
      },
      sort: {
        createdAt: -1,
        _id: -1
      }
    }
  );
}

async function markDedupOnly(messageId) {
  if (!messageId) {
    return;
  }

  const collection =
    mongoose.connection.db.collection(
      INPUT_COLLECTION
    );

  const now =
    new Date();

  await collection.updateOne(
    {
      kind: 'ingest-dedup'
    },
    {
      $setOnInsert: {
        version: STORAGE_VERSION,
        kind: 'ingest-dedup',
        source: 'system',
        createdAt: now
      },
      $set: {
        updatedAt: now
      },
      $addToSet: {
        sourceMessageId: messageId
      }
    },
    {
      upsert: true
    }
  );

  processedMessageIds.add(
    messageId
  );
}

function isNewerThanCurrent(
  message,
  current
) {
  if (
    !current ||
    !current.createdAt
  ) {
    return true;
  }

  const incomingTime =
    messageTimestamp(message)
      .getTime();

  const currentTime =
    new Date(
      current.createdAt
    ).getTime();

  if (
    !Number.isFinite(currentTime)
  ) {
    return true;
  }

  return incomingTime > currentTime;
}

async function markPersisted(
  storedId,
  messageId
) {
  if (!messageId) {
    return;
  }

  const collection =
    mongoose.connection.db.collection(
      INPUT_COLLECTION
    );

  await collection.updateOne(
    {
      _id: storedId
    },
    {
      $set: {
        source: 'whatsapp-palelu-group',
        sourceMessageId: messageId
      }
    }
  );

  processedMessageIds.add(
    messageId
  );
}

async function ingestProject(
  message,
  project,
  messageId
) {
  const createdAt =
    messageTimestamp(message);

  const saved =
    await saveProject(
      mongoose.connection,
      project,
      createdAt
    );

  await markPersisted(
    saved._id,
    messageId
  );

  console.log(
    'PALELU_PROJECT_CAPTURED=YES'
  );

  console.log(
    `PROJECT=${saved.project}`
  );

  console.log(
    `PROJECT_TIMESTAMP=${saved.createdAt.toISOString()}`
  );
}

async function ingestLeave(
  message,
  leave,
  messageId
) {
  const createdAt =
    messageTimestamp(message);

  const saved =
    await saveLeave(
      mongoose.connection,
      leave,
      createdAt
    );

  await markPersisted(
    saved._id,
    messageId
  );

  console.log(
    'PALELU_LEAVE_CAPTURED=YES'
  );

  console.log(
    'LEAVE_START_DATE=' +
    saved.startDate
  );

  console.log(
    'LEAVE_END_DATE=' +
    saved.endDate
  );

  console.log(
    'LEAVE_TIMESTAMP=' +
    saved.createdAt.toISOString()
  );
}

async function ingestDocumentation(
  message,
  messageId
) {
  const media =
    await message.downloadMedia();

  if (
    !media ||
    typeof media.data !== 'string' ||
    !media.data
  ) {
    throw new Error(
      'DOCUMENTATION_MEDIA_DOWNLOAD_EMPTY'
    );
  }

  const mimetype =
    String(
      media.mimetype || ''
    )
      .trim()
      .toLowerCase();

  if (
    !mimetype.startsWith('image/')
  ) {
    throw new Error(
      'DOCUMENTATION_MEDIA_NOT_IMAGE'
    );
  }

  const buffer =
    Buffer.from(
      media.data,
      'base64'
    );

  if (buffer.length === 0) {
    throw new Error(
      'DOCUMENTATION_MEDIA_BUFFER_EMPTY'
    );
  }

  const createdAt =
    messageTimestamp(message);

  const filename =
    media.filename &&
    String(media.filename).trim()
      ? path.basename(
          String(media.filename).trim()
        )
      : (
          'attendance-' +
          createdAt.getTime() +
          extensionForMime(mimetype)
        );

  const saved =
    await saveDocumentation(
      mongoose.connection,
      {
        buffer,
        filename,
        mimetype,
        createdAt
      }
    );

  await markPersisted(
    saved._id,
    messageId
  );

  console.log(
    'PALELU_DOCUMENTATION_CAPTURED=YES'
  );

  console.log(
    `DOCUMENTATION_FILENAME=${saved.filename}`
  );

  console.log(
    `DOCUMENTATION_MIMETYPE=${saved.mimetype}`
  );

  console.log(
    `DOCUMENTATION_SIZE=${saved.size}`
  );

  console.log(
    `DOCUMENTATION_TIMESTAMP=${saved.createdAt.toISOString()}`
  );
}

async function handleMessage(message) {
  const paleluInput =
    await isPaleluMessage(
      message,
      inputGroupId
    );

  if (!paleluInput) {
    return;
  }

  const project =
    parseProject(message.body);

  const leave =
    parseLeaveCommand(
      message.body,
      messageTimestamp(message)
    );

  const documentation =
    isDocumentationImage(message);

  if (
    !project &&
    !leave &&
    !documentation
  ) {
    return;
  }

  const messageId =
    getMessageId(message);

  const kind =
    project
      ? 'project'
      : leave
        ? 'leave'
        : 'documentation';

  const current =
    await getCurrentCanonical(
      kind
    );

  const persisted =
    await alreadyPersisted(
      messageId
    );

  if (persisted) {
    if (
      !isNewerThanCurrent(
        message,
        current
      )
    ) {
      console.log(
        'PALELU_DUPLICATE_SKIPPED=YES'
      );

      return;
    }

    console.log(
      'PALELU_DUPLICATE_REPLAY_FOR_CURRENT_STATE=YES'
    );

    console.log(
      `PALELU_REPLAY_KIND=${kind}`
    );
  } else if (
    current &&
    !isNewerThanCurrent(
      message,
      current
    )
  ) {
    await markDedupOnly(
      messageId
    );

    console.log(
      'PALELU_STALE_REPLAY_SKIPPED=YES'
    );

    console.log(
      `PALELU_STALE_KIND=${kind}`
    );

    console.log(
      `PALELU_STALE_TIMESTAMP=${messageTimestamp(message).toISOString()}`
    );

    console.log(
      `PALELU_CURRENT_TIMESTAMP=${new Date(current.createdAt).toISOString()}`
    );

    return;
  }

  if (project) {
    await ingestProject(
      message,
      project,
      messageId
    );

    return;
  }

  if (leave) {
    await ingestLeave(
      message,
      leave,
      messageId
    );

    return;
  }

  if (documentation) {
    await ingestDocumentation(
      message,
      messageId
    );
  }
}

// WA_AUTO_ABSENSI_PALELU_CATCHUP_V1
async function startupCatchupPalelu() {
  console.log('PALELU_CATCHUP_START=YES');

  if (!inputGroupId || !inputGroupId.endsWith('@g.us')) {
    throw new Error('PALELU_GROUP_NOT_RESOLVED');
  }

  const chat =
    await client.getChatById(inputGroupId);

  if (
    !chat ||
    chat.isGroup !== true ||
    typeof chat.name !== 'string' ||
    chat.name.trim() !== INPUT_GROUP_NAME ||
    typeof chat.fetchMessages !== 'function'
  ) {
    throw new Error('PALELU_CATCHUP_GROUP_MISMATCH');
  }

  // PALELU_HISTORY_SNAPSHOT_DIAGNOSTIC_V2
  // Inspect the SAME browser chat model used by fetchMessages().
  // Only counts and timestamps leave the browser; no message text/IDs/media.
  async function historySnapshot(stage) {
    try {
      const result = await client.pupPage.evaluate(async (chatId) => {
        const raw = await window.WWebJS.getChat(
          chatId, { getAsModel: false }
        );
        if (!raw) {
          return { chatPresent: false };
        }
        const items = raw.msgs &&
          typeof raw.msgs.getModelsArray === 'function'
            ? raw.msgs.getModelsArray()
            : null;
        const times = Array.isArray(items)
          ? items.map(item => Number(item && item.t || 0))
              .filter(value => Number.isFinite(value) && value > 0)
          : [];
        return {
          chatPresent: true,
          chatTimestamp: Number(raw.t || 0),
          hasLastReceivedKey: Boolean(raw.lastReceivedKey),
          messageCollectionPresent: Array.isArray(items),
          cachedMessageCount: Array.isArray(items) ? items.length : null,
          cachedEarliestTimestamp: times.length ? Math.min(...times) : null,
          cachedLatestTimestamp: times.length ? Math.max(...times) : null,
          cachedImageCount: Array.isArray(items)
            ? items.filter(item => item && item.type === 'image').length
            : null
        };
      }, inputGroupId);
      console.log('PALELU_DIAG_HISTORY_' + stage + '=' +
        JSON.stringify(result));
    } catch (error) {
      console.log('PALELU_DIAG_HISTORY_' + stage +
        '_ERROR_NAME=' + String(error && error.name || 'UNKNOWN')
          .replace(/[^A-Za-z_]/g, ''));
    }
  }

  if (diagnosticOnlyMode) {
    await historySnapshot('BEFORE_FETCH');
  }

  const messages =
    await chat.fetchMessages({ limit: 50 });

  if (diagnosticOnlyMode) {
    await historySnapshot('AFTER_FETCH');
  }

  // PALELU_CATCHUP_DIAGNOSTIC_V1: metadata only; no chat content or IDs.
  console.log('PALELU_DIAG_FETCH_LIMIT=50');
  console.log('PALELU_DIAG_FETCHED_COUNT=' +
    (Array.isArray(messages) ? messages.length : 'INVALID'));

  if (!Array.isArray(messages)) {
    throw new Error('PALELU_CATCHUP_MESSAGES_INVALID');
  }

  messages.sort((a, b) =>
    Number(a && a.timestamp || 0) -
    Number(b && b.timestamp || 0)
  );

  const seenMessageIds = new Set();
  let relevantCount = 0;
  let diagnosticPosition = 0;

  for (const message of messages) {
    diagnosticPosition += 1;
    const messageId = getMessageId(message);

    if (messageId && seenMessageIds.has(messageId)) {
      console.log('PALELU_DIAG_DUPLICATE_POSITION=' + diagnosticPosition);
      continue;
    }

    if (messageId) {
      seenMessageIds.add(messageId);
    }

    const allowed =
      await isPaleluMessage(message, inputGroupId);

    // Metadata only: never log message text, chat IDs or media bytes.
    console.log('PALELU_DIAG_MESSAGE=' + JSON.stringify({
      position: diagnosticPosition,
      timestamp: Number(message && message.timestamp || 0),
      fromMe: message && message.fromMe === true,
      type: message && message.type || null,
      hasMedia: message && message.hasMedia === true,
      captionIsP: typeof (message && message.body) === 'string' &&
        message.body.trim().toLowerCase() === 'p',
      messageIdPresent: Boolean(messageId),
      groupAllowed: allowed
    }));

    if (!allowed) {
      continue;
    }

    const project = parseProject(message.body);
    const leave = parseLeaveCommand(
      message.body,
      messageTimestamp(message)
    );
    const documentation =
      isDocumentationImage(message);

    console.log('PALELU_DIAG_CLASSIFICATION=' + JSON.stringify({
      position: diagnosticPosition,
      kind: project ? 'project' : leave ? 'leave' :
        documentation ? 'documentation' : 'none'
    }));

    if (!project && !leave && !documentation) {
      continue;
    }

    relevantCount += 1;
    if (!diagnosticOnlyMode) {
      await handleMessage(message);
    }
  }

  console.log('PALELU_CATCHUP_CHAT_COUNT=1');
  console.log('PALELU_CATCHUP_FETCHED_COUNT=' + messages.length);
  console.log('PALELU_CATCHUP_RELEVANT_COUNT=' + relevantCount);
  console.log('PALELU_CATCHUP_COMPLETE=YES');
}
async function startupCatchupPaleluStable() {
  let successfulSweeps = 0;
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= STARTUP_CATCHUP_MAX_SWEEPS;
    attempt += 1
  ) {
    console.log(
      `PALELU_CATCHUP_SWEEP=${attempt}`
    );

    try {
      await startupCatchupPalelu();

      successfulSweeps += 1;

      console.log(
        `PALELU_CATCHUP_SWEEP_${attempt}=PASS`
      );
    } catch (error) {
      lastError = error;

      console.log(
        `PALELU_CATCHUP_SWEEP_${attempt}=FAIL`
      );

      console.log(
        'PALELU_CATCHUP_SWEEP_ERROR=' +
        error.message
      );
    }

    if (
      attempt <
      STARTUP_CATCHUP_MAX_SWEEPS
    ) {
      console.log(
        `PALELU_CATCHUP_RETRY_WAIT_MS=${STARTUP_CATCHUP_RETRY_MS}`
      );

      await sleep(
        STARTUP_CATCHUP_RETRY_MS
      );
    }
  }

  console.log(
    `PALELU_CATCHUP_SUCCESSFUL_SWEEPS=${successfulSweeps}`
  );

  if (successfulSweeps === 0) {
    throw (
      lastError ||
      new Error(
        'PALELU_CATCHUP_ALL_SWEEPS_FAILED'
      )
    );
  }

  console.log(
    'PALELU_CATCHUP_STABLE=YES'
  );
}
async function shutdown(reason) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `LISTENER_SHUTDOWN_REASON=${reason}`
  );

  try {
    if (client) {
      await client.destroy();

      console.log(
        'WHATSAPP_CLIENT_DESTROYED=YES'
      );
    }
  } catch (error) {
    console.log(
      `WHATSAPP_DESTROY_ERROR=${error.message}`
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
  } catch (error) {
    console.log(
      `MONGOOSE_DISCONNECT_ERROR=${error.message}`
    );
  }
}


// WA_AUTO_ABSENSI_CONFLICT_BUTTON_FIX_V1
async function monitorWhatsAppConflictButton(client) {
  const deadline =
    Date.now() + 120000;

  while (Date.now() < deadline) {
    if (
      client.info ||
      !client.pupPage
    ) {
      if (client.info) {
        return;
      }

      await new Promise(
        resolve => setTimeout(resolve, 250)
      );

      continue;
    }

    try {
      const result =
        await client.pupPage.evaluate(() => {
          const normalize =
            value =>
              String(value || '')
                .replace(/\s+/g, ' ')
                .trim();

          const dialog =
            document.querySelector(
              '[role="dialog"]'
            );

          if (!dialog) {
            return {
              dialog: false,
              button: false,
              clicked: false
            };
          }

          const button =
            Array.from(
              dialog.querySelectorAll(
                'button'
              )
            ).find(
              element =>
                normalize(
                  element.innerText
                ) === 'Gunakan di Sini'
            );

          if (!button) {
            return {
              dialog: true,
              button: false,
              clicked: false
            };
          }

          button.click();

          return {
            dialog: true,
            button: true,
            clicked: true
          };
        });

      if (result.clicked) {
        console.log(
          'WHATSAPP_CONFLICT_DIALOG=YES'
        );

        console.log(
          'WHATSAPP_CONFLICT_BUTTON_CLICK=PASS'
        );

        return;
      }
    } catch (error) {
      const message =
        error &&
        error.message
          ? error.message
          : String(error);

      if (
        !message.includes(
          'Execution context was destroyed'
        )
      ) {
        console.log(
          `WHATSAPP_CONFLICT_MONITOR_ERROR=${message}`
        );
      }
    }

    await new Promise(
      resolve => setTimeout(resolve, 500)
    );
  }

  console.log(
    'WHATSAPP_CONFLICT_DIALOG=NOT_OBSERVED'
  );
}

async function main() {
  console.log(
    '============================================================'
  );

  console.log(
    'WA AUTO ABSENSI - SELF CHAT INGEST LISTENER V1'
  );

  console.log(
    'SELF CHAT INPUT -> MONGODB'
  );

  console.log(
    'NO WHATSAPP MESSAGE WILL BE SENT'
  );

  console.log(
    '============================================================'
  );

  const uri =
    requireMongoUri();

  await mongoose.connect(
    uri,
    {
      serverSelectionTimeoutMS: 15000
    }
  );

  console.log(
    'MONGODB_CONNECTED=YES'
  );

  await mongoose.connection.db.command({
    ping: 1
  });

  console.log(
    'MONGODB_PING=PASS'
  );

  if (!diagnosticOnlyMode) {
    await ensureAttendanceIndexes(
      mongoose.connection
    );

    console.log(
      'ATTENDANCE_INDEX_READY=YES'
    );
  } else {
    console.log('PALELU_DIAG_ATTENDANCE_DB_WRITES=DISABLED');
  }

  const remoteDataPath =
    getRemoteAuthDataPath();

  const remoteV3 =
    createRemoteAuthV3(
      mongoose,
      remoteDataPath
    );

  const remoteStore =
    remoteV3.store;

  if (diagnosticOnlyMode) {
    // Do not fall back to self-healing the active session in diagnostic.
    await remoteStore.verifyActiveSnapshot();
    remoteStore.save = async () => {
      console.log('PALELU_DIAG_REMOTE_AUTH_SAVE=SKIPPED');
    };
    remoteStore.delete = async () => {
      throw new Error('PALELU_DIAG_REMOTE_AUTH_DELETE_FORBIDDEN');
    };
    console.log('PALELU_DIAG_REMOTE_AUTH_WRITE=DISABLED');
  }

  console.log(
    'AUTH_MODE=REMOTE'
  );

  console.log(
    'REMOTE_AUTH_VERSION=V3'
  );

  console.log(
    `REMOTE_AUTH_SESSION=${REMOTE_AUTH_SESSION}`
  );

  client =
    new Client({
      authStrategy:
        remoteV3.authStrategy,

      puppeteer:
        getPuppeteerOptions()
    });

  client.on('qr', async () => {
    console.error(
      'REMOTE_AUTH_QR_FORBIDDEN=YES'
    );

    process.exitCode = 1;

    await shutdown(
      'REMOTE_AUTH_QR_FORBIDDEN'
    );
  });
  client.on('authenticated', () => {
    console.log(
      'WHATSAPP_AUTHENTICATED=YES'
    );
  });

  client.on('ready', async () => {
    try {
      console.log(
        'WHATSAPP_READY=YES'
      );

      if (readyPipelineStarted) {
        console.log(
          'READY_REENTRY_IGNORED=YES'
        );

        return;
      }

      readyPipelineStarted = true;

      console.log(
        `REMOTE_POST_READY_SETTLE_MS=${REMOTE_POST_READY_SETTLE_MS}`
      );

      await sleep(
        REMOTE_POST_READY_SETTLE_MS
      );

      console.log(
        'REMOTE_POST_READY_SETTLE_DONE=YES'
      );

      await resolveInputGroup();

      await startupCatchupPaleluStable();

      if (diagnosticOnlyMode) {
        console.log('PALELU_DIAG_FETCH_COMPLETE=YES');
        console.log('MESSAGE_SENT=NO');
        await shutdown('DIAGNOSTIC_ONLY_COMPLETE');
        process.exit(0);
        return;
      }

      if (syncOnceMode) {
        console.log(
          'ATTENDANCE_SYNC_ONCE_CATCHUP=PASS'
        );

        await shutdown(
          'SYNC_ONCE_COMPLETE'
        );

        console.log(
          'ATTENDANCE_SYNC_ONCE=PASS'
        );

        process.exit(0);
        return;
      }

      console.log(
        'PALELU_INGEST_LISTENER_READY=YES'
      );
    } catch (error) {
      console.error(
        `LISTENER_READY_ERROR=${error.message}`
      );

      if (diagnosticOnlyMode) {
        console.error('PALELU_DIAG_FETCH_COMPLETE=NO');
        console.log('MESSAGE_SENT=NO');
        await shutdown('DIAGNOSTIC_ONLY_ERROR');
        process.exit(1);
        return;
      }

      if (syncOnceMode) {
        console.error(
          'ATTENDANCE_SYNC_ONCE=FAIL'
        );

        await shutdown(
          'SYNC_ONCE_READY_ERROR'
        );

        process.exit(1);
        return;
      }
      process.exitCode = 1;
    }
  });

  if (!diagnosticOnlyMode) {
  client.on(
    'message_create',
    message => {
      ingestQueue =
        ingestQueue
          .then(
            () => handleMessage(message)
          )
          .catch(error => {
            console.error(
              `PALELU_INGEST_ERROR=${error.message}`
            );
          });
    }
  );
  }

  client.on(
    'disconnected',
    reason => {
      console.log(
        `WHATSAPP_DISCONNECTED=${reason}`
      );
    }
  );

  process.on(
    'SIGINT',
    async () => {
      await shutdown('SIGINT');
      process.exit(0);
    }
  );

  process.on(
    'SIGTERM',
    async () => {
      await shutdown('SIGTERM');
      process.exit(0);
    }
  );

  console.log(
    'WHATSAPP_INITIALIZE_START=YES'
  );


const conflictMonitorPromise =
    monitorWhatsAppConflictButton(client);

  await client.initialize();

  await conflictMonitorPromise;

  console.log(
    'WHATSAPP_INITIALIZE_RESOLVED=YES'
  );
}

main().catch(async error => {
  console.error(
    `LISTENER_STARTUP_ERROR=${error.message}`
  );

  try {
    await shutdown(
      'STARTUP_ERROR'
    );
  } catch (_) {}

  process.exit(1);
});