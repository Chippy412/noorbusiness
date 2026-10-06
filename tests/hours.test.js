// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const { isOpenNow } = require("../js/hours.js");

// at("wed", "13:30") -> a local Date on that weekday. 2026-10-04 is a Sunday.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function at(day, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 9, 4 + DAYS.indexOf(day), h, m);
}

test("sanity: the helper lands on the right weekday", () => {
  assert.strictEqual(at("sun", "12:00").getDay(), 0);
  assert.strictEqual(at("sat", "12:00").getDay(), 6);
});

test("weekday range with en dash and 12h times", () => {
  const hours = [["Mon–Fri", "9am–5pm"]];
  assert.strictEqual(isOpenNow(hours, at("wed", "10:00")), true);
  assert.strictEqual(isOpenNow(hours, at("wed", "08:59")), false);
  assert.strictEqual(isOpenNow(hours, at("wed", "17:00")), false);
  assert.strictEqual(isOpenNow(hours, at("sat", "12:00")), false, "unlisted day counts as closed");
});

test("24-hour times with spaces around the dash", () => {
  const hours = [["Sat", "10:00 - 14:00"]];
  assert.strictEqual(isOpenNow(hours, at("sat", "13:59")), true);
  assert.strictEqual(isOpenNow(hours, at("sat", "14:00")), false);
  assert.strictEqual(isOpenNow(hours, at("sun", "11:00")), false);
});

test("plural day names", () => {
  const hours = [["Wednesdays", "17:00 - 21:00"]];
  assert.strictEqual(isOpenNow(hours, at("wed", "18:00")), true);
  assert.strictEqual(isOpenNow(hours, at("thu", "18:00")), false);
});

test("Daily / Every day", () => {
  assert.strictEqual(isOpenNow([["Daily", "11am-10pm"]], at("sun", "21:30")), true);
  assert.strictEqual(isOpenNow([["Daily", "11am-10pm"]], at("sun", "22:30")), false);
  assert.strictEqual(isOpenNow([["Every day", "8 a.m. to 8 p.m."]], at("tue", "08:00")), true);
});

test("Closed rows override for that day", () => {
  const hours = [["Mon - Sat", "9am-6pm"], ["Sun", "Closed"]];
  assert.strictEqual(isOpenNow(hours, at("sun", "12:00")), false);
  assert.strictEqual(isOpenNow(hours, at("sat", "12:00")), true);
});

test("'to' ranges for days and times", () => {
  const hours = [["Monday to Thursday", "10 to 6pm"]];
  assert.strictEqual(isOpenNow(hours, at("thu", "17:00")), true);
  assert.strictEqual(isOpenNow(hours, at("fri", "12:00")), false);
});

test("ranges that run past midnight", () => {
  const hours = [["Fri-Sat", "6pm-2am"]];
  assert.strictEqual(isOpenNow(hours, at("fri", "23:00")), true);
  assert.strictEqual(isOpenNow(hours, at("sat", "01:30")), true, "Friday's night carries into Saturday");
  assert.strictEqual(isOpenNow(hours, at("sun", "01:30")), true, "Saturday's night carries into Sunday");
  assert.strictEqual(isOpenNow(hours, at("sun", "02:30")), false);
  assert.strictEqual(isOpenNow(hours, at("fri", "01:30")), false, "Thursday isn't listed");
  assert.strictEqual(isOpenNow([["Daily", "18:00 - 00:30"]], at("tue", "00:15")), true);
});

test("split shifts and day lists", () => {
  const hours = [["Mon, Wed & Fri", "11am-2pm, 5pm-9pm"]];
  assert.strictEqual(isOpenNow(hours, at("wed", "12:00")), true);
  assert.strictEqual(isOpenNow(hours, at("wed", "15:00")), false);
  assert.strictEqual(isOpenNow(hours, at("fri", "20:00")), true);
  assert.strictEqual(isOpenNow(hours, at("tue", "12:00")), false);
});

test("noon, midnight and 24 hours", () => {
  assert.strictEqual(isOpenNow([["Sun", "noon-8"]], at("sun", "19:00")), true);
  assert.strictEqual(isOpenNow([["Sun", "6pm-midnight"]], at("sun", "23:59")), true);
  assert.strictEqual(isOpenNow([["Daily", "Open 24 hours"]], at("mon", "03:00")), true);
});

test("abbreviations like Tues and Thurs", () => {
  const hours = [["Tues-Thurs", "9:30am-4:30pm"]];
  assert.strictEqual(isOpenNow(hours, at("tue", "09:30")), true);
  assert.strictEqual(isOpenNow(hours, at("thu", "16:29")), true);
  assert.strictEqual(isOpenNow(hours, at("mon", "12:00")), false);
});

test("days written into the time, or the whole row in the label", () => {
  // Shape of a real listing in the directory.
  const clinic = [
    ["Clinic hours", "Wednesdays, 17:00 - 21:00"],
    ["To schedule", "Call Mon 10:00-15:00 or Tue 10:00-12:00"]
  ];
  assert.strictEqual(isOpenNow(clinic, at("wed", "18:00")), true);
  assert.strictEqual(isOpenNow(clinic, at("mon", "11:00")), false, "call-in hours are not opening hours");
  assert.strictEqual(isOpenNow([["Mon-Fri 9am-5pm", ""]], at("tue", "10:00")), true);
  assert.strictEqual(isOpenNow([["Hours", "Sun closed"], ["Hours", "Mon-Sat 9-5"]], at("sun", "10:00")), false);
  assert.strictEqual(isOpenNow([["Hours", "Sun closed"], ["Hours", "Mon-Sat 9-5"]], at("sat", "16:00")), true);
});

test("unreadable or empty hours are unknown (null)", () => {
  assert.strictEqual(isOpenNow([], at("mon", "12:00")), null);
  assert.strictEqual(isOpenNow(null, at("mon", "12:00")), null);
  assert.strictEqual(isOpenNow([["Ramadan", "after iftar"]], at("mon", "12:00")), null);
  assert.strictEqual(isOpenNow(["Closed"], at("mon", "12:00")), null);
  assert.strictEqual(isOpenNow([["Mon-Fri", "call ahead"]], at("mon", "12:00")), null);
});

test("today unreadable but other days readable stays unknown", () => {
  const hours = [["Mon", "call ahead"], ["Tue-Fri", "9am-5pm"]];
  assert.strictEqual(isOpenNow(hours, at("mon", "12:00")), null);
  assert.strictEqual(isOpenNow(hours, at("tue", "12:00")), true);
});
