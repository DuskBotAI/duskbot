// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: Root;
let host: HTMLDivElement;
const answers: Array<() => Promise<Response>> = [];
const fetchMock = vi.fn(() => (answers.shift() ?? (() => Promise.reject(new TypeError("offline"))))());

async function mountButton() {
  const availability = await import("./availability");
  const seen: Array<boolean | null> = [];
  function Probe() {
    seen.push(availability.useLocalVoiceCall());
    return null;
  }
  flushSync(() => root.render(createElement(Probe)));
  return { availability, seen };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  answers.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("AudioContext", class {});
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => Promise.resolve() }, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("whether a call with the built-in voice can run on this place", () => {
  it("treats no answer (offline, a Cloud asleep) as unknown and asks again, instead of calling calls off for the session", async () => {
    answers.push(() => Promise.resolve(new Response("{}", { status: 503 })));
    answers.push(() => Promise.resolve(Response.json({ available: true })));
    const { availability } = await mountButton();
    await settle();
    expect(availability.localVoiceCallKnown()).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(availability.localVoiceCallKnown()).toBe(true);
  });

  it("asks the new place afresh when the phone switches to another computer or cloud", async () => {
    answers.push(() => Promise.resolve(Response.json({ available: false })));
    answers.push(() => Promise.resolve(Response.json({ available: true })));
    const { availability, seen } = await mountButton();
    await settle();
    expect(availability.localVoiceCallKnown()).toBe(false);
    flushSync(() => availability.forgetLocalVoiceCall());
    await settle();
    expect(availability.localVoiceCallKnown()).toBe(true);
    expect(seen.at(-1)).toBe(true);
  });

  it("drops an answer from the place it left", async () => {
    let answerOld: (res: Response) => void = () => {};
    answers.push(() => new Promise((resolve) => { answerOld = resolve; }));
    answers.push(() => Promise.resolve(Response.json({ available: true })));
    const { availability } = await mountButton();
    availability.forgetLocalVoiceCall();
    await settle();
    answerOld(Response.json({ available: false }));
    await settle();
    expect(availability.localVoiceCallKnown()).toBe(true);
  });
});
