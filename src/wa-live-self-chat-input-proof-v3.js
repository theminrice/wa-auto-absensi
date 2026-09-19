'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const {
  Client,
  MessageMedia
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
  8 * 60 * 1000;

const PROJECT_PROOF_PREFIX =
  '__WA_V3_LIVE_SELFCHAT_PROOF__';

const PROOF_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=';

let client = null;
let finished = false;
let readyStarted = false;

let proofProjectMessage = null;
let proofImageMessage = null;
let proofChat = null;
let proofUniqueProject = '';

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function serializedId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value._serialized ===
    'string'
  ) {
    return value._serialized;
  }

  return null;
}

function collectWhatsAppIds(
  value,
  output,
  seen = new Set()
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

  for (
    const item of
    Object.values(value)
  ) {
    collectWhatsAppIds(
      item,
      output,
      seen
    );
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

async function resolveSelfIds() {
  const ids =
    new Set();

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

  ids.add(primary);

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
        ids
      );

      console.log(
        'LIVE_PROOF_SELF_LID_RESOLUTION=PASS'
      );
    } catch (error) {
      console.log(
        'LIVE_PROOF_SELF_LID_RESOLUTION=BEST_EFFORT_FAIL'
      );

      console.log(
        'LIVE_PROOF_SELF_LID_RESOLUTION_ERROR=' +
        error.message
      );
    }
  }

  console.log(
    `LIVE_PROOF_SELF_ID_CANDIDATE_COUNT=${ids.size}`
  );

  return {
    primary,
    ids
  };
}

async function isSelfChatMessage(
  message,
  selfIds
) {
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
        chat &&
        chat.id
      );

    return (
      !!chatId &&
      selfIds.has(chatId)
    );
  } catch (_) {
    return false;
  }
}

function messageId(message) {
  return (
    message &&
    message.id &&
    typeof message.id._serialized ===
      'string'
      ? message.id._serialized
      : ''
  );
}

async function stableSelfChats(selfIds) {
  const chats = [];
  const seen = new Set();

  for (const chatId of selfIds) {
    if (
      typeof chatId !== 'string' ||
      (
        !chatId.endsWith('@c.us') &&
        !chatId.endsWith('@lid')
      )
    ) {
      continue;
    }

    try {
      const chat =
        await client.getChatById(
          chatId
        );

      const serialized =
        serializedId(
          chat &&
          chat.id
        );

      if (
        chat &&
        serialized &&
        !seen.has(serialized)
      ) {
        seen.add(serialized);
        chats.push(chat);
      }
    } catch (error) {
      console.log(
        'LIVE_PROOF_SELF_CHAT_LOOKUP_BEST_EFFORT_FAIL=YES'
      );
    }
  }

  if (chats.length === 0) {
    throw new Error(
      'LIVE_PROOF_SELF_CHAT_NOT_FOUND'
    );
  }

  return chats;
}

async function recentSelfMessages(
  selfIds,
  limit = 80
) {
  const chats =
    await stableSelfChats(
      selfIds
    );

  const output = [];
  const seen = new Set();

  for (const chat of chats) {
    let messages = [];

    try {
      messages =
        await chat.fetchMessages({
          limit
        });
    } catch (error) {
      continue;
    }

    if (!Array.isArray(messages)) {
      continue;
    }

    for (const message of messages) {
      const id =
        messageId(message);

      if (
        id &&
        seen.has(id)
      ) {
        continue;
      }

      if (id) {
        seen.add(id);
      }

      if (
        await isSelfChatMessage(
          message,
          selfIds
        )
      ) {
        output.push(message);
      }
    }
  }

  return output;
}

