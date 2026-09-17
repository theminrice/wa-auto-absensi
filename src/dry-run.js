const {
  normalizeProjectText,
  buildCheckIn,
  buildCheckOut,
  getJakartaParts
} = require('./attendance');

const mode = (process.env.MODE || 'dry-run').toLowerCase();
const rawProject = process.env.PROJECT_TEXT || 'p:Melanjutkan audit sekuritas backend';

const project = normalizeProjectText(rawProject);
if (!project) {
  console.error('PROJECT_FOUND=NO');
  process.exit(1);
}

const now = new Date();
const parts = getJakartaParts(now);

console.log('========================================');
console.log('WA AUTO ABSENSI - SAFE DRY RUN');
console.log('========================================');
console.log(`MODE=${mode}`);
console.log('TARGET_GROUP=Testing');
console.log('PRODUCTION_ENABLED=false');
console.log('WHATSAPP_SEND_ENABLED=false');
console.log(`PROJECT_FOUND=YES`);
console.log(`PROJECT=${project}`);
console.log(`JAKARTA_WEEKDAY=${parts.weekday}`);
console.log('');

if (mode === 'checkout') {
  console.log(buildCheckOut({ project, date: now }));
} else {
  console.log(buildCheckIn({ project, date: now }));
}

console.log('');
console.log('SAFE_RESULT=NO_MESSAGE_SENT');
