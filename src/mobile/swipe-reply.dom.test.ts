// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { installHaptics } from "./haptics";
import { installMessageTimes } from "./message-times";
import type { MobilePlatform } from "./platform";
import { decideReplyDrag, installSwipeReply, REPLY_MAX, REPLY_THRESHOLD, replyOffset, replyRowAt } from "./swipe-reply";

afterEach(() => { document.body.innerHTML = ""; });

type Touchy = Event & { touches: Array<{ clientX: number; clientY: number }> };
function fire(id: string, type: string, x: number, y: number): Touchy {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Touchy;
  event.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
  document.getElementById(id)!.dispatchEvent(event);
  return event;
}

function chatWith({ own = false, extra = "" } = {}) {
  const onReply = vi.fn();
  document.body.innerHTML = `<div id="chat" data-mobile-chat><div role="log">
    <div id="row" data-message-row data-sent-at="1">
      <div ${own ? "data-own-row" : ""}><div data-chat-bubble><p id="text">hi</p>${extra}</div>
      <div data-testid="message-actions"><button id="reply" aria-label="${t("chat.replyToMessage")}"><svg></svg></button></div></div>
    </div>
    <div id="bare" data-message-row><p id="plain">no actions</p></div>
  </div></div>`;
  document.getElementById("reply")!.addEventListener("click", onReply);
  const chat = document.getElementById("chat")!;
  return { chat, onReply, row: document.getElementById("row")! };
}

describe("swipe a message to reply", () => {
  it("takes only a clearly sideways drag to the right", () => {
    expect(decideReplyDrag(4, 2)).toBeNull();
    expect(decideReplyDrag(30, 5)).toBe("reply");
    expect(decideReplyDrag(-30, 2)).toBe("other");
    expect(decideReplyDrag(20, 14)).toBe("other");
    expect(decideReplyDrag(2, 40)).toBe("other");
  });

  it("follows the finger to the threshold, then rubber-bands, never past the max or to the left", () => {
    expect(replyOffset(-20, 45)).toBe(0);
    expect(replyOffset(30, 45)).toBe(30);
    expect(replyOffset(45, 45)).toBe(45);
    expect(replyOffset(145, 45)).toBeCloseTo(45 + (1 - 1 / (100 * 0.4 / 100 + 1)) * 100);
    expect(replyOffset(5000, 60)).toBeLessThanOrEqual(REPLY_MAX);
  });

  it("starts only on a message that offers Reply, away from the back-swipe edge, never in a sideways scroller", () => {
    chatWith({ extra: `<div id="code" style="overflow-x:auto"><pre id="pre">x</pre></div>` });
    const code = document.getElementById("code")!;
    Object.defineProperty(code, "scrollWidth", { value: 600 });
    Object.defineProperty(code, "clientWidth", { value: 200 });
    expect(replyRowAt(document.getElementById("text"), 120)).toBe(document.getElementById("row"));
    expect(replyRowAt(document.getElementById("text"), 10)).toBeNull();
    expect(replyRowAt(document.getElementById("plain"), 120)).toBeNull();
    expect(replyRowAt(document.getElementById("pre"), 120)).toBeNull();
  });

  it("slides the row with a transform, taps once at the threshold and opens the reply on release", () => {
    const platform = { haptic: vi.fn(), prefs: { get: async () => null, set: async () => {} } } as unknown as MobilePlatform;
    void installHaptics(platform);
    const { chat, onReply, row } = chatWith();
    const stop = installSwipeReply(chat);
    fire("text", "touchstart", 100, 300);
    const move = fire("text", "touchmove", 130, 302);
    expect(move.defaultPrevented).toBe(true);
    expect(row.style.translate).toBe("30px 0");
    expect(document.querySelector(".m-swipe-reply")).not.toBeNull();
    expect(platform.haptic).not.toHaveBeenCalled();
    fire("text", "touchmove", 100 + REPLY_THRESHOLD.incoming + 5, 302);
    fire("text", "touchmove", 100 + REPLY_THRESHOLD.incoming + 40, 302);
    expect(platform.haptic).toHaveBeenCalledTimes(1);
    expect(platform.haptic).toHaveBeenCalledWith("medium");
    const end = fire("text", "touchend", 0, 0);
    expect(end.defaultPrevented).toBe(true);
    expect(row.style.translate).toBe("");
    expect(onReply).toHaveBeenCalledTimes(1);
    stop();
  });

  it("lets go short of the threshold without replying, and asks more of your own messages", () => {
    const { chat, onReply, row } = chatWith({ own: true });
    const stop = installSwipeReply(chat);
    fire("text", "touchstart", 100, 300);
    fire("text", "touchmove", 100 + 50, 300);
    expect(row.style.translate).toBe("50px 0");
    expect(document.querySelector(".m-swipe-reply")!.hasAttribute("data-armed")).toBe(false);
    fire("text", "touchend", 0, 0);
    expect(onReply).not.toHaveBeenCalled();
    stop();
  });

  it("leaves a vertical scroll and the left-drag time peek alone", () => {
    const { chat, onReply, row } = chatWith();
    const stopTimes = installMessageTimes(chat);
    const stop = installSwipeReply(chat);
    fire("text", "touchstart", 200, 300);
    const up = fire("text", "touchmove", 203, 360);
    expect(up.defaultPrevented).toBe(false);
    fire("text", "touchend", 0, 0);
    fire("text", "touchstart", 200, 300);
    fire("text", "touchmove", 150, 302);
    expect(row.style.translate).toBe("");
    expect(chat.querySelector<HTMLElement>("[role='log']")!.style.transform).toBe("translateX(-50px)");
    fire("text", "touchend", 0, 0);
    expect(onReply).not.toHaveBeenCalled();
    stop();
    stopTimes();
  });
});
