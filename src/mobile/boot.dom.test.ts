// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { mountMobile } from "./boot";
import { webPlatform } from "./platform";

it("reaches onboarding while one optional preference is stalled and another is rejected", async () => {
  window.history.replaceState({}, "", "/?pair");
  document.body.innerHTML = '<div id="root"></div>';
  const platform = webPlatform();
  const read = platform.prefs.get;
  platform.prefs.get = async (key) => {
    if (key === "dusk.mobile.haptics") return new Promise(() => {});
    if (key === "dusk.mobile.liveActivity") throw new Error("unavailable");
    return read(key);
  };
  mountMobile(platform);
  await vi.waitFor(() => expect(document.querySelector("[data-entry=code]")?.textContent).toContain("Enter a code"));
});
