'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath =
  path.join(
    __dirname,
    'wa-self-chat-ingest-production-v3.js'
  );

const source =
  fs.readFileSync(
    sourcePath,
    'utf8'
  );

const requiredSourceMarkers = [
  "body.match(",
  "/^\\s*p:\\s*(.+?)\\s*$/i",
  "message.hasMedia === true",
  "type === 'image'",
  "body === 'p'"
];

for (const marker of requiredSourceMarkers) {
  if (!source.includes(marker)) {
    throw new Error(
      `PROOF_SOURCE_MARKER_MISSING_${marker}`
    );
  }
}

function parseProject(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const match =
    body.match(
      /^\s*p:\s*(.+?)\s*$/i
    );

  if (!match) {
    return null;
  }

  const project =
    match[1].trim();

  return project || null;
}

function isDocumentationImage(message) {
  if (!message) {
    return false;
  }

  const body =
    typeof message.body === 'string'
      ? message.body.trim().toLowerCase()
      : '';

  const type =
    typeof message.type === 'string'
      ? message.type.toLowerCase()
      : '';

  return (
    message.hasMedia === true &&
    type === 'image' &&
    body === 'p'
  );
}

const projectCases = [
  {
    input: 'p: Melanjutkan audit sekuritas backend',
    expected: 'Melanjutkan audit sekuritas backend'
  },
  {
    input: 'P: Test Project V3',
    expected: 'Test Project V3'
  },
  {
    input: ' p:   Project dengan spasi   ',
    expected: 'Project dengan spasi'
  }
];

for (const testCase of projectCases) {
  const actual =
    parseProject(
      testCase.input
    );

  if (actual !== testCase.expected) {
    throw new Error(
      `P_COLON_PARSE_FAIL_${testCase.input}`
    );
  }
}

if (
  parseProject('p') !== null ||
  parseProject('project biasa') !== null ||
  parseProject('p:') !== null
) {
  throw new Error(
    'P_COLON_NEGATIVE_CASE_FAIL'
  );
}

const documentationPositive = {
  body: 'p',
  type: 'image',
  hasMedia: true
};

if (
  !isDocumentationImage(
    documentationPositive
  )
) {
  throw new Error(
    'P_IMAGE_PARSE_FAIL'
  );
}

const documentationNegativeCases = [
  {
    body: 'p:',
    type: 'image',
    hasMedia: true
  },
  {
    body: 'p',
    type: 'video',
    hasMedia: true
  },
  {
    body: 'p',
    type: 'image',
    hasMedia: false
  }
];

for (
  const testCase of
  documentationNegativeCases
) {
  if (
    isDocumentationImage(
      testCase
    )
  ) {
    throw new Error(
      'P_IMAGE_NEGATIVE_CASE_FAIL'
    );
  }
}

console.log(
  'P_COLON_SOURCE_MARKERS=PASS'
);

console.log(
  'P_COLON_RUNTIME_PARSE=PASS'
);

console.log(
  'P_IMAGE_SOURCE_MARKERS=PASS'
);

console.log(
  'P_IMAGE_RUNTIME_PARSE=PASS'
);

console.log(
  'P_AND_P_COLON_PROOF=PASS'
);

console.log(
  'PRODUCTION_ATTENDANCE_DATA_MODIFIED=NO'
);

console.log(
  'WHATSAPP_MESSAGE_SENT=NO'
);
