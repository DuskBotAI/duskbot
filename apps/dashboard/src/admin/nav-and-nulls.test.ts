// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { currentItem } from "./AdminApp";
import { accountsCsv, flagOf, stageOf } from "./OpsAccounts";
import { Relays } from "./OpsRelays";
import type { OpsAccountRow, OpsRelayCard, OpsRelayStats } from "./ops-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** the text a tree shows once mounted in a real dom; a render that throws fails the test */
function textOf(element: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  const text = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text;
}

describe("admin nav", () => {
  it("lights the most specific item, so a sub-page is not its parent", () => {
    expect(currentItem("/admin/ops/accounts")?.label).toBe("accounts usage");
    expect(currentItem("/admin/ops")?.label).toBe("ops");
    expect(currentItem("/admin/users/acct_1")?.label).toBe("people");
    expect(currentItem("/admin/people/visitors")?.label).toBe("people");
    expect(currentItem("/admin/analytics/pages")?.label).toBe("overview");
    expect(currentItem("/admin/product/apps")?.label).toBe("product");
    expect(currentItem("/admin/waitlist")?.label).toBe("waitlist");
    expect(currentItem("/admin/experience")?.label).toBe("experience");
    expect(currentItem("/admin/subscribers")?.label).toBe("subscribers");
    expect(currentItem("/admin")?.label).toBe("overview");
    expect(currentItem("/admin/nothing-here")).toBeNull();
  });
});

const stats = (top: OpsRelayStats["top"]): OpsRelayStats => ({
  relay: "contabo", now: { tunnels: 1, accounts: 1, bytesPerSecOut: 10, bytesPerSecIn: 10, cpu: null, rssMb: null }, today: { bytesOut: 5, bytesIn: 5 },
  month: { bytesOut: 50, bytesIn: 50, projectedBytesOut: 100, allowanceBytes: null }, limits: {}, top, busy: false,
});
const card = (s: OpsRelayStats | null): OpsRelayCard => ({ id: "contabo", label: "contabo relay", url: "https://link.test", at: 0, configured: true, ok: !!s, error: s ? null : "The relay's numbers are not reported yet.", stats: s });

describe("ops pages with missing fields", () => {
  // preview's contabo node sends top rows with account null; the card read row.account.slice and the page crashed
  it("renders a relay's top row that has no account", () => {
    const html = textOf(createElement(Relays, { data: { relays: [card(stats([{ account: null, tunnels: 2, bytesToday: 900 }]))], at: 0 }, error: null, setData: () => {} }));
    expect(html).toContain("no account");
  });

  it("says a relay without numbers is not reported yet", () => {
    const html = textOf(createElement(Relays, { data: { relays: [card(null)], at: 0 }, error: null, setData: () => {} }));
    expect(html).toContain("not reported yet");
  });

  it("reads an unknown fair use step or flag as words, and exports rows without flags", () => {
    expect(stageOf("paused")).toEqual({ word: "paused", level: "unknown" });
    expect(stageOf("")).toMatchObject({ word: "not reported yet" });
    expect(flagOf("new-kind")).toMatchObject({ word: "new-kind" });
    const row = { accountId: null, ref: "r1", email: null, plan: null, relay: { monthBytes: 1e9, share: 0.1, stage: "paused", bytesPerSec: 0 }, cloud: null, emails: null, codes: null,
      flags: undefined } as unknown as OpsAccountRow;
    expect(accountsCsv([row]).split("\n")[1]).toBe(",r1,,1,paused,10,,,,,");
  });
});
