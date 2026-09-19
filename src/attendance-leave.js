'use strict';

const {
  getJakartaParts
} = require('./attendance');

// ATTENDANCE_LEAVE_COMMAND_V1
// Only l: commands set leave days. p: remains a project.
const LEAVE_GRAMMAR =
  /^\s*l\s*:\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s*-\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?)?\s*$/i;

function isoDay(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    throw new Error('LEAVE_DATE_INVALID');
  }

  const d =
    new Date(Date.UTC(year, month - 1, day));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    throw new Error('LEAVE_DATE_INVALID');
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}

function jakartaDateKey(date = new Date()) {
  const parts = getJakartaParts(date);

  return isoDay(
    parts.year,
    parts.month,
    parts.day
  );
}

function parseLeaveCommand(
  body,
  messageDate = new Date()
) {
  if (
    typeof body !== 'string' ||
    !/^\s*l\s*:/i.test(body)
  ) {
    return null;
  }

  const match =
    body.match(LEAVE_GRAMMAR);

  if (!match) {
    throw new Error(
      'LEAVE_COMMAND_INVALID_FORMAT'
    );
  }

  const sentYear =
    getJakartaParts(messageDate).year;

  const startDay =
    Number(match[1]);

  const startMonth =
    Number(match[2]);

  const startYear =
    match[3]
      ? Number(match[3])
      : sentYear;

  const endDay =
    match[4]
      ? Number(match[4])
      : startDay;

  const endMonth =
    match[5]
      ? Number(match[5])
      : startMonth;

  let endYear =
    match[6]
      ? Number(match[6])
      : startYear;

  if (
    match[4] &&
    !match[6] &&
    endMonth < startMonth
  ) {
    // l:30/12-2/1 means 30 Dec through 2 Jan next year.
    endYear += 1;
  }

  const startDate =
    isoDay(
      startYear,
      startMonth,
      startDay
    );

  const endDate =
    isoDay(
      endYear,
      endMonth,
      endDay
    );

  if (endDate < startDate) {
    throw new Error(
      'LEAVE_DATE_RANGE_REVERSED'
    );
  }

  return {
    startDate,
    endDate
  };
}

function evaluateLeaveForDate(
  leave,
  date = new Date()
) {
  const dateKey =
    jakartaDateKey(date);

  if (!leave) {
    return {
      dateKey,
      onLeave: false
    };
  }

  if (
    !leave.startDate ||
    !leave.endDate ||
    typeof leave.startDate !== 'string' ||
    typeof leave.endDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(leave.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(leave.endDate)
  ) {
    throw new Error(
      'LEAVE_STORED_RANGE_INVALID'
    );
  }

  const start = leave.startDate.split('-').map(Number);
  const end = leave.endDate.split('-').map(Number);

  if (
    isoDay(start[0], start[1], start[2]) !== leave.startDate ||
    isoDay(end[0], end[1], end[2]) !== leave.endDate ||
    leave.endDate < leave.startDate
  ) {
    throw new Error(
      'LEAVE_STORED_RANGE_INVALID'
    );
  }

  return {
    dateKey,
    onLeave:
      dateKey >= leave.startDate &&
      dateKey <= leave.endDate
  };
}

module.exports = {
  isoDay,
  jakartaDateKey,
  parseLeaveCommand,
  evaluateLeaveForDate
};
