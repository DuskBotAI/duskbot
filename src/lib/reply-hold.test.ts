// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { landingReply, READING_PEEK_PX, replyHoldTop } from "./reply-hold";

describe("replyHoldTop", () => {
  it("stops a reply taller than the view just under the header, with the row above's end in view", () => {
    expect(replyHoldTop({ replyTop: 900, inset: 56, end: 1300, current: 400 })).toBe(900 - 56 - READING_PEEK_PX);
  });

  it("follows to the end when that keeps the reply's top in view", () => {
    expect(replyHoldTop({ replyTop: 900, inset: 56, end: 700, current: 400 })).toBeNull();
  });

  it("never holds a view already past the reply's top: a reader back at the end keeps following", () => {
    expect(replyHoldTop({ replyTop: 900, inset: 0, end: 1600, current: 1200 })).toBeNull();
  });
});

describe("landingReply", () => {
  const row = (arrival: "start" | "end") => { const el = document.createElement("div"); el.setAttribute("data-arrival", arrival); return el; };

  it("is the first of the bot's rows landing after the person's last one", () => {
    const [mine, first, second] = [row("end"), row("start"), row("start")];
    expect(landingReply([mine, first, second])).toBe(first);
    expect(landingReply([first, row("end")])).toBeNull();
  });
});
