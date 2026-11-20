// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTransport } from "./transport";

let restore: (() => void) | null = null;
vi.stubGlobal("EventSource", class extends EventTarget {});
afterEach(() => { restore?.(); restore = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

/** a chat image arriving after the phone linked, as a reply's picture does */
function image(onError: () => void) {
  const img = document.createElement("img");
  img.setAttribute("src", "/api/attachments/photo.png");
  img.addEventListener("error", onError);
  document.body.append(img);
  return img;
}

describe("a bot's image on a linked phone", () => {
  it("is not marked broken by the app origin's own failed load while its blob is on the way", async () => {
    let finish: ((response: Response) => void) | null = null;
    window.fetch = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
    restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test" });
    const broken = vi.fn();
    const img = image(broken);
    img.dispatchEvent(new Event("error"));
    expect(broken).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    finish!(new Response("bytes"));
    await vi.waitFor(() => expect(img.getAttribute("src")).toBe("blob:photo"));
    expect(broken).not.toHaveBeenCalled();
  });

  it("says it is broken once the workspace cannot send it", async () => {
    window.fetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test" });
    const broken = vi.fn();
    const img = image(broken);
    await vi.waitFor(() => expect(broken).toHaveBeenCalledOnce());
    expect(img.getAttribute("src")).toBe("/api/attachments/photo.png");
  });
});
