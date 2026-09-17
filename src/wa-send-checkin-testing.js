const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const {
  normalizeProjectText,
  buildCheckIn
} = require('./attendance');

const {
  findOutgoingDuplicate
} = require('./duplicate-guard');

const EXPECTED_GROUP_NAME = 'Testing';
const FETCH_LIMIT = 100;

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

  process.exit(code);
}

const targetGroupId = process.env.WA_TARGET_GROUP_ID;

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 3.1');
console.log('SEND CHECK IN - TESTING GROUP ONLY');
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

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'wa-auto-absensi'
  }),

  puppeteer: {
    headless: true,
    protocolTimeout: 120000
  }
});

client.on('qr', qr => {
  console.log('QR_RECEIVED=YES');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('AUTHENTICATED=YES');
});

client.on('auth_failure', async msg => {
  console.error('AUTH_FAILURE=YES');
  console.error(msg);

  await finish(client, 1);
});

client.on('ready', async () => {
  console.log('WHATSAPP_READY=YES');

  try {
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

    const selfId = client.info?.wid?._serialized;

    if (!selfId) {
      console.log('SELF_ID_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 30);
    }

    console.log('SELF_ID_FOUND=YES');

    const selfChat = await timeout(
      client.getChatById(selfId),
      30000,
      'SELF_CHAT_LOOKUP'
    );

    if (!selfChat) {
      console.log('SELF_CHAT_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 31);
    }

    console.log('SELF_CHAT_FOUND=YES');

    const messages = await timeout(
      selfChat.fetchMessages({
        limit: FETCH_LIMIT,
        fromMe: true
      }),
      60000,
      'FETCH_MESSAGES'
    );

    console.log(`FETCHED_MESSAGE_COUNT=${messages.length}`);

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

    const latestProject = projects[0].project;

    console.log('PROJECT_FOUND=YES');
    console.log(`PROJECT=${latestProject}`);

    const message = buildCheckIn({
      project: latestProject,
      date: new Date()
    });

    console.log('');
    console.log('MESSAGE_PREVIEW_BEGIN');
    console.log(message);
    console.log('MESSAGE_PREVIEW_END');
    console.log('');

    console.log('DUPLICATE_CHECK_START=YES');

    const duplicate = await timeout(
      findOutgoingDuplicate(
        targetChat,
        message,
        {
          limit: 100,
          requireMedia: false
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
      console.log('STEP_3_3_CHECKIN=PASS');

      return await finish(client, 0);
    }

    console.log('DUPLICATE_FOUND=NO');
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
    console.log('MESSAGE_SENT=YES');
    console.log('TARGET_GROUP_CONFIRMED=Testing');
    console.log(`SENT_TIMESTAMP=${sent.timestamp || 'UNKNOWN'}`);
    console.log('STEP_4_1D_CHECKIN=PASS');

    await new Promise(resolve => setTimeout(resolve, 3000));

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

client.initialize();
