'use strict';

// WA_PRODUCTION_V3_SYNC_STARTUP_RETRY_CLASSIFIER_V1
// Retry is allowed only for the exact pre-ready Puppeteer startup timeout
// observed in Production sync-once. Sender processes are never retried.

const EXACT_TRANSIENT =
  'LISTENER_STARTUP_ERROR=Waiting failed: 30000ms exceeded';

function isRetryableStartupFailure({
  exitCode,
  output
}) {
  const text = String(output || '');

  if (Number(exitCode) === 0) {
    return false;
  }

  if (!text.includes(EXACT_TRANSIENT)) {
    return false;
  }

  if (text.includes('WHATSAPP_READY=YES')) {
    return false;
  }

  if (text.includes('ATTENDANCE_SYNC_ONCE=PASS')) {
    return false;
  }

  if (text.includes('REMOTE_AUTH_QR_FORBIDDEN=YES')) {
    return false;
  }

  if (text.includes('AUTH_FAILURE')) {
    return false;
  }

  return true;
}

module.exports = {
  EXACT_TRANSIENT,
  isRetryableStartupFailure
};
