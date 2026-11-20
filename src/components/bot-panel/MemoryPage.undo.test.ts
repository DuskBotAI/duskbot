// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {} }, dispatch: vi.fn() }) };
});

const { MemoryPage } = await import("./pages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bot = { id: "scout", threadId: "t1", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "x", model: "x" } } as unknown as Bot;
const files: Record<string, string> = {};
const puts: Array<{ text: string; expectedHash?: string }> = [];
const hash = (text: string) => `h:${text}`;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  puts.length = 0;
  for (const key of Object.keys(files)) delete files[key];
  files["MEMORY.md"] = "# Memory\n- Ada likes durian\n- Ada runs on Sundays\n";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as { path: string; text: string; expectedHash?: string } : null;
    const path = body?.path ?? url.searchParams.get("path") ?? "MEMORY.md";
    const current = files[path] ?? "";
    if (method === "PUT" && body) {
      puts.push({ text: body.text, expectedHash: body.expectedHash });
      if (body.expectedHash !== undefined && body.expectedHash !== hash(current)) return reply(409, { error: "changed", current, currentHash: hash(current) });
      files[path] = body.text;
    }
    const text = files[path] ?? "";
    return reply(200, { path, text, hash: hash(text), exists: path in files, overview: {} });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const toast = () => document.querySelector<HTMLElement>("[data-access-toast]:not([data-exit-ghost])");
const forgetFirst = async () => {
  await act(async () => root.render(createElement(MemoryPage, { bot, derived: {} as never })));
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-memory-note] button")!.click());
  await settle();
};
const undo = async () => {
  const button = [...toast()!.querySelectorAll("button")].find((candidate) => candidate.textContent === "Undo")!;
  await act(async () => button.click());
  await settle();
};

it("forget offers Undo, which brings the note back over exactly the version the forget left", async () => {
  await forgetFirst();
  expect(files["MEMORY.md"]).not.toContain("durian");
  expect(toast()?.textContent).toContain("Note forgotten");
  await undo();
  expect(puts.at(-1)).toEqual({ text: "# Memory\n- Ada likes durian\n- Ada runs on Sundays\n", expectedHash: hash("# Memory\n- Ada runs on Sundays\n") });
  expect(files["MEMORY.md"]).toContain("Ada likes durian");
  expect(host.textContent).toContain("Ada likes durian");
  expect(toast()).toBeNull();
});

it("never writes over a note saved since: the undo says it couldn't, and the new note stays", async () => {
  await forgetFirst();
  files["MEMORY.md"] += "- Ada moved to Lisbon\n";
  await undo();
  expect(files["MEMORY.md"]).toContain("Lisbon");
  expect(files["MEMORY.md"]).not.toContain("durian");
  expect(toast()?.textContent).toContain("Memory changed since, so the note couldn't come back.");
});
