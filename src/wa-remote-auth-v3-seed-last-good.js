'use strict';

const mongoose = require('mongoose');

const {
  createRemoteAuthV3,
  getRemoteAuthDataPath,
  REMOTE_AUTH_V3_ACTIVE_SESSION,
  REMOTE_AUTH_V3_LAST_GOOD_SESSION
} = require('./remote-auth-v3');

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI_MISSING');
  }

  console.log('WA AUTO ABSENSI - REMOTEAUTH V3 SEED LAST-GOOD');
  console.log('NO WHATSAPP MESSAGE WILL BE SENT');

  await mongoose.connect(
    MONGODB_URI,
    {
      dbName: 'wa_auto_absensi',
      serverSelectionTimeoutMS: 30000
    }
  );

  console.log('MONGODB_CONNECTED=YES');

  const {
    store
  } = createRemoteAuthV3(
    mongoose,
    getRemoteAuthDataPath()
  );

  const activeExists =
    await store.sessionExists({
      session: REMOTE_AUTH_V3_ACTIVE_SESSION
    });

  console.log(
    `REMOTE_V3_ACTIVE_EXISTS_BEFORE_SEED=${activeExists ? 'YES' : 'NO'}`
  );

  if (!activeExists) {
    throw new Error('REMOTE_V3_ACTIVE_MISSING');
  }

  await store.verifyActiveSnapshot();

  console.log('REMOTE_V3_ACTIVE_VERIFY_BEFORE_SEED=PASS');

  await store.seedLastGoodFromActive();

  const lastGoodExists =
    await store.sessionExists({
      session: REMOTE_AUTH_V3_LAST_GOOD_SESSION
    });

  console.log(
    `REMOTE_V3_LAST_GOOD_EXISTS_AFTER_SEED=${lastGoodExists ? 'YES' : 'NO'}`
  );

  if (!lastGoodExists) {
    throw new Error('REMOTE_V3_LAST_GOOD_SEED_MISSING');
  }

  console.log('REMOTE_V3_LAST_GOOD_SEED_WORKFLOW=PASS');
  console.log('MESSAGE_SENT=NO');

  await mongoose.disconnect();

  console.log('MONGOOSE_DISCONNECTED=YES');
}

main().catch(async error => {
  console.log('REMOTE_V3_LAST_GOOD_SEED_WORKFLOW=FAIL');
  console.log(`REMOTE_V3_LAST_GOOD_SEED_ERROR=${error.message}`);
  console.log('MESSAGE_SENT=NO');

  try {
    await mongoose.disconnect();
  } catch (_) {}

  process.exit(1);
});
