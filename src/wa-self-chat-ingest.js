'use strict';

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

// WA_AUTO_ABSENSI_INGEST_REMOTEAUTH_CATCHUP_V1

const {
  INPUT_COLLECTION,
  ensureAttendanceIndexes,
  saveProject,
  saveDocumentation
} = require('./attendance-input-store');

let client = null;
let shuttingDown = false;
let ingestQueue = Promise.resolve();
let readyPipelineStarted = false;

const selfIds = new Set();
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

function serializedId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value._serialized === 'string'
  ) {
    return value._serialized;
  }

  return null;
}

function collectWhatsAppIds(
  value,
  output,
  seen = new WeakSet()
) {
  if (typeof value === 'string') {
    if (
      value.endsWith('@c.us') ||
      value.endsWith('@lid')
    ) {
      output.add(value);
    }

    return;
  }

  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectWhatsAppIds(
        item,
        output,
        seen
      );
    }

    return;
  }

  for (const item of Object.values(value)) {
    collectWhatsAppIds(
      item,
      output,
      seen
    );
  }
}

async function resolveSelfIds() {
  selfIds.clear();

  const primary =
    serializedId(
      client &&
      client.info &&
      client.info.wid
    );

  if (!primary) {
    throw new Error(
      'SELF_PRIMARY_ID_NOT_AVAILABLE'
    );
  }

  selfIds.add(primary);

  if (
    typeof client.getContactLidAndPhone ===
    'function'
  ) {
    try {
      const mapping =
        await client.getContactLidAndPhone(
          [primary]
        );

      collectWhatsAppIds(
        mapping,
        selfIds
      );

      console.log(
        'SELF_LID_RESOLUTION=PASS'
      );
    } catch (error) {
      console.log(
        'SELF_LID_RESOLUTION=BEST_EFFORT_FAIL'
      );
      console.log(
        `SELF_LID_RESOLUTION_ERROR=${error.message}`
      );
    }
  }

  console.log(
    `SELF_ID_CANDIDATE_COUNT=${selfIds.size}`
  );
}

