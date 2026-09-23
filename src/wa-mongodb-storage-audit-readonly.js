'use strict';

// WA_MONGO_ATLAS_STORAGE_READONLY_AUDIT_V1
// Storage measurement only. No WhatsApp initialization, writes or deletions.
// atlasSize reports logical data+index usage ACROSS the whole Atlas cluster
// on supported Free/Flex tiers; dbStats is a per-database fallback.
const mongoose = require('mongoose');

const APP_DATABASE = 'wa_auto_absensi';
const FREE_CAPACITY_BYTES_APPROX = 512 * 1024 * 1024;
const BACKUPS = [
  ['CANDIDATE',
    'wa_remoteauth_v3_candidate_orphans_backup_20260923'],
  ['LAST_GOOD',
    'wa_remoteauth_v3_last_good_orphans_backup_20260923']
];

function numberOf(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function mib(n) {
  return (n / (1024 * 1024)).toFixed(2);
}

function fail(code) {
  throw new Error(code);
}

async function atlasTier() {
  const id = process.env.ATLAS_CLIENT_ID;
  const secret = process.env.ATLAS_CLIENT_SECRET;
  const project = process.env.ATLAS_PROJECT_ID;
  if (!id || !secret || !project) {
    console.log('MONGO_ATLAS_TIER_LOOKUP=UNAVAILABLE_NO_API_SECRETS');
    return null;
  }
  try {
    const auth = Buffer.from(id + ':' + secret)
      .toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const oauth = await fetch(
        'https://cloud.mongodb.com/api/oauth/token',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + auth,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: controller.signal
        }
      );
      if (!oauth.ok) fail('ATLAS_API_AUTH_UNAVAILABLE');
      const token = (await oauth.json()).access_token;
      if (typeof token !== 'string' || !token) {
        fail('ATLAS_API_TOKEN_UNAVAILABLE');
      }
      const url = 'https://cloud.mongodb.com/api/atlas/v2/groups/' +
        encodeURIComponent(project) + '/clusters';
      const response = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.atlas.2025-03-12+json'
        },
        signal: controller.signal
      });
      if (!response.ok) fail('ATLAS_API_CLUSTERS_UNAVAILABLE');
      const json = await response.json();
      const clusters = Array.isArray(json.results) ? json.results : [];
      if (clusters.length !== 1) {
        console.log('MONGO_ATLAS_TIER_LOOKUP=AMBIGUOUS_CLUSTER_COUNT');
        return null;
      }
      const cluster = clusters[0];
      const candidateTiers = [];
      if (cluster.providerSettings &&
          cluster.providerSettings.instanceSizeName) {
        candidateTiers.push(cluster.providerSettings.instanceSizeName);
      }
      for (const spec of cluster.replicationSpecs || []) {
        for (const region of spec.regionConfigs || []) {
          if (region.electableSpecs &&
              region.electableSpecs.instanceSize) {
            candidateTiers.push(region.electableSpecs.instanceSize);
          }
        }
      }
      const tiers = [...new Set(candidateTiers
        .filter(x => typeof x === 'string')
        .map(x => x.toUpperCase()))];
      if (tiers.length !== 1) {
        console.log('MONGO_ATLAS_TIER_LOOKUP=UNKNOWN');
        return null;
      }
      console.log('MONGO_ATLAS_TIER_LOOKUP=PASS');
      console.log('MONGO_ATLAS_TIER=' + tiers[0]);
      return tiers[0];
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    // A metrics audit must not expose API tokens, project identifiers,
    // connection strings or untrusted API error response bodies.
    console.log('MONGO_ATLAS_TIER_LOOKUP=UNAVAILABLE');
    return null;
  }
}

