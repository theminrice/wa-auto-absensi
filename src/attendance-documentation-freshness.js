'use strict';

// WA_AUTO_ABSENSI_CHECKOUT_DOC_SAME_DAY_GUARD_V1
// Reject previous-day, invalid and implausibly future documentation.
// Same-calendar-day is a safety floor, NOT proof that the newest photo synced.
const JAKARTA_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function jakartaCalendarDay(date) {
  return JAKARTA_DATE.formatToParts(date)
    .filter(part => ['year', 'month', 'day'].includes(part.type))
    .reduce((parts, part) => {
      parts[part.type] = part.value;
      return parts;
    }, {});
}

function isCheckoutDocumentationCurrentDay(timestamp, now = new Date()) {
  if (!(timestamp instanceof Date) ||
      !(now instanceof Date) ||
      !Number.isFinite(timestamp.getTime()) ||
      !Number.isFinite(now.getTime()) ||
      timestamp.getTime() > now.getTime() + 5 * 60 * 1000) {
    return false;
  }

  const documentDay = jakartaCalendarDay(timestamp);
  const checkoutDay = jakartaCalendarDay(now);
  return documentDay.year === checkoutDay.year &&
    documentDay.month === checkoutDay.month &&
    documentDay.day === checkoutDay.day;
}

module.exports = {
  isCheckoutDocumentationCurrentDay
};