async function cleanupStaleProjectProofMessages(
  selfIds
) {
  const messages =
    await recentSelfMessages(
      selfIds,
      100
    );

  const stale =
    messages.filter(
      message =>
        typeof message.body === 'string' &&
        message.body.includes(
          PROJECT_PROOF_PREFIX
        )
    );

  console.log(
    `LIVE_PROOF_STALE_PROJECT_COUNT=${stale.length}`
  );

  for (const message of stale) {
    try {
      await message.delete(
        true,
        true
      );

      console.log(
        'LIVE_PROOF_STALE_PROJECT_REVOKE=PASS'
      );
    } catch (error) {
      console.log(
        'LIVE_PROOF_STALE_PROJECT_REVOKE=FAIL'
      );

      throw error;
    }
  }

  if (stale.length > 0) {
    await sleep(2500);
  }

  const remaining =
    (
      await recentSelfMessages(
        selfIds,
        100
      )
    ).filter(
      message =>
        typeof message.body === 'string' &&
        message.body.includes(
          PROJECT_PROOF_PREFIX
        )
    );

  if (remaining.length !== 0) {
    throw new Error(
      'LIVE_PROOF_STALE_PROJECT_REMAINS'
    );
  }

  console.log(
    'LIVE_PROOF_STALE_CLEANUP=PASS'
  );
}

async function waitForStableClient() {
  await sleep(12000);

  let state = null;

  try {
    state =
      await client.getState();
  } catch (error) {
    console.log(
      'LIVE_PROOF_CLIENT_STATE_1=ERROR'
    );
  }

  console.log(
    `LIVE_PROOF_CLIENT_STATE_1=${state || 'UNKNOWN'}`
  );

  if (state === 'CONNECTED') {
    console.log(
      'LIVE_PROOF_CLIENT_SETTLED=PASS'
    );

    return;
  }

  await sleep(5000);

  state =
    await client.getState();

  console.log(
    `LIVE_PROOF_CLIENT_STATE_2=${state || 'UNKNOWN'}`
  );

  if (state !== 'CONNECTED') {
    throw new Error(
      'LIVE_PROOF_CLIENT_NOT_CONNECTED'
    );
  }

  console.log(
    'LIVE_PROOF_CLIENT_SETTLED=PASS'
  );
}

async function findProjectProofMessage(
  selfIds,
  uniqueProject
) {
  const messages =
    await recentSelfMessages(
      selfIds,
      100
    );

  return (
    messages.find(
      message =>
        parseProject(
          message.body
        ) === uniqueProject
    ) ||
    null
  );
}

function sha256Buffer(buffer) {
  return crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');
}

async function findProofImageMessage(
  selfIds,
  expectedSha256,
  notBeforeMs
) {
  const messages =
    await recentSelfMessages(
      selfIds,
      100
    );

  for (const message of messages) {
    if (
      !isDocumentationImage(
        message
      )
    ) {
      continue;
    }

    const ts =
      Number(
        message &&
        message.timestamp
      );

    if (
      Number.isFinite(ts) &&
      ts * 1000 <
        notBeforeMs - 10000
    ) {
      continue;
    }

    try {
      const media =
        await message.downloadMedia();

      if (
        !media ||
        typeof media.data !== 'string' ||
        !media.data
      ) {
        continue;
      }

      const hash =
        sha256Buffer(
          Buffer.from(
            media.data,
            'base64'
          )
        );

      if (hash === expectedSha256) {
        return message;
      }
    } catch (_) {}
  }

  return null;
}

async function sendProjectAuditAware(
  primary,
  selfIds,
  projectBody,
  uniqueProject
) {
  for (
    let attempt = 1;
    attempt <= 2;
    attempt += 1
  ) {
    console.log(
      `LIVE_PROOF_PROJECT_SEND_ATTEMPT=${attempt}`
    );

    try {
      const sent =
        await client.sendMessage(
          primary,
          projectBody
        );

      if (sent) {
        return sent;
      }
    } catch (error) {
      console.log(
        `LIVE_PROOF_PROJECT_SEND_ATTEMPT_${attempt}_ERROR=${error.message}`
      );
    }

    await sleep(3000);

    const found =
      await findProjectProofMessage(
        selfIds,
        uniqueProject
      );

    if (found) {
      console.log(
        `LIVE_PROOF_PROJECT_SEND_ATTEMPT_${attempt}_RECOVERED_FROM_CHAT=YES`
      );

      return found;
    }

    console.log(
      `LIVE_PROOF_PROJECT_SEND_ATTEMPT_${attempt}_DELIVERED=NO`
    );

    if (attempt === 1) {
      console.log(
        'LIVE_PROOF_PROJECT_AUDIT_GATED_RETRY=YES'
      );

      await sleep(4000);
    }
  }

  throw new Error(
    'LIVE_PROOF_PROJECT_SEND_FAILED_AFTER_AUDIT'
  );
}

