import { describe, expect, it } from "vitest";

import { autoRoutineName, editedSchedule, newWhenDraft, nextLocalHour, scheduleFromDraft, whenDraftFor } from "./routine-when";

const now = new Date(2026, 10, 7, 21, 13).getTime();

describe("the routine editor's when", () => {
  it("starts a new routine every day at 9 AM", () => {
    expect(scheduleFromDraft(newWhenDraft(now), now)).toEqual({ schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  });

  it("reads saved schedules as the presets that say them, and keeps the rest", () => {
    expect(whenDraftFor({ type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, now)).toMatchObject({ preset: "weekdays", time: "08:30" });
    expect(whenDraftFor({ type: "daily", time: "10:00", weekdays: [4] }, now)).toMatchObject({ preset: "weekly", day: 4, time: "10:00" });
    expect(whenDraftFor({ type: "interval", everyMinutes: 60, anchorAt: now }, now).preset).toBe("hourly");
    expect(whenDraftFor({ type: "interval", everyMinutes: 60, anchorAt: now, window: { start: "09:00", end: "17:00" } }, now)).toMatchObject({ preset: "hourly", window: { start: "09:00", end: "17:00" } });
    expect(whenDraftFor({ type: "interval", everyMinutes: 30, anchorAt: now, window: { start: "09:00", end: "17:00" } }, now).preset).toBe("keep");
    expect(whenDraftFor({ type: "daily", time: "10:00", weekdays: [1, 3] }, now).preset).toBe("keep");
    expect(whenDraftFor({ type: "cron", expression: "0 9 1 * *", timeZone: "UTC" }, now).preset).toBe("keep");
    expect(scheduleFromDraft(whenDraftFor({ type: "cron", expression: "0 9 1 * *", timeZone: "UTC" }, now), now)).toEqual({});
  });

  it("saves each preset as the schedule the server keeps", () => {
    const draft = newWhenDraft(now);
    expect(scheduleFromDraft({ ...draft, preset: "weekly", day: 2, time: "18:00" }, now).schedule).toEqual({ type: "daily", time: "18:00", weekdays: [2] });
    // a new one leaves its hours to the server (the person's waking hours); a saved one keeps what it says
    expect(scheduleFromDraft({ ...draft, preset: "hourly" }, now).schedule).toEqual({ type: "interval", everyMinutes: 60, anchorAt: nextLocalHour(now), weekdays: null, endsAt: null });
    expect(scheduleFromDraft({ ...draft, preset: "hourly", window: null }, now).schedule).toMatchObject({ window: null });
    expect(scheduleFromDraft({ ...draft, preset: "hourly", window: { start: "07:00", end: "23:00" } }, now).schedule).toMatchObject({ window: { start: "07:00", end: "23:00" } });
    expect(scheduleFromDraft({ ...draft, preset: "hourly", window: { start: "23:00", end: "07:00" } }, now).error).toBe("routines.inline.error.hours");
    expect(whenDraftFor({ type: "interval", everyMinutes: 60, anchorAt: now, window: { start: "07:00", end: "23:00" } }, now)).toMatchObject({ preset: "hourly", window: { start: "07:00", end: "23:00" } });
    expect(new Date(nextLocalHour(now)).getHours()).toBe(22);
    expect(scheduleFromDraft({ ...draft, preset: "once", date: "2026-11-08", time: "07:00" }, now).schedule).toEqual({ type: "once", at: new Date(2026, 10, 8, 7, 0).getTime() });
  });

  it("refuses a time that has passed or is missing", () => {
    const draft = newWhenDraft(now);
    expect(scheduleFromDraft({ ...draft, preset: "once", date: "2026-11-07", time: "08:00" }, now).error).toBe("routines.inline.error.past");
    expect(scheduleFromDraft({ ...draft, time: "" }, now).error).toBe("routines.inline.error.time");
    expect(scheduleFromDraft({ ...draft, preset: "hourly", window: { start: "", end: "23:00" } }, now).error).toBe("routines.inline.error.time");
  });

  it("keeps a saved schedule, and its next run, until the when changes", () => {
    const hourly = whenDraftFor({ type: "interval", everyMinutes: 60, anchorAt: now + 35 * 60_000, window: { start: "07:00", end: "23:00" } }, now);
    expect(editedSchedule(hourly, { ...hourly }, now)).toEqual({});
    expect(editedSchedule(hourly, { ...hourly, window: { start: "07:00", end: "23:00" } }, now)).toEqual({});
    expect(editedSchedule(hourly, { ...hourly, window: null }, now).schedule).toMatchObject({ type: "interval", window: null });
    expect(editedSchedule(hourly, { ...hourly, preset: "daily" }, now).schedule).toMatchObject({ type: "daily" });
    expect(editedSchedule(hourly, { ...hourly, preset: "daily", time: "" }, now).error).toBe("routines.inline.error.time");
    expect(editedSchedule(hourly, { ...hourly, window: { start: "08:00", end: "23:00" } }, now).schedule).toMatchObject({ type: "interval", window: { start: "08:00" } });
    const passed = whenDraftFor({ type: "once", at: now - 60_000 }, now);
    expect(editedSchedule(passed, { ...passed }, now)).toEqual({});
    const daily = whenDraftFor({ type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, now);
    expect(editedSchedule(daily, { ...daily, preset: "weekly" }, now).schedule).toMatchObject({ type: "daily", weekdays: [daily.day] });
    expect(editedSchedule(daily, { ...daily, time: "10:00" }, now).schedule).toMatchObject({ time: "10:00" });
  });

  it("names a routine from what it does", () => {
    expect(autoRoutineName("please check the news. Then send it")).toBe("Check the news");
    expect(autoRoutineName("Summarize every unread email from my team and the three newsletters I follow")).toBe("Summarize every unread email from my team and…");
    expect(autoRoutineName("  ")).toBe("");
  });
});
