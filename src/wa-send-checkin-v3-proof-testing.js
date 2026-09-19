const qrcode = require('qrcode-terminal');
const {
  Client,
  LocalAuth
} = require('whatsapp-web.js');

const mongoose = require('mongoose');

const {
  REMOTE_AUTH_V3_ACTIVE_SESSION: REMOTE_AUTH_SESSION,
  REMOTE_AUTH_V3_BACKUP_MS: REMOTE_AUTH_BACKUP_MS,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createRemoteAuthV3
} = require('./remote-auth-v3');
const {
  buildCheckIn
} = require('./attendance');

const {
  getLatestProject
} = require('./attendance-input-store');

const EXPECTED_GROUP_NAME = 'Testing';

// WA_PRODUCTION_V3_CHECKIN_PROOF_TESTING_V1
// WORKFLOW_DISPATCH_ONLY
// EXACT_ONE_CHECKIN_SEND
// NO_AUTOMATIC_RETRY
const E2E_PROOF_MODE = 'TESTING_V3_CHECKIN_PROOF';

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
  if (!id || typeof id !== 'string') return 'UNKNOWN';

  const [left, suffix] = id.split('@');

  if (!left || !suffix) return 'MASKED';

  return `***${left.slice(-5)}@${suffix}`;
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

console.log('E2E_PROOF_MODE=TESTING_V3_CHECKIN_PROOF');
console.log('E2E_PROOF_CHECKIN_SEND_MAX=1');
console.log('E2E_PROOF_AUTOMATIC_RETRY=NO');
console.log('TARGET_GROUP_DISCOVERY_MODE=EXACT_NAME');
console.log(`EXPECTED_GROUP_NAME=${EXPECTED_GROUP_NAME}`);

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

    const remoteV3 =
      createRemoteAuthV3(
        mongoose,
        dataPath
      );

    const store =
      remoteV3.store;

    console.log(
      'MONGO_STORE_READY=YES'
    );

    console.log(
      'REMOTE_AUTH_VERSION=V3'
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
      remoteV3.authStrategy;

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
    console.log('TARGET_GROUP_VERIFY_START=YES');

    const chats = await timeout(
      client.getChats(),
      30000,
      'TARGET_GROUP_LIST'
    );

    const targetMatches = chats.filter(
      chat =>
        chat &&
        chat.isGroup &&
        typeof chat.name === 'string' &&
        chat.name.trim().toLowerCase() ===
          EXPECTED_GROUP_NAME.toLowerCase()
    );

    console.log(
      `TARGET_GROUP_NAME_MATCH_COUNT=${targetMatches.length}`
    );

    const targetChat =
      targetMatches.length === 1
        ? targetMatches[0]
        : null;

    const targetGroupId =
      targetChat?.id?._serialized || '';

    if (targetGroupId) {
      console.log('TARGET_GROUP_ID_FOUND=YES');
      console.log(
        `TARGET_GROUP_ID_MASKED=${maskGroupId(targetGroupId)}`
      );
    } else {
      console.log('TARGET_GROUP_ID_FOUND=NO');
    }

    if (
      targetGroupId &&
      !targetGroupId.endsWith('@g.us')
    ) {
      console.log('TARGET_GROUP_ID_VALID=NO');
      console.log('MESSAGE_SENT=NO');
      return await finish(client, 23);
    }

    if (targetGroupId) {
      console.log('TARGET_GROUP_ID_VALID=YES');
    }

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

    // ATTENDANCE_INPUT_MONGODB_V1
    if (
      mongoose.connection.readyState !== 1
    ) {
      console.log('ATTENDANCE_INPUT_STORE_READY=NO');
      console.log('REASON=MONGODB_CONNECTION_REQUIRED');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 36);
    }

    console.log('ATTENDANCE_INPUT_STORE_READY=YES');

    const latestProjectDocument =
      await timeout(
        getLatestProject(
          mongoose.connection
        ),
        30000,
        'GET_LATEST_PROJECT'
      );

    if (
      !latestProjectDocument ||
      typeof latestProjectDocument.project !== 'string' ||
      !latestProjectDocument.project.trim()
    ) {
      console.log('PROJECT_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 32);
    }

    const latestProject =
      latestProjectDocument.project.trim();

    console.log('PROJECT_FOUND=YES');
    console.log(`PROJECT=${latestProject}`);

    console.log(
      `PROJECT_TIMESTAMP=${
        latestProjectDocument.createdAt instanceof Date
          ? latestProjectDocument.createdAt.toISOString()
          : 'UNKNOWN'
      }`
    );
    const message = buildCheckIn({
      project: latestProject,
      date: new Date()
    });

    console.log('');
    console.log('MESSAGE_PREVIEW_BEGIN');
    console.log(message);
    console.log('MESSAGE_PREVIEW_END');
    console.log('');

    // WA_AUTO_ABSENSI_CHECKIN_NO_DUPLICATE_GUARD_V1
    console.log('CHECKIN_DUPLICATE_GUARD=DISABLED');
    console.log('ACTION=SEND');
    console.log('SEND_START=YES');

    const sent = await timeout(
      client.sendMessage(targetGroupId, message),
      60000,
      'SEND_MESSAGE'
    );

    if (!sent) {
      console.log('MESSAGE_SENT=NO');
      return await finish(client, 40);
    }

    console.log(`ACK_INITIAL=${sent.ack}`);

    const ackDeadline = Date.now() + 30000;
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
      console.log('STEP_4_1D_CHECKIN=FAIL');

      await new Promise(resolve => setTimeout(resolve, 5000));

      return await finish(client, 41);
    }

    console.log('SERVER_ACK_CONFIRMED=YES');

    // WA_AUTO_ABSENSI_CHECKIN_POST_SEND_HOLD_V1
    const postSendHoldTargetMs =
      useRemoteAuth
        ? REMOTE_AUTH_BACKUP_MS + 5000
        : 15000;

    console.log(
      `POST_SEND_HOLD_TARGET_MS=${postSendHoldTargetMs}`
    );

    await new Promise(resolve =>
      setTimeout(
        resolve,
        postSendHoldTargetMs
      )
    );

    console.log('POST_SEND_HOLD_DONE=YES');

    console.log('MESSAGE_SENT=YES');
    console.log('TARGET_GROUP_CONFIRMED=Testing');
    console.log(`SENT_TIMESTAMP=${sent.timestamp || 'UNKNOWN'}`);
    console.log('E2E_PROOF_SERVER_ACK=PASS');
    console.log('E2E_PROOF_TARGET=Testing');
    console.log('E2E_PROOF_CHECKIN=PASS');
    console.log('STEP_PRODUCTION_CHECKIN=PASS');

    await finish(client, 0);

  } catch (error) {
    console.error('CHECKIN_SEND_ERROR=YES');
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