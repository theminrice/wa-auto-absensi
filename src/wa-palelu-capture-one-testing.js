'use strict';

// PALELU_ONE_PHOTO_CAPTURE_TESTING_V1
// One user-sent, newly created Palelu image captioned "p" -> existing
// canonical attendance GridFS storage. No WA sending and no project/leave writes.
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { Client } = require('whatsapp-web.js');
const { findPaleluGroup, isPaleluMessage } =
  require('./attendance-input-group');
const {
  INPUT_COLLECTION,
  saveDocumentation,
  downloadDocumentation
} = require('./attendance-input-store');
const {
  isCheckoutDocumentationCurrentDay
} = require('./attendance-documentation-freshness');
const {
  createRemoteAuthV3,
  getRemoteAuthDataPath,
  getPuppeteerOptions
} = require('./remote-auth-v3');

const GROUP_FINGERPRINT = 'f9983bb6e244b1ca';
const GROUP_CREATION_TIMESTAMP = 1781792754;
const CAPTURE_WINDOW_MS = 180000;
const READY_TIMEOUT_MS = 120000;
const SETTLE_MS = 15000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
let client = null;
let success = false;
let shuttingDown = false;

function dateOfMessage(message) {
  const stamp = Number(message && message.timestamp);
  return Number.isFinite(stamp) && stamp > 0
    ? new Date(stamp * 1000) : new Date(NaN);
}

function isDocumentation(message) {
  return Boolean(message && message.fromMe === true &&
    message.hasMedia === true &&
    message.type === 'image' &&
    typeof message.body === 'string' &&
    message.body.trim().toLowerCase() === 'p');
}

function groupFingerprint(id) {
  return crypto.createHash('sha256')
    .update(id).digest('hex').slice(0, 16);
}

function extension(mime) {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic'
  };
  return extensions[mime] || '.img';
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (client) await client.destroy();
  } catch (_) {
    console.log('PALELU_CAPTURE_CLIENT_CLEANUP=FAILED');
  }
  try {
    await mongoose.disconnect();
  } catch (_) {
    console.log('PALELU_CAPTURE_DB_CLEANUP=FAILED');
  }
}

async function captureOne(groupId) {
  const collection = mongoose.connection.db.collection(INPUT_COLLECTION);
  let processing = false;
  let completed = false;
  let timeoutId;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const finish = error => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutId);
      client.removeListener('message_create', onMessage);
      if (error) reject(error);
      else resolve();
    };

    const onMessage = async message => {
      if (completed || processing || !isDocumentation(message)) return;
      try {
        if (!(await isPaleluMessage(message, groupId))) return;
        if (completed || processing) return;

        const createdAt = dateOfMessage(message);
        const stamp = createdAt.getTime();
        const now = Date.now();
        if (!Number.isFinite(stamp) ||
            stamp < startedAt - 30000 ||
            stamp > now + 5 * 60000 ||
            !isCheckoutDocumentationCurrentDay(createdAt, new Date(now))) {
          console.log('PALELU_CAPTURE_NEW_TODAY_IMAGE=NO');
          return;
        }

        processing = true;
        clearTimeout(timeoutId);
        console.log('PALELU_CAPTURE_NEW_TODAY_IMAGE=YES');

        const messageId = message.id && message.id._serialized;
        if (typeof messageId !== 'string' || !messageId) {
          throw new Error('CAPTURE_MESSAGE_ID_MISSING');
        }

        const current = await collection.findOne(
          { kind: 'documentation' },
          { sort: { createdAt: -1, _id: -1 },
            projection: { _id: 1, createdAt: 1, sourceMessageId: 1 } }
        );
        if (current && current.sourceMessageId === messageId) {
          throw new Error('CAPTURE_ALREADY_PERSISTED');
        }
        if (current && current.createdAt &&
            !(createdAt.getTime() > new Date(current.createdAt).getTime())) {
          throw new Error('CAPTURE_NOT_NEWER_THAN_CANONICAL');
        }

        // Download only after the group, author, caption, freshness and
        // canonical-recency checks. No media bytes are written to logs.
        console.log('PALELU_CAPTURE_DOWNLOAD_START=YES');
        const media = await message.downloadMedia();
        if (!media || typeof media.data !== 'string' || !media.data) {
          throw new Error('CAPTURE_MEDIA_DOWNLOAD_EMPTY');
        }
        const mime = String(media.mimetype || '')
          .split(';')[0].trim().toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp',
              'image/gif', 'image/heic'].includes(mime)) {
          throw new Error('CAPTURE_UNSUPPORTED_IMAGE');
        }
        const buffer = Buffer.from(media.data, 'base64');
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
          throw new Error('CAPTURE_IMAGE_SIZE_INVALID');
        }
        console.log('PALELU_CAPTURE_DOWNLOAD=PASS');

        const filename = media.filename && String(media.filename).trim()
          ? path.basename(String(media.filename).trim())
          : 'palelu-' + createdAt.getTime() + extension(mime);

        // This existing function REPLACES the canonical documentation and
        // its GridFS file, rather than adding a separate Testing-only row.
        const saved = await saveDocumentation(mongoose.connection, {
          buffer,
          filename,
          mimetype: mime,
          createdAt
        });

        const marked = await collection.updateOne(
          { _id: saved._id, fileId: saved.fileId },
          { $set: {
            source: 'whatsapp-palelu-group',
            sourceMessageId: messageId
          } }
        );
        if (marked.matchedCount !== 1) {
          throw new Error('CAPTURE_SOURCE_MARK_FAILED');
        }

        const stored = await collection.findOne({
          _id: saved._id,
          kind: 'documentation',
          fileId: saved.fileId,
          sourceMessageId: messageId
        });
        if (!stored ||
            new Date(stored.createdAt).getTime() !== createdAt.getTime() ||
            stored.size !== buffer.length || stored.mimetype !== mime) {
          throw new Error('CAPTURE_METADATA_READBACK_FAILED');
        }
        const retrieved = await downloadDocumentation(
          mongoose.connection, stored
        );
        const wanted = crypto.createHash('sha256')
          .update(buffer).digest('hex');
        const actual = crypto.createHash('sha256')
          .update(retrieved).digest('hex');
        if (wanted !== actual) {
          throw new Error('CAPTURE_GRIDFS_READBACK_MISMATCH');
        }

        console.log('PALELU_CAPTURE_READBACK=PASS');
        console.log('DOCUMENTATION_TIMESTAMP=' +
          createdAt.toISOString());
        console.log('DOCUMENTATION_SIZE=' + buffer.length);
        console.log('PALELU_CAPTURE_STORED=YES');
        success = true;
        finish(null);
      } catch (error) {
        if (!completed) {
          console.log('PALELU_CAPTURE_ERROR_CODE=' +
            String(error && error.message || 'UNKNOWN')
              .replace(/[^A-Z0-9_]/g, ''));
          finish(new Error('CAPTURE_ONE_FAILED'));
        }
      }
    };

    // V7 proved this event works when listener is registered before user
    // sends. No catchup, search, syncHistory or sendMessage calls here.
    client.on('message_create', onMessage);
    timeoutId = setTimeout(
      () => finish(new Error('CAPTURE_WINDOW_TIMEOUT')),
      CAPTURE_WINDOW_MS
    );
    console.log('PALELU_CAPTURE_READY=YES');
    console.log('PALELU_CAPTURE_WAIT_SECONDS=180');
    console.log('PALELU_CAPTURE_USER_ACTION=SEND_ONE_NEW_PHOTO_CAPTION_P');
  });
}