async function sendImageAuditAware(
  primary,
  selfIds,
  media,
  expectedSha256
) {
  const startedAtMs =
    Date.now();

  for (
    let attempt = 1;
    attempt <= 2;
    attempt += 1
  ) {
    console.log(
      `LIVE_PROOF_IMAGE_SEND_ATTEMPT=${attempt}`
    );

    try {
      const sent =
        await client.sendMessage(
          primary,
          media,
          {
            caption: 'p'
          }
        );

      if (sent) {
        return sent;
      }
    } catch (error) {
      console.log(
        `LIVE_PROOF_IMAGE_SEND_ATTEMPT_${attempt}_ERROR=${error.message}`
      );
    }

    await sleep(3500);

    const found =
      await findProofImageMessage(
        selfIds,
        expectedSha256,
        startedAtMs
      );

    if (found) {
      console.log(
        `LIVE_PROOF_IMAGE_SEND_ATTEMPT_${attempt}_RECOVERED_FROM_CHAT=YES`
      );

      return found;
    }

    console.log(
      `LIVE_PROOF_IMAGE_SEND_ATTEMPT_${attempt}_DELIVERED=NO`
    );

    if (attempt === 1) {
      console.log(
        'LIVE_PROOF_IMAGE_AUDIT_GATED_RETRY=YES'
      );

      await sleep(4000);
    }
  }

  throw new Error(
    'LIVE_PROOF_IMAGE_SEND_FAILED_AFTER_AUDIT'
  );
}

async function waitForServerAck(
  message,
  label
) {
  const deadline =
    Date.now() + 30000;

  let ack =
    Number(
      message &&
      message.ack != null
        ? message.ack
        : 0
    );

  while (
    Date.now() < deadline &&
    ack < 1
  ) {
    await sleep(1000);

    try {
      await message.reload();

      ack =
        Number(
          message.ack != null
            ? message.ack
            : 0
        );
    } catch (error) {
      console.log(
        `LIVE_PROOF_${label}_ACK_RELOAD_ERROR=${error.message}`
      );
    }
  }

  console.log(
    `LIVE_PROOF_${label}_ACK_FINAL=${ack}`
  );

  if (ack < 1) {
    throw new Error(
      `LIVE_PROOF_${label}_SERVER_ACK_MISSING`
    );
  }

  console.log(
    `LIVE_PROOF_${label}_SERVER_ACK=PASS`
  );
}

async function refreshMessage(
  chat,
  targetId
) {
  const messages =
    await chat.fetchMessages({
      limit: 50
    });

  if (!Array.isArray(messages)) {
    return null;
  }

  return (
    messages.find(
      item =>
        messageId(item) ===
        targetId
    ) ||
    null
  );
}

