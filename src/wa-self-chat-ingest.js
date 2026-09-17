'use strict';

const path = require('path');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');

const {
  Client,
  LocalAuth
} = require('whatsapp-web.js');

const {
  INPUT_COLLECTION,
  ensureAttendanceIndexes,
  saveProject,
  saveDocumentation
} = require('./attendance-input-store');

const CLIENT_ID = 'wa-auto-absensi';

let client = null;
let shuttingDown = false;
let ingestQueue = Promise.resolve();

const selfIds = new Set();
const processedMessageIds = new Set();

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

  const puppeteer = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  };

  if (
    process.env.CHROME_PATH &&
    process.env.CHROME_PATH.trim()
  ) {
    puppeteer.executablePath =
      process.env.CHROME_PATH.trim();
  }

  client =
    new Client({
      authStrategy:
        new LocalAuth({
          clientId: CLIENT_ID
        }),
      puppeteer
    });

  client.on('qr', qr => {
    console.log(
      'QR_REQUIRED=YES'
    );

    qrcode.generate(
      qr,
      {
        small: true
      }
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

      await resolveSelfIds();

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

  await client.initialize();

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