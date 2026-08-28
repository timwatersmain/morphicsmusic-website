/**
 * Parse.gs — date and time extraction from free text.
 *
 * Everything in this file is a pure function over strings and Dates. It calls
 * no Apps Script services, which is what lets tests/calendar-sync load this
 * exact source under vitest instead of a copy that can drift.
 */

var CS_MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

var CS_DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Times are found before dates so their spans can be masked out. Without that,
 * "09:00-17:00" reads as the numeric date 00/17 and a roster line silently
 * lands on the wrong day.
 *
 * Branch 1 (groups 1-3) is the 12-hour form: 7pm, 7:30 PM, 7.30pm.
 * Branch 2 (groups 4-5) is the 24-hour form: 19:30. A bare "19" is not a time;
 * requiring the colon keeps plain numbers out.
 */
var CS_TIME_RE = /(?<![\d:.])(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?(?![a-z])|(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:.])/gi;

/** Between two times: 7pm-11pm, 19:00 – 23:00, 7pm to 11pm. */
var CS_RANGE_SEP_RE = /^\s*(?:-|\u2013|\u2014|\u2011|to|til|till|until|thru|through|\/)\s*$/i;

var CS_ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
var CS_MONTH_NAMES_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** "14 September 2026", "14 Sept", "14th Sep 2026". */
var CS_DMY_TEXT_RE = new RegExp(
  '(?<![\\d/-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + CS_MONTH_NAMES_ALT + ')\\.?(?:\\s*,?\\s*(\\d{4}))?(?![\\d/-])',
  'i'
);

/** "September 14, 2026", "Sep 14", "Sept 14th". */
var CS_MDY_TEXT_RE = new RegExp(
  '(?<![\\d/-])(' + CS_MONTH_NAMES_ALT + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?(?![\\d/-])',
  'i'
);

/**
 * "9/14", "9/14/2026", "14-09-2026". Lookarounds reject anything touching a
 * colon or another digit so masked-out clock times cannot be re-read as dates.
 */