async function waitUntilProofIsNotParseable(
  chat,
  projectMessageId,
  imageMessageId,
  uniqueProject
) {
  const deadline =
    Date.now() + 30000;

  while (
    Date.now() < deadline
  ) {
    const messages =
      await chat.fetchMessages({
        limit: 50
      });

    const list =
      Array.isArray(messages)
        ? messages
        : [];

    const projectMessage =
      list.find(
        item =>
          messageId(item) ===
          projectMessageId
      ) ||
      null;

    const imageMessage =
      list.find(
        item =>
          messageId(item) ===
          imageMessageId
      ) ||
      null;

    const projectStillParseable =
      Boolean(
        projectMessage &&
        parseProject(
          projectMessage.body
        ) === uniqueProject
      );

    const imageStillParseable =
      Boolean(
        imageMessage &&
        isDocumentationImage(
          imageMessage
        )
      );

    const uniqueProjectStillVisible =
      list.some(
        item =>
          typeof item.body === 'string' &&
          item.body.includes(
            uniqueProject
          )
      );

    if (
      !projectStillParseable &&
      !imageStillParseable &&
      !uniqueProjectStillVisible
    ) {
      console.log(
        'LIVE_PROOF_REVOKE_VISIBILITY=PASS'
      );

      return true;
    }

    await sleep(1500);
  }

  return false;
}

async function deleteProofMessage(
  message,
  label
) {
  try {
    await message.delete(
      true,
      true
    );

    console.log(
      `LIVE_PROOF_${label}_REVOKE_REQUEST=PASS`
    );

    return true;
  } catch (error) {
    console.log(
      `LIVE_PROOF_${label}_REVOKE_REQUEST=FAIL`
    );

    console.log(
      `LIVE_PROOF_${label}_REVOKE_ERROR=${error.message}`
    );

    return false;
  }
}

