// js/hours.js
// Best-effort reader for the free-text hours owners type in, e.g.
//   [["Mon–Fri", "9am–5pm"], ["Sat", "10:00 - 14:00"], ["Sun", "Closed"]]
// isOpenNow(hours, date) returns true / false, or null when nothing in the
// hours can be read (the Explore "Open now" filter hides those listings).
(function () {
  "use strict";

  var DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  var ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

  function normalize(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[‒-―−]/g, "-")   // en/em dashes, minus sign
      .replace(/\s+(?:to|through|thru|until|till)\s+/g, " - ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dayIndex(word) {
    var w = word.replace(/[^a-z]/g, "");
    if (w.length < 2) return -1;
    if (w === "tu" || w === "tues") return 2;
    if (w === "th" || w === "thur" || w === "thurs") return 4;
    if (w === "su") return 0;
    if (w === "mo") return 1;
    if (w === "we") return 3;
    if (w === "fr") return 5;
    if (w === "sa") return 6;
    var idx = DAY_KEYS.indexOf(w.slice(0, 3));
    return idx;
  }

  // "Mon–Fri", "Sat & Sun", "Wednesdays", "Daily" -> [day indexes] or null.
  function parseDays(label) {
    var s = normalize(label);
    if (!s) return null;
    if (/^(daily|every ?day|7 days( a week)?|all week|open daily)$/.test(s)) return ALL_DAYS.slice();
    if (/^week ?days$/.test(s)) return [1, 2, 3, 4, 5];
    if (/^week ?ends$/.test(s)) return [0, 6];
    var days = [];
    var parts = s.split(/\s*(?:,|&|\/|\band\b|\+)\s*/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      if (/^(daily|every ?day)$/.test(part)) return ALL_DAYS.slice();
      if (/^week ?days$/.test(part)) { days.push(1, 2, 3, 4, 5); continue; }
      if (/^week ?ends$/.test(part)) { days.push(0, 6); continue; }
      var range = part.split(/\s*-\s*/);
      if (range.length === 2) {
        var a = dayIndex(range[0]), b = dayIndex(range[1]);
        if (a === -1 || b === -1) return null;
        for (var d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
      } else if (range.length === 1) {
        var one = dayIndex(part);
        if (one === -1) return null;
        days.push(one);
      } else {
        return null;
      }
    }
    return days.length ? days : null;
  }

  // One clock time -> { min, mer } (mer: "am"/"pm"/null), or null.
  function parseClock(t) {
    var s = t.replace(/\s+/g, "");
    if (s === "noon" || s === "midday") return { min: 720, mer: "fixed" };
    if (s === "midnight") return { min: 0, mer: "fixed", midnight: true };
    var m = /^(\d{1,2})(?:[:.](\d{2}))?(a\.?m?\.?|p\.?m?\.?)?$/.exec(s);
    if (!m) return null;
    var h = parseInt(m[1], 10), mins = m[2] ? parseInt(m[2], 10) : 0;
    if (mins > 59) return null;
    var mer = m[3] ? (m[3].charAt(0) === "a" ? "am" : "pm") : null;
    if (mer) {
      if (h < 1 || h > 12) return null;
      h = h % 12 + (mer === "pm" ? 12 : 0);
    } else if (h > 24) {
      return null;
    }
    // "14:00", "00:30", "09:00" read as 24-hour clock times.
    return { min: h * 60 + mins, mer: mer, h24: !mer && (h > 12 || h === 0 || m[1].charAt(0) === "0") };
  }

  // "9am-5pm" -> [start, end] in minutes from midnight; end may exceed 1440
  // when the range runs past midnight.
  function parseRange(text) {
    var bits = text.split(/\s*-\s*/);
    if (bits.length !== 2) return null;
    var a = parseClock(bits[0]), b = parseClock(bits[1]);
    if (!a || !b) return null;
    var start = a.min, end = b.min;
    if (!a.mer && b.mer && b.mer !== "fixed") {
      // "9-5pm", "11-2pm": borrow the end's am/pm, unless that puts start after end.
      var h = Math.floor(start / 60) % 12, rest = start % 60;
      start = (h + (b.mer === "pm" ? 12 : 0)) * 60 + rest;
      if (start > end) start -= 720;
      if (start < 0) start += 720;
    } else if (a.mer && !b.mer) {
      // "9am-5": the end is the next time that reading lands on after start.
      if (end <= start && end + 720 > start && end < 720) end += 720;
    } else if (!a.mer && !b.mer && !a.h24 && !b.h24) {
      // "9-5" with no am/pm and nothing 24h-looking: assume a daytime span.
      if (end <= start && end < 720) end += 720;
    }
    if (b.midnight && end === 0) end = 1440;
    if (end <= start) end += 1440; // runs past midnight
    if (end === start) return null;
    return [start, end];
  }

  // Time text -> { closed: true } | { ranges: [[s, e], ...] } | null.
  function parseTimes(value) {
    var s = normalize(value);
    if (!s) return null;
    if (/^(closed|close|by appointment( only)?|appointment only)$/.test(s)) return { closed: true };
    if (/^(open )?24 ?(hours|hrs|h)$|^24\/7$|^all day$/.test(s)) return { ranges: [[0, 1440]] };
    var parts = s.split(/\s*(?:,|;|&|\/|\band\b)\s*/);
    var ranges = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var r = parseRange(parts[i]);
      if (!r) return null;
      ranges.push(r);
    }
    return ranges.length ? { ranges: ranges } : null;
  }

  // "Wednesdays, 17:00 - 21:00" / "Sun closed" -> { days, times } or null.
  function splitDaysAndTimes(text) {
    var s = normalize(text);
    var m = /^(.*?[a-z.])[\s,:]+((?:\d|noon|midnight|closed|open 24).*)$/.exec(s);
    if (!m) return null;
    var days = parseDays(m[1]);
    if (!days) return null;
    return { days: days, times: parseTimes(m[2]) };
  }

  function isOpenNow(hours, date) {
    if (!Array.isArray(hours) || !hours.length) return null;
    var now = date || new Date();
    var today = now.getDay(), yesterday = (today + 6) % 7;
    var minute = now.getHours() * 60 + now.getMinutes();

    var parsedAny = false, todayKnown = false, todayUnknown = false, open = false;
    hours.forEach(function (row) {
      var label, value;
      if (Array.isArray(row)) { label = row[0]; value = row[1]; }
      else if (typeof row === "string") { label = row; value = ""; }
      else return;
      var days = parseDays(label);
      var times = parseTimes(value);
      // Days written into the time ("Clinic hours" | "Wednesdays, 17:00 - 21:00")
      // or the whole row in the label ("Mon-Fri 9am-5pm" | "").
      if (!days) {
        var inline = splitDaysAndTimes(value) || (!value ? splitDaysAndTimes(label) : null);
        if (inline) { days = inline.days; times = inline.times; }
      }
      if (!days) return;
      if (!times) {
        if (days.indexOf(today) !== -1) todayUnknown = true;
        return;
      }
      parsedAny = true;
      if (days.indexOf(today) !== -1) todayKnown = true;
      if (times.closed) return;
      times.ranges.forEach(function (r) {
        if (days.indexOf(today) !== -1 && minute >= r[0] && minute < r[1]) open = true;
        if (days.indexOf(yesterday) !== -1 && r[1] > 1440 && minute + 1440 >= r[0] && minute + 1440 < r[1]) open = true;
      });
    });

    if (open) return true;
    if (!parsedAny) return null;
    if (todayUnknown && !todayKnown) return null;
    // Days nobody listed are treated as closed: owners usually only list open days.
    return false;
  }

  var api = { isOpenNow: isOpenNow, parseDays: parseDays, parseTimes: parseTimes };
  if (typeof window !== "undefined") window.NiccHours = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