var CS_NUMERIC_DATE_RE = /(?<![\d:./-])(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?(?![\d:./-])/;

/** Collapse non-breaking spaces and runs of whitespace; lowercase is left to callers. */
function csNormalize(text) {
  return String(text == null ? '' : text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function csIsLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function csDaysInMonth(year, month) {
  if (month === 2 && csIsLeapYear(year)) return 29;
  return CS_DAYS_IN_MONTH[month - 1];
}

function csIsValidYmd(year, month, day) {
  if (!(month >= 1 && month <= 12)) return false;
  if (!(day >= 1 && day <= csDaysInMonth(year, month))) return false;
  return true;
}

/**
 * A bare "Sept 14" means the next 14 September, not one in the past — but a
 * roster mailed on the 1st can still reference the 31st of last month, so a
 * short grace window behind the reference date is allowed before rolling
 * forward a year.
 */
function csInferYear(month, day, refDate, graceDays) {
  var grace = graceDays == null ? 45 : graceDays;
  var refYear = refDate.getFullYear();
  var earliest = refDate.getTime() - grace * 86400000;

  // Forward scan, taking the first year in which the date both exists and is
  // not stale. The range reaches past the next year because 29 February only
  // exists once every four, and "Feb 29" must not silently resolve to nothing.
  for (var year = refYear - 1; year <= refYear + 8; year++) {
    if (!csIsValidYmd(year, month, day)) continue;
    if (new Date(year, month - 1, day).getTime() >= earliest) return year;
  }

  // Only readings older than the grace window remain; take the most recent.
  for (var back = refYear; back >= refYear - 8; back--) {
    if (csIsValidYmd(back, month, day)) return back;
  }
  return refYear;
}

/** Expand a 2-digit year the way a calendar invite means it: 26 -> 2026. */
function csExpandYear(raw) {
  var year = parseInt(raw, 10);
  if (raw.length <= 2) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

/**
 * All time matches in a line, left to right, each with the span it occupied so
 * callers can mask them before looking for dates.
 */
function csFindTimes(line) {
  var text = String(line == null ? '' : line);
  var out = [];
  var re = new RegExp(CS_TIME_RE.source, 'gi');
  var match;
  while ((match = re.exec(text)) !== null) {
    var hour;
    var minute;
    var meridiem = null;
    if (match[3]) {
      hour = parseInt(match[1], 10);
      minute = match[2] ? parseInt(match[2], 10) : 0;
      meridiem = match[3].toLowerCase();
      if (hour < 1 || hour > 12) continue;
    } else {
      hour = parseInt(match[4], 10);
      minute = parseInt(match[5], 10);
      if (hour > 23) continue;
    }
    if (minute > 59) continue;
    out.push({
      hour: hour,
      minute: minute,
      meridiem: meridiem,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

/** Fold a 12-hour reading into 24-hour. */
function csApplyMeridiem(hour, meridiem) {
  if (meridiem === 'a') return hour === 12 ? 0 : hour;
  if (meridiem === 'p') return hour === 12 ? 12 : hour + 12;
  return hour;
}

/**
 * A range that states its meridiem only once, at the end: "7-11pm", "11-1pm",
 * "7:30 to 11pm".
 *
 * This needs its own pattern because the general time scanner deliberately
 * refuses bare integers — treating every loose number as a possible clock time
 * would swallow the day out of "14 Sep" before the date scan ever ran. Here the
 * trailing meridiem is what proves the leading number is an hour.
 *
 * The separator list excludes "/" on purpose: "9/14" is a date, not 9 to 14.
 */
var CS_SHARED_MERIDIEM_RANGE_RE = /(?<![\d:.])(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|‑|to|til|till|until|thru|through)\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?(?![a-z])/i;

function csFindSharedMeridiemRange(text) {
  var match = CS_SHARED_MERIDIEM_RANGE_RE.exec(text);
  if (!match) return null;

  var startHour = parseInt(match[1], 10);
  var startMinute = match[2] ? parseInt(match[2], 10) : 0;
  var endHour = parseInt(match[3], 10);
  var endMinute = match[4] ? parseInt(match[4], 10) : 0;
  var meridiem = match[5].toLowerCase();

  if (startHour < 1 || startHour > 12 || endHour < 1 || endHour > 12) return null;
  if (startMinute > 59 || endMinute > 59) return null;

  endHour = csApplyMeridiem(endHour, meridiem);
  var shifted = csApplyMeridiem(startHour, meridiem);
  // "7-11pm" is 7pm to 11pm, but "11-1pm" is 11am to 1pm: the shared meridiem
  // only reaches back to the start when doing so keeps the range moving forward.
  startHour = shifted <= endHour ? shifted : startHour % 12;

  return {
    start: { hour: startHour, minute: startMinute },
    end: { hour: endHour, minute: endMinute },
    spans: [{ start: match.index, end: match.index + match[0].length }],
  };
}

/**
 * The first time range on a line, or a lone start time.
 */
function csFindTimeRange(line) {
  var text = String(line == null ? '' : line);

  var shared = csFindSharedMeridiemRange(text);
  if (shared) return shared;

  var times = csFindTimes(text);
  if (!times.length) return null;

  var startTime = times[0];
  var endTime = null;
  if (times.length > 1) {
    var between = text.slice(startTime.end, times[1].start);
    if (CS_RANGE_SEP_RE.test(between)) endTime = times[1];
  }

  var startHour = startTime.hour;
  var endHour = endTime ? endTime.hour : null;

  if (startTime.meridiem) {
    startHour = csApplyMeridiem(startHour, startTime.meridiem);
  } else if (endTime && endTime.meridiem) {
    startHour = csApplyMeridiem(startHour, endTime.meridiem);
  }
  if (endTime) {
    endHour = endTime.meridiem ? csApplyMeridiem(endHour, endTime.meridiem) : endHour;
    if (!startTime.meridiem && endTime.meridiem && startHour > endHour) {
      // "11-1pm" — the inherited pm was wrong for the start.
      startHour = startHour >= 12 ? startHour - 12 : startHour;
    }
  }

  var result = {
    start: { hour: startHour, minute: startTime.minute },
    end: endTime ? { hour: endHour, minute: endTime.minute } : null,
    spans: [{ start: startTime.start, end: startTime.end }],
  };
  if (endTime) result.spans.push({ start: endTime.start, end: endTime.end });
  return result;
}

/** Blank out character ranges, preserving offsets so later spans stay valid. */
function csMaskSpans(line, spans) {
  var chars = String(line == null ? '' : line).split('');
  for (var i = 0; i < spans.length; i++) {
    for (var j = spans[i].start; j < spans[i].end && j < chars.length; j++) chars[j] = ' ';
  }
  return chars.join('');
}

/**
 * The first date in a string, as {year, month, day}. Formats are tried
 * unambiguous-first: ISO, then written months, then bare numerics — so
 * dateOrder only ever decides genuinely ambiguous cases like 9/14 vs 14/9.
 */
function csFindDate(text, refDate, dateOrder) {
  var line = String(text == null ? '' : text);
  var ref = refDate || new Date();
  var order = (dateOrder || 'MDY').toUpperCase();

  var iso = CS_ISO_DATE_RE.exec(line);
  if (iso) {
    var isoYear = parseInt(iso[1], 10);
    var isoMonth = parseInt(iso[2], 10);
    var isoDay = parseInt(iso[3], 10);
    if (csIsValidYmd(isoYear, isoMonth, isoDay)) {
      return { year: isoYear, month: isoMonth, day: isoDay, span: { start: iso.index, end: iso.index + iso[0].length } };
    }
  }

  var dmy = CS_DMY_TEXT_RE.exec(line);
  var mdy = CS_MDY_TEXT_RE.exec(line);
  // Whichever written form appears first wins, so "Sat 14 Sep" is not misread
  // by an MDY pattern that would start matching at "Sep".
  var textual = null;
  if (dmy && mdy) textual = dmy.index <= mdy.index ? { m: dmy, dayFirst: true } : { m: mdy, dayFirst: false };
  else if (dmy) textual = { m: dmy, dayFirst: true };
  else if (mdy) textual = { m: mdy, dayFirst: false };

  if (textual) {
    var tm = textual.m;
    var monthWord = (textual.dayFirst ? tm[2] : tm[1]).toLowerCase().replace(/\./g, '');
    var dayNum = parseInt(textual.dayFirst ? tm[1] : tm[2], 10);
    var monthNum = CS_MONTHS[monthWord];
    if (monthNum) {
      var textYear = tm[3] ? csExpandYear(tm[3]) : csInferYear(monthNum, dayNum, ref);
      if (csIsValidYmd(textYear, monthNum, dayNum)) {
        return { year: textYear, month: monthNum, day: dayNum, span: { start: tm.index, end: tm.index + tm[0].length } };
      }
    }
  }

  var num = CS_NUMERIC_DATE_RE.exec(line);
  if (num) {
    var first = parseInt(num[1], 10);
    var second = parseInt(num[2], 10);
    var numMonth;
    var numDay;
    if (order === 'DMY') {
      numMonth = second;
      numDay = first;
    } else {
      numMonth = first;
      numDay = second;
    }
    // One reading being impossible settles it regardless of configured order.
    if (numMonth > 12 && numDay <= 12) {
      var swap = numMonth;
      numMonth = numDay;
      numDay = swap;
    }
    var numYear = num[3] ? csExpandYear(num[3]) : csInferYear(numMonth, numDay, ref);
    if (csIsValidYmd(numYear, numMonth, numDay)) {
      return { year: numYear, month: numMonth, day: numDay, span: { start: num.index, end: num.index + num[0].length } };
    }
  }

  return null;
}

/**
 * A date and (optionally) a time range from one line, with times masked out
 * before the date scan.
 */
function csParseLine(line, refDate, dateOrder) {
  var text = csNormalize(line);
  if (!text) return null;
  var range = csFindTimeRange(text);
  var masked = range ? csMaskSpans(text, range.spans) : text;
  var date = csFindDate(masked, refDate, dateOrder);
  if (!date) return null;
  return { date: date, time: range };
}

/** Build a Date in the runtime's local zone, which Apps Script sets from the manifest. */
function csToDate(ymd, time) {
  var hour = time ? time.hour : 0;
  var minute = time ? time.minute : 0;
  return new Date(ymd.year, ymd.month - 1, ymd.day, hour, minute, 0, 0);
}

function csAddMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/**
 * Turn a parsed line into a concrete interval.
 *
 * An end at or before the start means an overnight shift (22:00-06:00), so it
 * rolls to the next day rather than producing a negative-length event.
 */
function csToInterval(parsed, defaultDurationMinutes) {
  if (!parsed) return null;
  if (!parsed.time) {
    return { start: csToDate(parsed.date, null), end: null, allDay: true };
  }
  var start = csToDate(parsed.date, parsed.time.start);
  var end;
  if (parsed.time.end) {
    end = csToDate(parsed.date, parsed.time.end);
    if (end.getTime() <= start.getTime()) end = csAddMinutes(end, 24 * 60);
  } else {
    end = csAddMinutes(start, defaultDurationMinutes || 60);
  }
  return { start: start, end: end, allDay: false };
}
