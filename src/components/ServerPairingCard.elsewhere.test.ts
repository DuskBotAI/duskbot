import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// React's state is replayed by hand: the offer is the fourth useState
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [f.values[index], () => {}]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: () => {},
}));
import { t } from "@/lib/i18n";
import { ServerPairingCard, type PairingOffer } from "./ServerPairingCard";

const admin = { kind: "session" as const, id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
const OFFER = 3;

function withOffer(offer: PairingOffer): string {
  f.values = []; f.values[OFFER] = offer; f.index = 0;
  return renderToStaticMarkup(createElement(() => ServerPairingCard({ initialSession: admin, elsewhere: { connect: null } })));
}

beforeEach(() => { f.values = []; f.index = 0; });

it("says when a server's code has no public address behind it, and where a phone links instead", () => {
  const html = withOffer({ id: "p", code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000, url: null, hint: "no public address" });
  expect(html).toContain("data-pairing-no-address");
  expect(html).toContain(t("settings.elsewhere.noAddress").replace(/'/g, "&#x27;"));
  // nothing above it tells the person to type the code on the other device
  expect(html).not.toContain(t("settings.elsewhere.codeLive", { minutes: 1 }).split(".")[0]);
});

it("says nothing more when the code comes with a link", () => {
  const html = withOffer({ id: "p", code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000, url: "https://bots.example.com/pair#code=ABCD-EFGH-JKLM", hint: null });
  expect(html).toContain("ABCD-EFGH-JKLM");
  expect(html).toContain(t("settings.elsewhere.codeLive", { minutes: 1 }).split(".")[0]);
  expect(html).not.toContain("data-pairing-no-address");
});
