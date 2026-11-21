// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { cornerRadii, createNativeHold, type MenuBridge, type NativeMenuArm, type NativeMenuContent, type NativeMenuEvent } from "./native-menu";
import { heldBubble, nativeMessageMenu } from "./MessageHold";

function fakeBridge() {
  let listener: ((event: NativeMenuEvent) => void) | null = null;
  const arms: NativeMenuArm[] = [];
  const disarms: (string | undefined)[] = [];
  const resolved: { id: string; content: NativeMenuContent }[] = [];
  const bridge: MenuBridge = {
    arm: (options) => { arms.push(options); },
    disarm: (id) => { disarms.push(id); },
    resolve: (id, content) => { resolved.push({ id, content }); },
    onEvent: (next) => { listener = next; return () => { listener = null; }; },
  };
  return { bridge, arms, disarms, resolved, send: (event: NativeMenuEvent) => listener?.(event), listening: () => listener !== null };
}

function place(el: Element, x: number, y: number, w: number, h: number) {
  el.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("native hold", () => {
  it("arms the held item's frame and corners on touch, then its menu once the finger has held still", async () => {
    const fake = fakeBridge();
    const hold = createNativeHold(fake.bridge, "message");
    const el = document.createElement("div");
    el.style.borderRadius = "19px 19px 19px 6px";
    document.body.append(el);
    place(el, 16.2, 300, 240, 38);
    const select = vi.fn();
    hold.press(el, () => ({ content: { items: [{ key: "copy", title: "Copy" }] }, select }), { prefetchMs: 280 });
    expect(fake.arms).toEqual([{ id: "message:1", rect: { x: 16, y: 300, w: 240, h: 38 }, radii: [19, 19, 19, 6] }]);
    vi.advanceTimersByTime(279);
    await flush();
    expect(fake.arms).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(fake.arms[1]).toMatchObject({ id: "message:1", content: { items: [{ key: "copy", title: "Copy" }] } });
    fake.send({ type: "select", id: "message:1", key: "copy" });
    await flush();
    expect(select).toHaveBeenCalledWith("copy");
  });

  it("answers the system's request when the press beat the read, and hides the page's copy while the menu is up", async () => {
    const fake = fakeBridge();
    const hold = createNativeHold(fake.bridge, "chat");
    const el = document.createElement("button");
    document.body.append(el);
    place(el, 8, 100, 374, 76);
    const react = vi.fn();
    hold.press(el, () => ({ content: { items: [], reactions: [{ key: "Love", title: "Love", glyph: "❤️" }] }, select: () => {}, react }), { prefetchMs: 280 });
    fake.send({ type: "request", id: "chat:1" });
    await flush();
    expect(fake.resolved).toEqual([{ id: "chat:1", content: { items: [], reactions: [{ key: "Love", title: "Love", glyph: "❤️" }] } }]);
    fake.send({ type: "open", id: "chat:1" });
    expect(el.style.visibility).toBe("hidden");
    vi.advanceTimersByTime(500);
    await flush();
    // opened: the late prefetch never re-arms
    expect(fake.arms).toHaveLength(1);
    fake.send({ type: "react", id: "chat:1", key: "Love" });
    await flush();
    expect(react).toHaveBeenCalledWith("Love");
    fake.send({ type: "close", id: "chat:1" });
    expect(el.style.visibility).toBe("");
  });

  it("disarms when the finger moves off, and ignores another hold's events", async () => {
    const fake = fakeBridge();
    const hold = createNativeHold(fake.bridge, "message");
    const el = document.createElement("div");
    document.body.append(el);
    place(el, 0, 0, 100, 40);
    const describe = vi.fn(() => null);
    hold.press(el, describe, { prefetchMs: 280 });
    hold.cancel();
    vi.advanceTimersByTime(400);
    await flush();
    expect(fake.disarms).toEqual(["message:1"]);
    expect(describe).not.toHaveBeenCalled();
    fake.send({ type: "open", id: "chat:1" });
    expect(el.style.visibility).toBe("");
    hold.dispose();
    expect(fake.listening()).toBe(false);
  });

  it("disarms an item that turns out to offer nothing", async () => {
    const fake = fakeBridge();
    const hold = createNativeHold(fake.bridge, "message");
    const el = document.createElement("div");
    document.body.append(el);
    place(el, 0, 0, 100, 40);
    hold.press(el, () => null);
    await flush();
    expect(fake.disarms).toEqual(["message:1"]);
  });

  it("reads percentage corners against the shorter side", () => {
    const el = document.createElement("div");
    el.style.borderRadius = "50%";
    document.body.append(el);
    place(el, 0, 0, 60, 40);
    expect(cornerRadii(el)).toEqual([20, 20, 20, 20]);
  });

  it("forwards the touch point and ignores duplicate open events", () => {
    const fake = fakeBridge();
    const hold = createNativeHold(fake.bridge, "message");
    const el = document.createElement("div");
    document.body.append(el);
    place(el, 16, 100, 240, 400);
    const onOpen = vi.fn();
    hold.press(el, () => ({ content: { items: [{ key: "copy", title: "Copy" }] }, select: () => {} }), { prefetchMs: 80, point: { x: 84.4, y: 210.6 }, onOpen });
    expect(fake.arms[0]).toMatchObject({ id: "message:1", point: { x: 84, y: 211 } });
    fake.send({ type: "open", id: "message:1" });
    fake.send({ type: "open", id: "message:1" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(el.style.visibility).toBe("hidden");
  });
});

describe("a message's native menu", () => {
  function message() {
    document.body.innerHTML = `
      <div data-mobile-chat>
        <div data-message-row>
          <div data-chat-bubble="simple"><span id="text">hello</span><button id="link">open</button></div>
          <div data-testid="message-actions">
            <button aria-label="${t("chat.replyToMessage")}"><svg></svg></button>
          </div>
        </div>
      </div>`;
    return { text: document.getElementById("text")!, link: document.getElementById("link")!, row: document.querySelector<HTMLElement>("[data-message-row]")! };
  }

  it("is held from the bubble's text, not from a control inside it", () => {
    const { text, link, row } = message();
    expect(heldBubble(text)?.row).toBe(row);
    expect(heldBubble(link)).toBeNull();
  });

  it("offers the bar's own actions with SF Symbols, and choosing one presses that control", async () => {
    vi.useRealTimers();
    const { row } = message();
    const reply = vi.fn();
    row.querySelector("[data-testid='message-actions'] button")!.addEventListener("click", reply);
    const menu = await nativeMessageMenu(row);
    expect(menu?.content.items).toEqual([{ key: `bar:${t("chat.replyToMessage")}`, title: t("chat.replyToMessage"), icon: "arrowshape.turn.up.left", disabled: undefined }]);
    menu?.select(`bar:${t("chat.replyToMessage")}`);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
