const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const FETCH_LIMIT = 100;
const DOWNLOAD_DIR = path.join(process.cwd(), 'state', 'downloads');

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

  return `***${left.slice(-4)}@${suffix}`;
}

function getExtFromMime(mime) {
  switch ((mime || '').toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

function isDocImageMessage(msg) {
  if (!msg) return false;

  const body = (msg.body || '').trim().toLowerCase();
  const hasMedia = !!msg.hasMedia;
  const type = (msg.type || '').toLowerCase();

  return hasMedia && type === 'image' && body === 'p';
}

async function finish(client, code) {
  try {
    await client.destroy();
  } catch (_) {}

  process.exit(code);
}

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 2.5');
console.log('READ LATEST DOCUMENTATION IMAGE FROM SELF CHAT');
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
      console.log('STEP_2_5=FAIL');
      return await finish(client, 2);
    }

    console.log('SELF_ID_FOUND=YES');
    console.log(`SELF_ID_MASKED=${maskId(selfId)}`);

    const selfChat = await timeout(
      client.getChatById(selfId),
      30000,
      'SELF_CHAT_LOOKUP'
    );

    if (!selfChat) {
      console.log('SELF_CHAT_FOUND=NO');
      console.log('MESSAGE_SENT_BY_BOT=NO');
      console.log('STEP_2_5=FAIL');
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
      .filter(isDocImageMessage)
      .map(msg => ({
        msg,
        timestamp: Number(msg.timestamp || 0),
        body: (msg.body || '').trim(),
        type: msg.type,
        hasMedia: !!msg.hasMedia
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    console.log(`DOC_IMAGE_CANDIDATE_COUNT=${candidates.length}`);

    if (!candidates.length) {
      console.log('DOC_IMAGE_FOUND=NO');
      console.log('MESSAGE_SENT_BY_BOT=NO');
      console.log('STEP_2_5=FAIL');
      return await finish(client, 4);
    }

    const latest = candidates[0];

    console.log('');
    console.log('DOC_IMAGE_FOUND=YES');
    console.log(`DOC_IMAGE_TYPE=${latest.type}`);
    console.log(`DOC_IMAGE_HAS_MEDIA=${latest.hasMedia}`);
    console.log(`DOC_IMAGE_CAPTION=${latest.body}`);
    console.log(`DOC_IMAGE_TIMESTAMP=${latest.timestamp}`);

    console.log('DOWNLOAD_MEDIA_START=YES');

    const media = await timeout(
      latest.msg.downloadMedia(),
      120000,
      'DOWNLOAD_MEDIA'
    );

    if (!media || !media.data) {
      console.log('DOWNLOAD_MEDIA_SUCCESS=NO');
      console.log('MESSAGE_SENT_BY_BOT=NO');
      console.log('STEP_2_5=FAIL');
      return await finish(client, 5);
    }

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    const ext = getExtFromMime(media.mimetype);
    const outPath = path.join(DOWNLOAD_DIR, `latest-doc-image${ext}`);

    fs.writeFileSync(outPath, Buffer.from(media.data, 'base64'));

    console.log('DOWNLOAD_MEDIA_SUCCESS=YES');
    console.log(`DOWNLOADED_FILE=${outPath}`);
    console.log(`DOWNLOADED_MIMETYPE=${media.mimetype || 'UNKNOWN'}`);
    console.log(`DOWNLOADED_FILESIZE=${fs.statSync(outPath).size}`);
    console.log('MESSAGE_SENT_BY_BOT=NO');
    console.log('STEP_2_5=PASS');

    await finish(client, 0);

  } catch (error) {
    console.error('DOC_IMAGE_READ_ERROR=YES');
    console.error(error);
    console.log('MESSAGE_SENT_BY_BOT=NO');
    await finish(client, 1);
  }
});

client.on('disconnected', reason => {
  console.log(`WHATSAPP_DISCONNECTED=${reason}`);
});

client.initialize();
