// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { CloudMacCard } = await import("./CloudMacCard");

afterEach(() => {
  delete window.duskDesktop;
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: true, enabled: false, online: false }), { status: 200 })));
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => { root.render(createElement(CloudMacCard)); });
  const text = host.textContent ?? "";
  await act(async () => { root.unmount(); });
  return text;
}

it("shows nothing about using this computer on Windows or Linux, where the Mac tools cannot run", async () => {
  window.duskDesktop = { platform: "win32" } as any;
  expect(await render()).toBe("");
  window.duskDesktop = { platform: "linux" } as any;
  expect(await render()).toBe("");
});

it("still says where to turn it on from a Mac or a browser", async () => {
  window.duskDesktop = { platform: "darwin" } as any;
  expect(await render()).not.toBe("");
  delete window.duskDesktop;
  expect(await render()).not.toBe("");
});
