const DAY_NAMES = [
  'Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'
];

const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

function getJakartaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );

  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);

  // Date.UTC digunakan hanya untuk memperoleh day-of-week dari tanggal kalender Jakarta.
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  return {
    year: y,
    month: m,
    day: d,
    weekday
  };
}

function isCleaningDay(weekday) {
  // Senin = 1, Kamis = 4
  return weekday === 1 || weekday === 4;
}

function formatDateID(date = new Date()) {
  const p = getJakartaParts(date);
  return `${DAY_NAMES[p.weekday]} ${p.day} ${MONTH_NAMES[p.month - 1]} ${p.year}`;
}

function normalizeProjectText(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^p\s*:\s*(.+)$/i);
  if (!match) return null;

  const value = match[1].trim();
  return value.length ? value : null;
}

function buildCheckIn({ project, date = new Date() }) {
  if (!project) throw new Error('PROJECT_REQUIRED');

  const p = getJakartaParts(date);
  const cleaning = isCleaningDay(p.weekday) ? '✅' : '❌';

  return [
    `Check In, ${formatDateID(date)}`,
    '',
    `- 08.00 : Sampai Kantor✅`,
    `- 08.10 : Membersihkan Ruangan${cleaning}`,
    `- 08.30 : ${project}`
  ].join('\n');
}

function buildCheckOut({ project, date = new Date() }) {
  if (!project) throw new Error('PROJECT_REQUIRED');

  const p = getJakartaParts(date);
  const cleaning = isCleaningDay(p.weekday) ? '✅' : '❌';

  return [
    `Check Out, ${formatDateID(date)}`,
    '',
    `- 08.00 : Sampai Kantor✅`,
    `- 08.10 : Membersihkan Ruangan${cleaning}`,
    `- 08.30 : ${project}✅`,
    `- 15.55 : Merapikan Dan Membersihkan Ruangan✅`,
    `- 16.00 : Pulang✅`
  ].join('\n');
}

module.exports = {
  getJakartaParts,
  isCleaningDay,
  formatDateID,
  normalizeProjectText,
  buildCheckIn,
  buildCheckOut
};
