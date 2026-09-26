'use strict';

// WA_PRODUCTION_V3_SYNC_STARTUP_RETRY_RUNNER_V1
// This wrapper runs ONLY the no-send Production V3 sync-once process.
// At most one retry is permitted, and only for the exact pre-ready
// 30-second Puppeteer startup timeout classified by the helper module.

const fs = require('fs');
const path = require('path');
const {
  spawn
} = require('child_process');

const {
  isRetryableStartupFailure
} = require('./attendance-sync-startup-retry');

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5000;
const MAX_CAPTURE_CHARS = 2 * 1024 * 1024;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendBounded(current, chunk) {
  const next = current + chunk;

  if (next.length <= MAX_CAPTURE_CHARS) {
    return next;
  }

  return next.slice(
    next.length - MAX_CAPTURE_CHARS
  );
}

function runOneAttempt(attempt) {
  return new Promise((resolve, reject) => {
    console.log(
      `PRODUCTION_V3_SYNC_ATTEMPT=${attempt}_OF_${MAX_ATTEMPTS}`
    );

    const child = spawn(
      process.execPath,
      [
        path.join(
          __dirname,
          'wa-self-chat-ingest-production-v3.js'
        ),
        '--sync-once'
      ],
      {
        env: process.env,
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    let output = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
      output = appendBounded(output, text);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      process.stderr.write(text);
      output = appendBounded(output, text);
    });

    child.once('error', reject);

    child.once('close', (code, signal) => {
      resolve({
        exitCode:
          Number.isInteger(code) ? code : 1,
        signal: signal || null,
        output
      });
    });
  });
}

async function resetEphemeralLocalState() {
  const raw =
    process.env.WWEBJS_REMOTE_DATA_PATH;

  if (!raw || !raw.trim()) {
    console.log(
      'PRODUCTION_V3_SYNC_LOCAL_RESET=SKIPPED_NO_PATH'
    );
    return;
  }

  const target =
    path.resolve(raw.trim());

  await fs.promises.rm(
    target,
    {
      recursive: true,
      force: true
    }
  );

  await fs.promises.mkdir(
    target,
    {
      recursive: true
    }
  );

  console.log(
    'PRODUCTION_V3_SYNC_LOCAL_RESET=PASS'
  );
}

async function main() {
  console.log(
    'PRODUCTION_V3_SYNC_RESILIENT=START'
  );

  console.log(
    'PRODUCTION_V3_SYNC_MAX_ATTEMPTS=2'
  );

  console.log(
    'PRODUCTION_V3_SYNC_SENDER_RETRY=NO'
  );

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt += 1
  ) {
    const result =
      await runOneAttempt(attempt);

    if (result.exitCode === 0) {
      console.log(
        `PRODUCTION_V3_SYNC_SUCCESS_ATTEMPT=${attempt}`
      );

      console.log(
        'PRODUCTION_V3_SYNC_RESILIENT=PASS'
      );

      return;
    }

    console.log(
      `PRODUCTION_V3_SYNC_ATTEMPT_EXIT_CODE=${result.exitCode}`
    );

    if (result.signal) {
      console.log(
        `PRODUCTION_V3_SYNC_ATTEMPT_SIGNAL=${result.signal}`
      );
    }

    const retryable =
      isRetryableStartupFailure(result);

    console.log(
      'PRODUCTION_V3_SYNC_RETRYABLE_STARTUP_TIMEOUT=' +
        (retryable ? 'YES' : 'NO')
    );

    if (
      !retryable ||
      attempt >= MAX_ATTEMPTS
    ) {
      console.log(
        'PRODUCTION_V3_SYNC_RETRY=NO'
      );

      process.exitCode =
        result.exitCode || 1;

      return;
    }

    console.log(
      'PRODUCTION_V3_SYNC_RETRY=YES'
    );

    console.log(
      'PRODUCTION_V3_SYNC_RETRY_COUNT=1_OF_1'
    );

    await resetEphemeralLocalState();

    console.log(
      `PRODUCTION_V3_SYNC_RETRY_WAIT_MS=${RETRY_DELAY_MS}`
    );

    await sleep(RETRY_DELAY_MS);
  }
}

main().catch(error => {
  const message =
    String(
      error && error.message ||
      error ||
      'UNKNOWN'
    )
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 240);

  console.error(
    'PRODUCTION_V3_SYNC_RESILIENT=FAIL'
  );

  console.error(
    `PRODUCTION_V3_SYNC_RESILIENT_ERROR=${message}`
  );

  process.exitCode = 1;
});
