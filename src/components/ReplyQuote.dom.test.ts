// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", async (original) => ({
  ...await original<typeof import("@/state/api")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { ThreadReplyQuote } = await import("./ReplyQuote");

setLocale("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE = "/data/attachments/123e4567-e89b-42d3-a456-426614174000.png";
const old: Message = { id: "old-1", role: "user", kind: "text", at: 1, text: `My receipt\n\n<attached-image path="${IMAGE}" name="receipt.png" />` };

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; fixture.api.mockReset(); });

async function mount(props: Parameters<typeof ThreadReplyQuote>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ThreadReplyQuote, props)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return host;
}

describe("a sent reply whose quoted message is far back", () => {
  it("reads the quoted message on its own and shows its words and picture", async () => {
    fixture.api.mockResolvedValue({ messages: [old] });
    const onJump = vi.fn();
    const host = await mount({ threadId: "t-far", replyToId: "old-1", loaded: undefined, onJump });
    expect(fixture.api).toHaveBeenCalledWith("/api/threads/t-far/messages?around=old-1&limit=1");
    expect(host.querySelector("[data-reply-quote]")?.textContent).toContain("My receipt");
    expect(host.querySelector("[data-reply-thumbnail]")?.getAttribute("src")).toBe("/api/attachments/123e4567-e89b-42d3-a456-426614174000.png");
    act(() => host.querySelector<HTMLButtonElement>("[data-reply-quote] button")!.click());
    expect(onJump).toHaveBeenCalledWith(old);
  });

  it("uses the loaded message without asking the server", async () => {
    const host = await mount({ threadId: "t-near", replyToId: "old-1", loaded: old, onJump: () => {} });
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.querySelector("[data-reply-quote]")).not.toBeNull();
  });

  it("shows nothing when the quoted message is gone", async () => {
    fixture.api.mockRejectedValue(Object.assign(new Error("no such message"), { status: 404 }));
    const host = await mount({ threadId: "t-gone", replyToId: "old-1", loaded: undefined, onJump: () => {} });
    expect(host.querySelector("[data-reply-quote]")).toBeNull();
  });
});