async function cleanupOutstandingProofMessages() {
  let attempted = false;

  for (const item of [
    ['IMAGE', proofImageMessage],
    ['PROJECT', proofProjectMessage]
  ]) {
    const label = item[0];
    const message = item[1];

    if (!message) {
      continue;
    }

    attempted = true;

    try {
      await message.delete(
        true,
        true
      );

      console.log(
        `LIVE_PROOF_FAILSAFE_${label}_REVOKE=PASS`
      );
    } catch (error) {
      console.log(
        `LIVE_PROOF_FAILSAFE_${label}_REVOKE=FAIL`
      );

      console.log(
        `LIVE_PROOF_FAILSAFE_${label}_REVOKE_ERROR=${error.message}`
      );
    }
  }

  if (
    attempted &&
    proofChat &&
    proofUniqueProject
  ) {
    try {
      const projectId =
        messageId(
          proofProjectMessage
        );

      const imageId =
        messageId(
          proofImageMessage
        );

      const clean =
        await waitUntilProofIsNotParseable(
          proofChat,
          projectId,
          imageId,
          proofUniqueProject
        );

      console.log(
        `LIVE_PROOF_FAILSAFE_REVOKE_VISIBILITY=${clean ? 'PASS' : 'FAIL'}`
      );
    } catch (error) {
      console.log(
        'LIVE_PROOF_FAILSAFE_REVOKE_VISIBILITY=FAIL'
      );

      console.log(
        'LIVE_PROOF_FAILSAFE_REVOKE_VISIBILITY_ERROR=' +
        error.message
      );
    }
  }
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
        'LIVE_PROOF_CLIENT_DESTROYED=YES'
      );
    }
  } catch (error) {
    console.log(
      'LIVE_PROOF_CLIENT_DESTROY_ERROR=' +
      error.message
    );
  }

  try {
    if (
      mongoose.connection.readyState !==
      0
    ) {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    }
  } catch (_) {}

  setTimeout(
    () => process.exit(code),
    300
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
    'WA PRODUCTION V3 LIVE SELF-CHAT INPUT PROOF'
  );

  console.log(
    'REAL SELF-CHAT: p: PROJECT + IMAGE CAPTION p'
  );

  console.log(
    'NO GROUP MESSAGE WILL BE SENT'
  );

  console.log(
    'ATTENDANCE CANONICAL DB WRITE=NO'
  );

  console.log(
    'PROOF MESSAGES WILL BE REVOKED\nAUDIT-GATED RETRY MAX=1 PER SELF-CHAT PROOF'
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
    'LIVE_PROOF_V3_ACTIVE_PRECHECK=PASS'
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
      console.log(
        'LIVE_PROOF_QR_REQUIRED=YES'
      );

      await finish(20);
    }
  );

  client.on(
    'auth_failure',
    async message => {
      console.log(
        'LIVE_PROOF_AUTH_FAILURE=YES'
      );

      console.log(
        'LIVE_PROOF_AUTH_FAILURE_MESSAGE=' +
        message
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
        'LIVE_PROOF_WHATSAPP_READY=YES'
      );

      try {
        const {
          primary,
          ids
        } =
          await resolveSelfIds();

        await cleanupStaleProjectProofMessages(
          ids
        );

        await waitForStableClient();

        const nonce =
          Date.now().toString(36);

        const uniqueProject =
          PROJECT_PROOF_PREFIX +
          nonce;

        const projectBody =
          'p: ' +
          uniqueProject;

        console.log(
          'LIVE_PROOF_PROJECT_SEND_START=YES'
        );

        const sentProject =
          await sendProjectAuditAware(
            primary,
            ids,
            projectBody,
            uniqueProject
          );

        proofProjectMessage =
          sentProject;

        proofUniqueProject =
          uniqueProject;

        if (!sentProject) {
          throw new Error(
            'LIVE_PROOF_PROJECT_SEND_EMPTY'
          );
        }

        const projectId =
          messageId(sentProject);

        if (!projectId) {
          throw new Error(
            'LIVE_PROOF_PROJECT_MESSAGE_ID_MISSING'
          );
        }

        await waitForServerAck(
          sentProject,
          'PROJECT'
        );

        const projectChat =
          await sentProject.getChat();

        proofChat =
          projectChat;

        const projectReloaded =
          await refreshMessage(
            projectChat,
            projectId
          ) ||
          sentProject;

        const projectIsSelf =
          await isSelfChatMessage(
            projectReloaded,
            ids
          );

        if (!projectIsSelf) {
          throw new Error(
            'LIVE_PROOF_PROJECT_NOT_SELF_CHAT'
          );
        }

        const parsedProject =
          parseProject(
            projectReloaded.body
          );

        if (
          parsedProject !==
          uniqueProject
        ) {
          throw new Error(
            'LIVE_PROOF_PROJECT_PARSE_MISMATCH'
          );
        }

        console.log(
          'LIVE_PROOF_PROJECT_SELF_CHAT=PASS'
        );

        console.log(
          'LIVE_PROOF_P_COLON_PARSE=PASS'
        );

        console.log(
          'LIVE_PROOF_PROJECT_MESSAGE_SENT=YES'
        );

        console.log(
          'LIVE_PROOF_IMAGE_SEND_START=YES'
        );

        const proofImageBytes =
          Buffer.from(
            PROOF_PNG_BASE64,
            'base64'
          );

        const proofImageSha256 =
          sha256Buffer(
            proofImageBytes
          );

        console.log(
          `LIVE_PROOF_IMAGE_EXPECTED_SHA256=${proofImageSha256}`
        );

        const media =
          new MessageMedia(
            'image/png',
            PROOF_PNG_BASE64,
            'wa-v3-live-proof.png'
          );

        const sentImage =
          await sendImageAuditAware(
            primary,
            ids,
            media,
            proofImageSha256
          );

        proofImageMessage =
          sentImage;

        if (!sentImage) {
          throw new Error(
            'LIVE_PROOF_IMAGE_SEND_EMPTY'
          );
        }

        const imageId =
          messageId(sentImage);

        if (!imageId) {
          throw new Error(
            'LIVE_PROOF_IMAGE_MESSAGE_ID_MISSING'
          );
        }

        await waitForServerAck(
          sentImage,
          'IMAGE'
        );

        const imageChat =
          await sentImage.getChat();

        const imageReloaded =
          await refreshMessage(
            imageChat,
            imageId
          ) ||
          sentImage;

        const imageIsSelf =
          await isSelfChatMessage(
            imageReloaded,
            ids
          );

        if (!imageIsSelf) {
          throw new Error(
            'LIVE_PROOF_IMAGE_NOT_SELF_CHAT'
          );
        }

        if (
          !isDocumentationImage(
            imageReloaded
          )
        ) {
          throw new Error(
            'LIVE_PROOF_P_IMAGE_PARSE_MISMATCH'
          );
        }

        const downloaded =
          await imageReloaded.downloadMedia();

        if (
          !downloaded ||
          typeof downloaded.data !==
            'string' ||
          !downloaded.data ||
          typeof downloaded.mimetype !==
            'string' ||
          !downloaded.mimetype
            .toLowerCase()
            .startsWith('image/')
        ) {
          throw new Error(
            'LIVE_PROOF_IMAGE_DOWNLOAD_INVALID'
          );
        }

        const downloadedBytes =
          Buffer.from(
            downloaded.data,
            'base64'
          ).length;

        if (
          downloadedBytes <= 0
        ) {
          throw new Error(
            'LIVE_PROOF_IMAGE_DOWNLOAD_EMPTY'
          );
        }

        console.log(
          'LIVE_PROOF_IMAGE_SELF_CHAT=PASS'
        );

        console.log(
          'LIVE_PROOF_P_IMAGE_PARSE=PASS'
        );

        console.log(
          `LIVE_PROOF_IMAGE_DOWNLOAD_BYTES=${downloadedBytes}`
        );

        console.log(
          'LIVE_PROOF_IMAGE_DOWNLOAD=PASS'
        );

        console.log(
          'LIVE_PROOF_IMAGE_MESSAGE_SENT=YES'
        );

        const imageDelete =
          await deleteProofMessage(
            imageReloaded,
            'IMAGE'
          );

        const projectDelete =
          await deleteProofMessage(
            projectReloaded,
            'PROJECT'
          );

        if (
          !imageDelete ||
          !projectDelete
        ) {
          throw new Error(
            'LIVE_PROOF_REVOKE_REQUEST_FAILED'
          );
        }

        const clean =
          await waitUntilProofIsNotParseable(
            projectChat,
            projectId,
            imageId,
            uniqueProject
          );

        if (!clean) {
          throw new Error(
            'LIVE_PROOF_REVOKE_VERIFY_FAILED'
          );
        }

        console.log(
          'LIVE_PROOF_SELF_CHAT_CLEANUP=PASS'
        );

        proofProjectMessage = null;
        proofImageMessage = null;

        console.log(
          'LIVE_PROOF_ATTENDANCE_CANONICAL_DB_WRITE=NO'
        );

        console.log(
          'LIVE_PROOF_GROUP_MESSAGE_SENT=NO'
        );

        console.log(
          'LIVE_PROOF_TOTAL_SELF_CHAT_SENDS=2'
        );

        console.log(
          'LIVE_PROOF_FINAL=PASS'
        );

        await finish(0);
      } catch (error) {
        console.log(
          'LIVE_PROOF_FINAL=FAIL'
        );

        console.log(
          'LIVE_PROOF_ERROR=' +
          error.message
        );

        console.log(
          'LIVE_PROOF_GROUP_MESSAGE_SENT=NO'
        );

        await cleanupOutstandingProofMessages();

        await finish(30);
      }
    }
  );

  console.log(
    'LIVE_PROOF_INITIALIZE_START=YES'
  );

  await client.initialize();

  console.log(
    'LIVE_PROOF_INITIALIZE_RESOLVED=YES'
  );
}

const timer =
  setTimeout(
    async () => {
      console.log(
        'LIVE_PROOF_TIMEOUT=YES'
      );

      await finish(40);
    },
    GLOBAL_TIMEOUT_MS
  );

main()
  .catch(
    async error => {
      console.log(
        'LIVE_PROOF_STARTUP_ERROR=YES'
      );

      console.log(
        'LIVE_PROOF_STARTUP_ERROR_MESSAGE=' +
        error.message
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
