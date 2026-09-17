const qrcode = require('qrcode-terminal');
const {
  Client,
  LocalAuth,
  MessageMedia
} = require('whatsapp-web.js');

const mongoose = require('mongoose');

const {
  REMOTE_AUTH_SESSION,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createMongoStore,
  createRemoteAuth
} = require('./remote-auth');

const {
  normalizeProjectText,
  buildCheckOut
} = require('./attendance');

const {
  findOutgoingDuplicate
} = require('./duplicate-guard');

const EXPECTED_GROUP_NAME = 'Testing';
const FETCH_LIMIT = 100;

// WA_AUTO_ABSENSI_DUAL_AUTH_V1
const useRemoteAuth =
  Boolean(process.env.MONGODB_URI);

function timeout(promise, ms, label) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}_TIMEOUT_${ms}MS`)),
      ms
    );
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timer));
}

function maskGroupId(id) {
  if (!id || typeof id !== 'string') {
    return 'UNKNOWN';
  }

  const [left, suffix] = id.split('@');

  if (!left || !suffix) {
    return 'MASKED';
  }

  return `***${left.slice(-5)}@${suffix}`;
}

function isDocumentationImage(msg) {
  if (!msg) return false;

  const body = (msg.body || '').trim().toLowerCase();
  const type = (msg.type || '').toLowerCase();

  return (
    msg.hasMedia === true &&
    type === 'image' &&
    body === 'p'
  );
}

async function finish(client, code) {
  try {
    await client.destroy();
  } catch (_) {}

  if (
    useRemoteAuth &&
    mongoose.connection.readyState !== 0
  ) {
    try {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    } catch (_) {}
  }

  process.exit(code);
}

const targetGroupId = process.env.WA_TARGET_GROUP_ID;

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 3.2');
console.log('SEND CHECK OUT + DOCUMENTATION IMAGE');
console.log('TESTING GROUP ONLY');
console.log('============================================================');

if (!targetGroupId) {
  console.error('TARGET_GROUP_ID_FOUND=NO');
  console.error('MESSAGE_SENT=NO');
  process.exit(10);
}

if (!targetGroupId.endsWith('@g.us')) {
  console.error('TARGET_GROUP_ID_VALID=NO');
  console.error('MESSAGE_SENT=NO');
  process.exit(11);
}

console.log('TARGET_GROUP_ID_FOUND=YES');
console.log(`TARGET_GROUP_ID_MASKED=${maskGroupId(targetGroupId)}`);

async function main() {
  let authStrategy;
  let puppeteerOptions;

  if (useRemoteAuth) {
    const uri =
      process.env.MONGODB_URI;

    const dataPath =
      getRemoteAuthDataPath();

    await mongoose.connect(
      uri,
      {
        dbName: 'wa_auto_absensi',
        serverSelectionTimeoutMS: 15000
      }
    );

    console.log(
      'MONGODB_CONNECTED=YES'
    );

    const store =
      createMongoStore(
        mongoose,
        dataPath
      );

    console.log(
      'MONGO_STORE_READY=YES'
    );

    const remoteSessionExists =
      await store.sessionExists({
        session:
          REMOTE_AUTH_SESSION
      });

    console.log(
      `REMOTE_SESSION_EXISTS_BEFORE=${
        remoteSessionExists ? 'YES' : 'NO'
      }`
    );

    if (!remoteSessionExists) {
      throw new Error(
        'REMOTE_SESSION_MISSING'
      );
    }

    authStrategy =
      createRemoteAuth(
        store,
        dataPath
      );

    puppeteerOptions =
      getPuppeteerOptions();

    console.log(
      'AUTH_MODE=REMOTE'
    );
  }
  else {
    authStrategy =
      new LocalAuth({
        clientId:
          'wa-auto-absensi'
      });

    puppeteerOptions = {
      headless: true,
      protocolTimeout: 120000
    };

    console.log(
      'AUTH_MODE=LOCAL'
    );
  }

  const client =
    new Client({
      authStrategy,
      puppeteer:
        puppeteerOptions
    });

  client.on('qr', async qr => {
    console.log(
      'QR_RECEIVED=YES'
    );

    if (useRemoteAuth) {
      console.log(
        'REMOTE_AUTH_QR_FORBIDDEN=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(
        client,
        20
      );

      return;
    }

    qrcode.generate(
      qr,
      { small: true }
    );
  });

client.on('authenticated', () => {
  console.log('AUTHENTICATED=YES');
});

client.on('auth_failure', async msg => {
  console.error('AUTH_FAILURE=YES');
  console.error(msg);

  await finish(client, 1);
});

let attendanceReadyStarted = false;

// SIGASSPOL_READY_REENTRY_GUARD_V1
client.on('ready', async () => {
  if (attendanceReadyStarted) {
    console.log('READY_REENTRY_IGNORED=YES');
    return;
  }

  attendanceReadyStarted = true;

  console.log('WHATSAPP_READY=YES');

// REMOTE_POST_READY_SETTLE_V1
if (process.env.MONGODB_URI) {
  const remoteSettleMs = 15000;

  console.log(`REMOTE_POST_READY_SETTLE_MS=${remoteSettleMs}`);

  await new Promise(resolve =>
    setTimeout(resolve, remoteSettleMs)
  );

  console.log('REMOTE_POST_READY_SETTLE_DONE=YES');
}

  try {

    // ========================================================
    // 1. VERIFY TARGET = TESTING
    // ========================================================

    console.log('TARGET_GROUP_VERIFY_START=YES');

    const targetChat = await timeout(
      client.getChatById(targetGroupId),
      30000,
      'TARGET_GROUP_LOOKUP'
    );

    if (!targetChat) {
      console.log('TARGET_GROUP_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 20);
    }

    console.log('TARGET_GROUP_FOUND=YES');
    console.log(`TARGET_GROUP_NAME=${targetChat.name}`);
    console.log(`TARGET_GROUP_IS_GROUP=${targetChat.isGroup}`);

    if (!targetChat.isGroup) {
      console.log('TARGET_GROUP_SAFE=NO');
      console.log('REASON=TARGET_IS_NOT_GROUP');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 21);
    }

    if (
      typeof targetChat.name !== 'string' ||
      targetChat.name.trim().toLowerCase() !==
        EXPECTED_GROUP_NAME.toLowerCase()
    ) {
      console.log('TARGET_GROUP_SAFE=NO');
      console.log('REASON=GROUP_NAME_MISMATCH');
      console.log(`EXPECTED_GROUP_NAME=${EXPECTED_GROUP_NAME}`);
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 22);
    }

    console.log('TARGET_GROUP_SAFE=YES');

    // ========================================================
    // 2. READ SELF CHAT
    // ========================================================

    const selfId = client.info?.wid?._serialized;

    if (!selfId) {
      console.log('SELF_ID_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 30);
    }

    console.log('SELF_ID_FOUND=YES');

    let selfChat = null;
    let activeSelfChatId = selfId;

    // SELF_CHAT_LID_RESOLVER_V1
    if (
      process.env.MONGODB_URI &&
      typeof client.getContactLidAndPhone === 'function'
    ) {
      try {
        const mappings = await timeout(
          client.getContactLidAndPhone([selfId]),
          30000,
          'SELF_LID_LOOKUP'
        );

        const candidateIds = [selfId];

        for (const mapping of mappings || []) {
          const lid = mapping && mapping.lid;

          if (
            typeof lid === 'string' &&
            lid.endsWith('@lid') &&
            !candidateIds.includes(lid)
          ) {
            candidateIds.push(lid);
          }
        }

        console.log(
          `SELF_CHAT_ID_CANDIDATE_COUNT=${candidateIds.length}`
        );

        let selectedActivity = -1;

        for (const candidateId of candidateIds) {
          const candidateServer =
            String(candidateId).split('@')[1] || 'unknown';

          try {
            const candidateChat = await timeout(
              client.getChatById(candidateId),
              30000,
              'SELF_CHAT_CANDIDATE_LOOKUP'
            );

            if (!candidateChat) {
              console.log(
                `SELF_CHAT_CANDIDATE_${candidateServer}=NOT_FOUND`
              );

              continue;
            }

            const candidateMessages = await timeout(
              candidateChat.fetchMessages({
                limit: FETCH_LIMIT,
                fromMe: true
              }),
              60000,
              'SELF_CHAT_CANDIDATE_FETCH'
            );

            const chatTimestamp =
              Number(candidateChat.timestamp || 0);

            const maxMessageTimestamp =
              candidateMessages.reduce(
                (maxTimestamp, msg) =>
                  Math.max(
                    maxTimestamp,
                    Number(msg.timestamp || 0)
                  ),
                0
              );

            const activity =
              Math.max(
                chatTimestamp,
                maxMessageTimestamp
              );

            console.log(
              `SELF_CHAT_CANDIDATE_SERVER=${candidateServer}`
            );

            console.log(
              `SELF_CHAT_CANDIDATE_MESSAGE_COUNT=${candidateMessages.length}`
            );

            console.log(
              `SELF_CHAT_CANDIDATE_ACTIVITY=${activity}`
            );

            if (activity > selectedActivity) {
              selectedActivity = activity;
              selfChat = candidateChat;
              activeSelfChatId = candidateId;
            }
          } catch (error) {
            const candidateError =
              error && error.message
                ? error.message
                : String(error);

            console.log(
              `SELF_CHAT_CANDIDATE_${candidateServer}=ERROR`
            );

            console.log(
              `SELF_CHAT_CANDIDATE_ERROR=${candidateError}`
            );
          }
        }

        if (selfChat) {
          const selectedServer =
            String(activeSelfChatId).split('@')[1] ||
            'unknown';

          console.log(
            `SELF_CHAT_SELECTED_SERVER=${selectedServer}`
          );

          console.log(
            `SELF_CHAT_SELECTED_ACTIVITY=${selectedActivity}`
          );
        }
      } catch (error) {
        const lidError =
          error && error.message
            ? error.message
            : String(error);

        console.log(
          'SELF_LID_LOOKUP_RESULT=ERROR'
        );

        console.log(
          `SELF_LID_LOOKUP_ERROR=${lidError}`
        );
      }
    }

    if (!selfChat) {
      selfChat = await timeout(
        client.getChatById(activeSelfChatId),
        30000,
        'SELF_CHAT_LOOKUP'
      );
    }

    if (!selfChat) {
      console.log('SELF_CHAT_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 31);
    }

    console.log('SELF_CHAT_FOUND=YES');

    console.log(
      `SELF_CHAT_ACTIVE_SERVER=${
        String(activeSelfChatId).split('@')[1] ||
        'unknown'
      }`
    );

    let messages;

    // SELF_CHAT_FRESHNESS_GATE_V1
    if (process.env.MONGODB_URI) {
      const freshnessAttempts = 6;
      const freshnessPollMs = 5000;

      let refreshedSelfChat = selfChat;
      let selfChatFresh = false;

      console.log('SELF_CHAT_FRESHNESS_GATE=REMOTE');

      for (
        let attempt = 1;
        attempt <= freshnessAttempts;
        attempt += 1
      ) {
        console.log(
          `SELF_CHAT_FRESHNESS_ATTEMPT=${attempt}`
        );

        try {
          const syncResult = await timeout(
            refreshedSelfChat.syncHistory(),
            10000,
            'SELF_CHAT_SYNC_HISTORY'
          );

          console.log(
            `SELF_CHAT_SYNC_HISTORY_RESULT=${syncResult}`
          );
        } catch (error) {
          const syncError =
            error && error.message
              ? error.message
              : String(error);

          console.log(
            'SELF_CHAT_SYNC_HISTORY_RESULT=ERROR'
          );

          console.log(
            `SELF_CHAT_SYNC_HISTORY_ERROR=${syncError}`
          );
        }

        refreshedSelfChat = await timeout(
          client.getChatById(activeSelfChatId),
          30000,
          'SELF_CHAT_REFRESH'
        );

        if (!refreshedSelfChat) {
          console.log(
            'SELF_CHAT_REFRESH_FOUND=NO'
          );

          if (attempt < freshnessAttempts) {
            await new Promise(resolve =>
              setTimeout(resolve, freshnessPollMs)
            );
          }

          continue;
        }

        console.log(
          'SELF_CHAT_REFRESH_FOUND=YES'
        );

        messages = await timeout(
          refreshedSelfChat.fetchMessages({
            limit: FETCH_LIMIT,
            fromMe: true
          }),
          60000,
          'FETCH_MESSAGES'
        );

        const chatTimestamp =
          Number(refreshedSelfChat.timestamp || 0);

        const maxMessageTimestamp =
          messages.reduce(
            (maxTimestamp, msg) =>
              Math.max(
                maxTimestamp,
                Number(msg.timestamp || 0)
              ),
            0
          );

        console.log(
          `FETCHED_MESSAGE_COUNT=${messages.length}`
        );

        console.log(
          `SELF_CHAT_TIMESTAMP=${chatTimestamp}`
        );

        console.log(
          `SELF_CHAT_MAX_FETCHED_TIMESTAMP=${maxMessageTimestamp}`
        );

        if (
          chatTimestamp > 0 &&
          maxMessageTimestamp >= chatTimestamp
        ) {
          selfChatFresh = true;

          console.log(
            'SELF_CHAT_FRESHNESS=PASS'
          );

          break;
        }

        console.log(
          'SELF_CHAT_FRESHNESS=STALE'
        );

        if (attempt < freshnessAttempts) {
          await new Promise(resolve =>
            setTimeout(resolve, freshnessPollMs)
          );
        }
      }

      if (!selfChatFresh) {
        console.log(
          'SELF_CHAT_FRESHNESS=FAIL'
        );

        console.log(
          'REASON=SELF_CHAT_HISTORY_NOT_CAUGHT_UP'
        );

        console.log(
          'MESSAGE_SENT=NO'
        );

        return await finish(client, 35);
      }
    } else {
      messages = await timeout(
        selfChat.fetchMessages({
          limit: FETCH_LIMIT,
          fromMe: true
        }),
        60000,
        'FETCH_MESSAGES'
      );

      console.log(
        `FETCHED_MESSAGE_COUNT=${messages.length}`
      );
    }

    // ========================================================
    // 3. FIND LATEST PROJECT p:
    // ========================================================

    const projects = messages
      .map(msg => ({
        project: normalizeProjectText(msg.body),
        timestamp: Number(msg.timestamp || 0)
      }))
      .filter(item => item.project)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (!projects.length) {
      console.log('PROJECT_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 32);
    }

    const latestProject = projects[0];

    console.log('PROJECT_FOUND=YES');
    console.log(`PROJECT=${latestProject.project}`);
    console.log(`PROJECT_TIMESTAMP=${latestProject.timestamp}`);

    // ========================================================
    // 4. FIND DOCUMENTATION IMAGE AFTER PROJECT
    // ========================================================

    const imageCandidates = messages
      .filter(isDocumentationImage)
      .map(msg => ({
        msg,
        timestamp: Number(msg.timestamp || 0)
      }))
      .filter(item =>
        item.timestamp >= latestProject.timestamp
      )
      .sort((a, b) => b.timestamp - a.timestamp);

    console.log(
      `DOC_IMAGE_AFTER_PROJECT_COUNT=${imageCandidates.length}`
    );

    if (!imageCandidates.length) {
      console.log('DOC_IMAGE_FOUND=NO');
      console.log('REASON=NO_IMAGE_p_AFTER_LATEST_PROJECT');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 33);
    }

    const latestImage = imageCandidates[0];

    console.log('DOC_IMAGE_FOUND=YES');
    console.log(`DOC_IMAGE_TIMESTAMP=${latestImage.timestamp}`);
    console.log('DOC_IMAGE_PAIR_VALID=YES');

    // ========================================================
    // 5. DOWNLOAD DOCUMENTATION
    // ========================================================

    console.log('DOWNLOAD_MEDIA_START=YES');

    const downloaded = await timeout(
      latestImage.msg.downloadMedia(),
      120000,
      'DOWNLOAD_MEDIA'
    );

    if (!downloaded || !downloaded.data) {
      console.log('DOWNLOAD_MEDIA_SUCCESS=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 34);
    }

    console.log('DOWNLOAD_MEDIA_SUCCESS=YES');
    console.log(
      `DOCUMENTATION_MIMETYPE=${downloaded.mimetype || 'UNKNOWN'}`
    );

    if (
      typeof downloaded.mimetype !== 'string' ||
      !downloaded.mimetype.startsWith('image/')
    ) {
      console.log('DOCUMENTATION_VALID_IMAGE=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 35);
    }

    console.log('DOCUMENTATION_VALID_IMAGE=YES');

    // ========================================================
    // 6. BUILD CHECK OUT CAPTION
    // ========================================================

    const caption = buildCheckOut({
      project: latestProject.project,
      date: new Date()
    });

    console.log('');
    console.log('CAPTION_PREVIEW_BEGIN');
    console.log(caption);
    console.log('CAPTION_PREVIEW_END');
    console.log('');

    // ========================================================
    // 7. PREPARE IMAGE
    // ========================================================

    const media = new MessageMedia(
      downloaded.mimetype,
      downloaded.data,
      downloaded.filename || 'dokumentasi.jpg'
    );

    // ========================================================
    // 8. SEND IMAGE + CAPTION TO TESTING
    // ========================================================

    console.log('DUPLICATE_CHECK_START=YES');

    const duplicate = await timeout(
      findOutgoingDuplicate(
        targetChat,
        caption,
        {
          limit: 100,
          requireMedia: true
        }
      ),
      60000,
      'DUPLICATE_CHECK'
    );

    console.log(`DUPLICATE_CHECKED_COUNT=${duplicate.checked}`);

    if (duplicate.found) {
      console.log('DUPLICATE_FOUND=YES');
      console.log('ACTION=SKIP');
      console.log('MESSAGE_SENT=NO');
      console.log('STEP_3_3_CHECKOUT=PASS');

      return await finish(client, 0);
    }

    console.log('DUPLICATE_FOUND=NO');
    console.log('SEND_START=YES');

    const sent = await timeout(
      client.sendMessage(
        targetGroupId,
        media,
        {
          caption
        }
      ),
      120000,
      'SEND_CHECKOUT'
    );

    if (!sent) {
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 40);
    }

    console.log(`ACK_INITIAL=${sent.ack}`);

    const ackDeadline = Date.now() + 45000;
    let ack = Number(sent.ack ?? 0);

    while (Date.now() < ackDeadline && ack < 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const reloaded = await sent.reload();

        if (!reloaded) {
          console.log('MESSAGE_RELOAD=NULL');
          continue;
        }

        ack = Number(sent.ack ?? 0);
        console.log(`ACK_CURRENT=${ack}`);

      } catch (error) {
        console.log(`MESSAGE_RELOAD_ERROR=${error.message}`);
      }
    }

    console.log(`ACK_FINAL=${ack}`);

    if (ack < 1) {
      console.log('SERVER_ACK_CONFIRMED=NO');
      console.log('MESSAGE_SENT=NO');
      console.log('MEDIA_SENT=UNKNOWN');
      console.log('CAPTION_SENT=UNKNOWN');
      console.log('STEP_4_1E_CHECKOUT=FAIL');

      await new Promise(resolve => setTimeout(resolve, 5000));

      return await finish(client, 41);
    }

    console.log('SERVER_ACK_CONFIRMED=YES');
    console.log('MESSAGE_SENT=YES');
    console.log('MEDIA_SENT=YES');
    console.log('CAPTION_SENT=YES');
    console.log('TARGET_GROUP_CONFIRMED=Testing');
    console.log(`SENT_TIMESTAMP=${sent.timestamp || 'UNKNOWN'}`);
    console.log('STEP_4_1E_CHECKOUT=PASS');

    await new Promise(resolve => setTimeout(resolve, 3000));

    await finish(client, 0);

  } catch (error) {
    console.error('CHECKOUT_SEND_ERROR=YES');
    console.error(error);
    console.log('MESSAGE_SENT=UNKNOWN');

    await finish(client, 1);
  }
});

client.on('disconnected', reason => {
  console.log(`WHATSAPP_DISCONNECTED=${reason}`);
});
  await client.initialize();
}

main().catch(async error => {
  console.error(
    'SENDER_STARTUP_ERROR=YES'
  );

  console.error(error);

  console.log(
    'MESSAGE_SENT=NO'
  );

  if (
    useRemoteAuth &&
    mongoose.connection.readyState !== 0
  ) {
    try {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    } catch (_) {}
  }

  process.exit(1);
});