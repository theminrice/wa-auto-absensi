const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PROBE = 'WA_AUTO_ABSENSI_PROBE_170926_02';
const WAIT_MS = 120000;

let finished = false;
let timeoutHandle = null;

function normalizeId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  return value._serialized || value.$1 || null;
}

async function finish(client, code) {
  if (finished) return;
  finished = true;

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  setTimeout(async () => {
    try {
      await client.destroy();
    } catch (_) {}

    process.exit(code);
  }, 1000);
}

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 2.3D');
console.log('LIVE CAPTURE TESTING GROUP');
console.log('READ ONLY - BOT WILL NOT SEND ANY MESSAGE');
console.log('============================================================');

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'wa-auto-absensi'
  }),

  puppeteer: {
    headless: true
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

client.on('ready', () => {
  console.log('WHATSAPP_READY=YES');
  console.log('');
  console.log('WAITING_FOR_PROBE=YES');
  console.log(`PROBE_TEXT=${PROBE}`);
  console.log('');
  console.log('SEKARANG kirim teks di atas secara MANUAL ke grup Testing.');
  console.log('Bot menunggu maksimal 120 detik.');
  console.log('');

  timeoutHandle = setTimeout(async () => {
    console.log('PROBE_CAPTURED=NO');
    console.log('RESULT=TIMEOUT');
    console.log('MESSAGE_SENT_BY_BOT=NO');

    await finish(client, 2);
  }, WAIT_MS);
});

client.on('message_create', async msg => {
  if (finished) return;

  const body = (msg.body || '').trim();

  if (body !== PROBE) {
    return;
  }

  console.log('PROBE_EVENT_RECEIVED=YES');
  console.log(`PROBE_FROM_ME=${msg.fromMe}`);

  if (!msg.fromMe) {
    console.log('PROBE_CAPTURED=NO');
    console.log('REASON=PROBE_NOT_SENT_BY_CURRENT_ACCOUNT');
    return;
  }

  const chatId = normalizeId(msg.to);

  if (!chatId) {
    console.log('PROBE_CAPTURED=NO');
    console.log('REASON=CHAT_ID_MISSING');
    return;
  }

  if (!chatId.endsWith('@g.us')) {
    console.log('PROBE_CAPTURED=NO');
    console.log('REASON=NOT_A_GROUP');
    return;
  }

  console.log('');
  console.log('PROBE_CAPTURED=YES');
  console.log('TARGET_GROUP_FOUND=YES');
  console.log(`TARGET_GROUP_ID=${chatId}`);
  console.log('TARGET_GROUP_EXPECTED=Testing');
  console.log('MESSAGE_SENT_BY_BOT=NO');
  console.log('STEP_2_3D=PASS');

  await finish(client, 0);
});

client.on('disconnected', reason => {
  console.log(`WHATSAPP_DISCONNECTED=${reason}`);
});

client.initialize();