async function audit() {
  if (!process.env.MONGODB_URI) fail('MONGODB_URI_MISSING');
  console.log('MONGO_STORAGE_AUDIT=READ_ONLY');
  console.log('MONGO_STORAGE_WHATSAPP_INITIALIZED=NO');
  console.log('MONGO_STORAGE_MESSAGES_SENT=0');
  console.log('MONGO_STORAGE_DB_WRITES=0');
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: APP_DATABASE,
    serverSelectionTimeoutMS: 15000
  });
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    console.log('MONGO_STORAGE_PING=PASS');
    let totalAtlasBytes = null;
    try {
      const raw = await db.command({ atlasSize: 1 });
      totalAtlasBytes = numberOf(raw.atlasSize);
      if (raw.ok !== 1 || totalAtlasBytes === null) {
        fail('ATLAS_SIZE_INVALID');
      }
      console.log('MONGO_STORAGE_ATLAS_SIZE=PASS');
      console.log('MONGO_STORAGE_CLUSTER_LOGICAL_USED_BYTES=' +
        totalAtlasBytes);
      console.log('MONGO_STORAGE_CLUSTER_LOGICAL_USED_MIB=' +
        mib(totalAtlasBytes));
      const data = numberOf(raw.totals && raw.totals.dataSize);
      const index = numberOf(raw.totals && raw.totals.indexSize);
      if (data !== null) {
        console.log('MONGO_STORAGE_CLUSTER_DATA_BYTES=' + data);
      }
      if (index !== null) {
        console.log('MONGO_STORAGE_CLUSTER_INDEX_BYTES=' + index);
      }
    } catch (_) {
      console.log('MONGO_STORAGE_ATLAS_SIZE=UNAVAILABLE');
    }

    let dbStats = null;
    try {
      dbStats = await db.command({ dbStats: 1, scale: 1 });
      const data = numberOf(dbStats.dataSize);
      const indexes = numberOf(dbStats.indexSize);
      console.log('MONGO_STORAGE_APP_DB_STATS=PASS');
      if (data !== null) {
        console.log('MONGO_STORAGE_APP_DATA_BYTES=' + data);
      }
      if (indexes !== null) {
        console.log('MONGO_STORAGE_APP_INDEX_BYTES=' + indexes);
      }
      if (data !== null && indexes !== null) {
        console.log('MONGO_STORAGE_APP_LOGICAL_MIB=' +
          mib(data + indexes));
      }
      const allocated = numberOf(dbStats.totalSize);
      if (allocated !== null) {
        console.log('MONGO_STORAGE_APP_ALLOCATED_MIB=' +
          mib(allocated));
      }
    } catch (_) {
      console.log('MONGO_STORAGE_APP_DB_STATS=UNAVAILABLE');
    }

    for (const [label, name] of BACKUPS) {
      const rows = await db.listCollections(
        { name }, { nameOnly: true }
      ).toArray();
      if (rows.some(item => item.name === name)) {
        const count = await db.collection(name).countDocuments({});
        console.log('MONGO_STORAGE_BACKUP_' + label +
          '_CHUNKS=' + count);
      } else {
        console.log('MONGO_STORAGE_BACKUP_' + label +
          '_CHUNKS=ABSENT');
      }
    }

    const tier = await atlasTier();
    if (tier === 'M0' && totalAtlasBytes !== null) {
      const remaining = Math.max(
        0, FREE_CAPACITY_BYTES_APPROX - totalAtlasBytes
      );
      console.log('MONGO_STORAGE_FREE_QUOTA_APPROX_MIB=512');
      console.log('MONGO_STORAGE_FREE_REMAINING_APPROX_MIB=' +
        mib(remaining));
      console.log('MONGO_STORAGE_FREE_USED_APPROX_PERCENT=' +
        (100 * totalAtlasBytes /
          FREE_CAPACITY_BYTES_APPROX).toFixed(2));
      console.log('MONGO_STORAGE_REMAINING_ESTIMATE=PASS_M0');
    } else {
      console.log('MONGO_STORAGE_REMAINING_ESTIMATE=' +
        'NOT_AVAILABLE_WITHOUT_VERIFIED_FREE_TIER_AND_ATLAS_SIZE');
    }
    if (totalAtlasBytes === null &&
        (!dbStats ||
         (numberOf(dbStats.dataSize) === null &&
          numberOf(dbStats.totalSize) === null))) {
      fail('NO_STORAGE_METRICS_AVAILABLE');
    }
    console.log('MONGO_STORAGE_AUDIT=PASS');
  } finally {
    await mongoose.disconnect();
    console.log('MONGO_STORAGE_DISCONNECTED=YES');
  }
}

audit().catch(error => {
  const code = String(error && error.message || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 100);
  console.error('MONGO_STORAGE_AUDIT_ERROR_CODE=' + code);
  process.exitCode = 1;
});
