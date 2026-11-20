// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { clockTime, decideDrag, installMessageTimes, revealOffset, TIMES_GUTTER } from "./message-times";

afterEach(() => { document.body.innerHTML = ""; });

describe("dragging the chat to see each message's time", () => {
  it("takes only a clearly sideways drag to the left", () => {
    expect(decideDrag(-4, 2)).toBeNull();
    expect(decideDrag(-30, 5)).toBe("reveal");
    expect(decideDrag(30, 2)).toBe("other");
    expect(decideDrag(-20, 18)).toBe("other");
    expect(decideDrag(2, 40)).toBe("other");
  });

  it("slides as far as the gutter, then resists, and never to the right", () => {
    expect(revealOffset(10)).toBe(0);
    expect(revealOffset(-40)).toBe(-40);
    expect(revealOffset(-TIMES_GUTTER)).toBe(-TIMES_GUTTER);
    expect(revealOffset(-300)).toBeGreaterThan(-TIMES_GUTTER - 24);
  });

  it("tells time the phone's way", () => {
    const at = new Date(2026, 10, 19, 15, 7).getTime();
    expect(clockTime(at, "en-US")).toMatch(/3:07\s?PM/);
    expect(clockTime(at, "en-GB")).toBe("15:07");
  });

  it("writes each row's time, moves the transcript with the finger and lets it go back on release", () => {
    document.body.innerHTML = `<div id="chat"><div role="log"><div data-message-row data-sent-at="${Date.UTC(2026, 10, 19, 9, 30)}"><p id="text">hi</p></div></div></div>`;
    const chat = document.getElementById("chat")!;
    const stop = installMessageTimes(chat);
    const fire = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
      event.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
      document.getElementById("text")!.dispatchEvent(event);
      return event;
    };
    fire("touchstart", 200, 300);
    const move = fire("touchmove", 150, 304);
    const log = chat.querySelector<HTMLElement>("[role='log']")!;
    expect(move.defaultPrevented).toBe(true);
    expect(log.style.transform).toBe("translateX(-50px)");
    expect(chat.querySelector<HTMLElement>("[data-message-row]")!.dataset.time).toBeTruthy();
    fire("touchend", 0, 0);
    expect(log.style.transform).toBe("");
    stop();
  });

  it("leaves a drag from the left edge to the page's swipe back", () => {
    document.body.innerHTML = `<div id="chat"><div role="log"><div data-message-row data-sent-at="1"><p id="text">hi</p></div></div></div>`;
    const chat = document.getElementById("chat")!;
    const stop = installMessageTimes(chat);
    const event = new Event("touchstart", { bubbles: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
    event.touches = [{ clientX: 6, clientY: 300 }];
    document.getElementById("text")!.dispatchEvent(event);
    const move = new Event("touchmove", { bubbles: true, cancelable: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
    move.touches = [{ clientX: -60, clientY: 300 }];
    document.getElementById("text")!.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    stop();
  });
});
