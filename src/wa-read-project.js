const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

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

function maskId(id) {
  if (!id || typeof id !== 'string') {
    return 'UNKNOWN';
  }

  const [left, suffix] = id.split('@');

  if (!left || !suffix) {
    return 'MASKED';
  }

  const visible = left.slice(-4);

  return `***${visible}@${suffix}`;
}

function parseProject(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const match = body.trim().match(/^p\s*:\s*(.+)$/i);

  if (!match) {
    return null;
  }

  const project = match[1].trim();

  return project.length ? project : null;
}

async function finish(client, code) {
  try {
    await client.destroy();
  } catch (_) {}

  process.exit(code);
}

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 2.4');
console.log('READ LATEST p: FROM SELF CHAT');
console.log('READ ONLY - NO MESSAGE WILL BE SENT');
console.log('============================================================');

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
    const selfId = client.info?.wid?._serialized;

    if (!selfId) {
      console.log('SELF_ID_FOUND=NO');
      console.log('STEP_2_4=FAIL');
      return await finish(client, 2);
    }

    console.log('SELF_ID_FOUND=YES');
    console.log(`SELF_ID_MASKED=${maskId(selfId)}`);

    console.log('SELF_CHAT_LOOKUP_START=YES');

    const selfChat = await timeout(
      client.getChatById(selfId),
      30000,
      'SELF_CHAT_LOOKUP'
    );

    if (!selfChat) {
      console.log('SELF_CHAT_FOUND=NO');
      console.log('MESSAGE_SENT_BY_BOT=NO');
      console.log('STEP_2_4=FAIL');
      return await finish(client, 3);
    }

    console.log('SELF_CHAT_FOUND=YES');
    console.log('FETCH_MESSAGES_START=YES');

    const messages = await timeout(
      selfChat.fetchMessages({
        limit: FETCH_LIMIT,
        fromMe: true
      }),
      60000,
      'FETCH_MESSAGES'
    );

    console.log(`FETCHED_MESSAGE_COUNT=${messages.length}`);

    const candidates = messages
      .map(msg => ({
        project: parseProject(msg.body),
        timestamp: Number(msg.timestamp || 0)
      }))
      .filter(item => item.project)
      .sort((a, b) => b.timestamp - a.timestamp);

    console.log(`PROJECT_CANDIDATE_COUNT=${candidates.length}`);

    if (!candidates.length) {
      console.log('PROJECT_FOUND=NO');
      console.log('MESSAGE_SENT_BY_BOT=NO');
      console.log('STEP_2_4=FAIL');

      return await finish(client, 4);
    }

    const latest = candidates[0];

    console.log('');
    console.log('PROJECT_FOUND=YES');
    console.log(`PROJECT=${latest.project}`);
    console.log(`PROJECT_TIMESTAMP=${latest.timestamp}`);
    console.log('MESSAGE_SENT_BY_BOT=NO');
    console.log('STEP_2_4=PASS');

    await finish(client, 0);

  } catch (error) {
    console.error('PROJECT_READ_ERROR=YES');
    console.error(error);
    console.log('MESSAGE_SENT_BY_BOT=NO');

    await finish(client, 1);
  }
});

client.on('disconnected', reason => {
  console.log(`WHATSAPP_DISCONNECTED=${reason}`);
});

client.initialize();