async function isSelfChatMessage(message) {
  if (
    !message ||
    message.fromMe !== true
  ) {
    return false;
  }

  const from =
    serializedId(message.from);

  const to =
    serializedId(message.to);

  if (
    from &&
    to &&
    from === to &&
    selfIds.has(from)
  ) {
    return true;
  }

  if (
    from &&
    to &&
    selfIds.has(from) &&
    selfIds.has(to)
  ) {
    return true;
  }

  try {
    const chat =
      await message.getChat();

    const chatId =
      serializedId(
        chat && chat.id
      );

    return (
      !!chatId &&
      selfIds.has(chatId)
    );
  } catch (_) {
    return false;
  }
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
        source: 'whatsapp-self-chat',
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
    'SELF_CHAT_PROJECT_CAPTURED=YES'
  );

  console.log(
    `PROJECT=${saved.project}`
  );

  console.log(
    `PROJECT_TIMESTAMP=${saved.createdAt.toISOString()}`
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
    'SELF_CHAT_DOCUMENTATION_CAPTURED=YES'
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
  const selfChat =
    await isSelfChatMessage(message);

  if (!selfChat) {
    return;
  }

  const project =
    parseProject(message.body);

  const documentation =
    isDocumentationImage(message);

  if (
    !project &&
    !documentation
  ) {
    return;
  }

  const messageId =
    getMessageId(message);

  if (
    await alreadyPersisted(messageId)
  ) {
    console.log(
      'SELF_CHAT_DUPLICATE_SKIPPED=YES'
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

  if (documentation) {
    await ingestDocumentation(
      message,
      messageId
    );
  }
}

async function startupCatchupSelfChat() {
  console.log(
    'SELF_CHAT_CATCHUP_START=YES'
  );

  const candidateIds =
    Array.from(selfIds)
      .filter(id =>
        typeof id === 'string' &&
        (
          id.endsWith('@c.us') ||
          id.endsWith('@lid')
        )
      );

  console.log(
    `SELF_CHAT_CATCHUP_ID_COUNT=${candidateIds.length}`
  );

  if (candidateIds.length === 0) {
    throw new Error(
      'SELF_CHAT_CATCHUP_NO_SELF_ID'
    );
  }

  const seenMessageIds =
    new Set();

  let successfulChatCount = 0;
  let fetchedCount = 0;
  let relevantCount = 0;

  for (const chatId of candidateIds) {
    let chat = null;

    try {
      chat =
        await client.getChatById(
          chatId
        );
    } catch (error) {
      console.log(
        'SELF_CHAT_CATCHUP_CHAT_LOOKUP=' +
        'BEST_EFFORT_FAIL'
      );

      continue;
    }

    if (
      !chat ||
      typeof chat.fetchMessages !==
        'function'
    ) {
      continue;
    }

    let messages = [];

    try {
      messages =
        await chat.fetchMessages({
          limit: 50
        });
    } catch (error) {
      console.log(
        'SELF_CHAT_CATCHUP_FETCH=' +
        'BEST_EFFORT_FAIL'
      );

      continue;
    }

    successfulChatCount += 1;

    if (!Array.isArray(messages)) {
      continue;
    }

    fetchedCount +=
      messages.length;

    messages.sort(
      (a, b) =>
        Number(
          a && a.timestamp || 0
        ) -
        Number(
          b && b.timestamp || 0
        )
    );

    for (const message of messages) {
      const messageId =
        getMessageId(message);

      if (
        messageId &&
        seenMessageIds.has(messageId)
      ) {
        continue;
      }

      if (messageId) {
        seenMessageIds.add(
          messageId
        );
      }

      const selfChat =
        await isSelfChatMessage(
          message
        );

      if (!selfChat) {
        continue;
      }

      const project =
        parseProject(
          message.body
        );

      const documentation =
        isDocumentationImage(
          message
        );

      if (
        !project &&
        !documentation
      ) {
        continue;
      }

      relevantCount += 1;

      await handleMessage(
        message
      );
    }
  }

  console.log(
    `SELF_CHAT_CATCHUP_CHAT_COUNT=${successfulChatCount}`
  );

  console.log(
    `SELF_CHAT_CATCHUP_FETCHED_COUNT=${fetchedCount}`
  );

  console.log(
    `SELF_CHAT_CATCHUP_RELEVANT_COUNT=${relevantCount}`
  );

  if (successfulChatCount === 0) {
    throw new Error(
      'SELF_CHAT_CATCHUP_CHAT_NOT_FOUND'
    );
  }

  console.log(
    'SELF_CHAT_CATCHUP_COMPLETE=YES'
  );
}
async function startupCatchupSelfChatStable() {
  let successfulSweeps = 0;
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= STARTUP_CATCHUP_MAX_SWEEPS;
    attempt += 1
  ) {
    console.log(
      `SELF_CHAT_CATCHUP_SWEEP=${attempt}`
    );

    try {
      await startupCatchupSelfChat();

      successfulSweeps += 1;

      console.log(
        `SELF_CHAT_CATCHUP_SWEEP_${attempt}=PASS`
      );
    } catch (error) {
      lastError = error;

      console.log(
        `SELF_CHAT_CATCHUP_SWEEP_${attempt}=FAIL`
      );

      console.log(
        'SELF_CHAT_CATCHUP_SWEEP_ERROR=' +
        error.message
      );
    }

    if (
      attempt <
      STARTUP_CATCHUP_MAX_SWEEPS
    ) {
      console.log(
        `SELF_CHAT_CATCHUP_RETRY_WAIT_MS=${STARTUP_CATCHUP_RETRY_MS}`
      );

      await sleep(
        STARTUP_CATCHUP_RETRY_MS
      );
    }
  }

  console.log(
    `SELF_CHAT_CATCHUP_SUCCESSFUL_SWEEPS=${successfulSweeps}`
  );

  if (successfulSweeps === 0) {
    throw (
      lastError ||
      new Error(
        'SELF_CHAT_CATCHUP_ALL_SWEEPS_FAILED'
      )
    );
  }

  console.log(
    'SELF_CHAT_CATCHUP_STABLE=YES'
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

  await ensureAttendanceIndexes(
    mongoose.connection
  );

  console.log(
    'ATTENDANCE_INDEX_READY=YES'
  );

  const remoteDataPath =
    getRemoteAuthDataPath();

  const remoteStore =
    createMongoStore(
      mongoose,
      remoteDataPath
    );

  console.log(
    'AUTH_MODE=REMOTE'
  );

  console.log(
    `REMOTE_AUTH_SESSION=${REMOTE_AUTH_SESSION}`
  );

  client =
    new Client({
      authStrategy:
        createRemoteAuth(
          remoteStore,
          remoteDataPath
        ),

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

      await resolveSelfIds();

      await startupCatchupSelfChatStable();

      console.log(
        'SELF_CHAT_INGEST_LISTENER_READY=YES'
      );
    } catch (error) {
      console.error(
        `LISTENER_READY_ERROR=${error.message}`
      );

      process.exitCode = 1;
    }
  });

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
              `SELF_CHAT_INGEST_ERROR=${error.message}`
            );
          });
    }
  );

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