async function main() {
  if (process.argv.includes('--sync-once')) {
    throw new Error('CAPTURE_SYNC_ONCE_FORBIDDEN');
  }
  if (process.env.PALELU_CAPTURE_CONFIRM !== 'Capture-Palelu-Photo') {
    throw new Error('CAPTURE_EXPLICIT_CONFIRM_REQUIRED');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI_MISSING');
  }

  console.log('PALELU_CAPTURE_TESTING_MODE=YES');
  console.log('MESSAGE_SENT=NO');
  console.log('PALELU_CAPTURE_MAX_DOCUMENTATION_WRITES=ONE');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });
  await mongoose.connection.db.command({ ping: 1 });
  console.log('MONGODB_PING=PASS');

  const remote = createRemoteAuthV3(mongoose, getRemoteAuthDataPath());
  await remote.store.verifyActiveSnapshot();
  remote.store.save = async () => {
    console.log('PALELU_CAPTURE_REMOTE_SAVE=SKIPPED');
  };
  remote.store.delete = async () => {
    throw new Error('PALELU_CAPTURE_REMOTE_DELETE_FORBIDDEN');
  };
  console.log('PALELU_CAPTURE_REMOTE_AUTH_WRITE=DISABLED');

  client = new Client({
    authStrategy: remote.authStrategy,
    puppeteer: getPuppeteerOptions()
  });

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readyStarted = false;
  client.on('qr', () => {
    console.log('PALELU_CAPTURE_QR_FORBIDDEN=YES');
    rejectReady(new Error('CAPTURE_QR_FORBIDDEN'));
  });
  client.on('disconnected', () => {
    console.log('PALELU_CAPTURE_DISCONNECTED=YES');
    rejectReady(new Error('CAPTURE_DISCONNECTED'));
  });
  client.on('ready', async () => {
    if (readyStarted) return;
    readyStarted = true;
    try {
      console.log('WHATSAPP_READY=YES');
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      const chats = await client.getChats();
      const selected = findPaleluGroup(chats);
      const fingerprint = groupFingerprint(selected.id);
      const created = Number(
        selected.group && selected.group.groupMetadata &&
        selected.group.groupMetadata.creation || 0
      );
      if (fingerprint !== GROUP_FINGERPRINT ||
          created !== GROUP_CREATION_TIMESTAMP) {
        throw new Error('CAPTURE_GROUP_IDENTITY_MISMATCH');
      }
      console.log('PALELU_CAPTURE_GROUP_IDENTITY=PASS');
      resolveReady(selected.id);
    } catch (error) {
      rejectReady(error);
    }
  });

  const timeout = setTimeout(
    () => rejectReady(new Error('CAPTURE_READY_TIMEOUT')),
    READY_TIMEOUT_MS
  );
  try {
    // The active RemoteAuth snapshot was verified; never delete/replace it.
    const initialize = client.initialize();
    const groupId = await ready;
    clearTimeout(timeout);
    const capture = captureOne(groupId);
    await initialize;
    await capture;
  } finally {
    clearTimeout(timeout);
  }
}

main()
  .catch(error => {
    console.log('PALELU_CAPTURE_FINAL_ERROR=' +
      String(error && error.message || 'UNKNOWN')
        .replace(/[^A-Z0-9_]/g, ''));
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    console.log('MESSAGE_SENT=NO');
    console.log('PALELU_CAPTURE_FINAL=' +
      (success ? 'PASS' : 'FAIL'));
    process.exit(process.exitCode || (success ? 0 : 1));
  });
