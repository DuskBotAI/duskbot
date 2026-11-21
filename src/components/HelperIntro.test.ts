// @vitest-environment happy-dom
// Dusk's first messages: one message, a starter card of three first jobs and the person's own words, and chips for only
// what is still missing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWelcomingBot, stageIntro } from "@/lib/default-bot";
import { setLocale, t } from "@/lib/i18n";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { HelperFollowupFacts } from "../../shared/helper-followup";
import { rememberConnectorStatus } from "@/lib/connected-apps";

const f = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, dispatch: vi.fn(), local: false, reduced: false,
  services: {} as Record<string, { connected: boolean }>, phones: [] as unknown[], found: null as unknown, detect: vi.fn(),
  followups: [] as unknown[], saves: true, bots: 0, routines: 0, improve: true as boolean | undefined, improveSaves: [] as unknown[],
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: f.state, dispatch: f.dispatch }),
  api: async (path: string, init?: { body?: string }) => {
    if (path === "/api/phones") return { phones: f.phones };
    if (path.endsWith("/helper-followup")) {
      const body = JSON.parse(init?.body ?? "{}");
      f.followups.push(body);
      if (!f.saves) throw new Error("older server");
      return { message: { id: "f", role: "bot", kind: "text", at: 2, text: "", helperFollowup: { ai: body.ai, apps: body.apps, bots: f.bots, routines: f.routines } } };
    }
    return {};
  },
}));
// the help-improve switch reads and saves through the plain api
vi.mock("@/state/api", () => ({
  api: async (path: string, init?: { body?: string }) => {
    if (path !== "/api/dashboard/usage-signals") return {};
    if (init?.body) f.improveSaves.push(JSON.parse(init.body));
    return init?.body ? JSON.parse(init.body) : f.improve === undefined ? {} : { enabled: f.improve };
  },
}));
vi.mock("./bot-settings/useBotApps", () => ({ loadAppCards: async () => new Map([["gmail", { label: "Gmail" }], ["github", { label: "GitHub" }]]) }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./mascot-clock", () => ({ usePrefersReducedMotion: () => f.reduced }));
vi.mock("./onboarding/ConnectAi", async () => {
  const { createElement: h } = await import("react");
  return { ConnectAiDialog: ({ onClose }: { onClose: () => void }) => h("div", { "data-connect-ai": "", onClick: onClose }) };
});
vi.mock("./onboarding/welcome-ai", () => ({ useWelcomeAi: () => null }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
vi.mock("@/lib/setup-import", () => ({
  localSetupImport: () => f.local,
  setupImportApi: {},
  detectSetupWithin: () => { f.detect(); return { found: Promise.resolve(f.found), cancel: () => {} }; },
}));
const { HelperIntro } = await import("./HelperIntro");
const { followupLine, INTRO_TIMING, introLine, introLines, whoConnectsAi } = await import("./SimpleHelperIntro");
const { setTeamPeople } = await import("@/state/team-people");
const { chipAction } = await import("./HelperSetup");
const { SIMPLE_BOT_BUBBLE } = await import("./chat-bubble");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean): InstanceInfo => ({ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] } });
const maus = (extra: Partial<Bot> = {}): Bot => ({ id: "maus", threadId: "t", name: "Dusk", title: "", description: "", notifications: true,
  color: "chrome", unread: false, modelSelection: { instanceId: "claude", model: "m" }, messages: [], defaultBot: {}, chiefOfStaff: true, ...extra });
const intro: Message = { id: "intro", role: "bot", kind: "options", at: 1, helperIntro: true, text: "Hey! I'm Dusk. I'm new here.",
  card: { title: "Hey! I'm Dusk. I'm new here.", subtitle: "", options: ["What are my bots up to?"] } };
const saved = (facts: HelperFollowupFacts): Message => ({ id: "f", role: "bot", kind: "text", at: 2, text: "English", helperFollowup: facts });

let host: HTMLDivElement, root: Root;
const lines = () => [...host.querySelectorAll("[data-helper-line]")].map((node) => node.textContent);
const asks = () => [...host.querySelectorAll<HTMLElement>("[data-helper-ask]")].map((node) => node.textContent);
const chips = () => [...host.querySelectorAll<HTMLElement>("[data-helper-step]")].map((node) => node.dataset.helperStep);
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const show = async (answered = false, followup?: Message) => {
  await act(async () => { root.render(createElement(HelperIntro, { botId: "maus", threadId: "t", message: intro, answered, followup })); });
  await settle();
};
const tick = async (ms: number) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await settle();
};

beforeEach(() => {
  // these runs offer the phone app; the hidden phone has its own case below
  vi.stubEnv("VITE_DUSK_PHONE_APP", "1");
  setLocale("en");
  f.dispatch.mockReset();
  f.detect.mockReset();
  analytics.track.mockReset();
  f.local = false;
  f.reduced = false;
  f.services = {};
  f.phones = [];
  f.found = null;
  f.followups = [];
  f.saves = true;
  f.bots = 0;
  f.routines = 0;
  f.improve = true;
  f.improveSaves = [];
  f.state = { connected: true, bots: [maus()], instances: [claude(true)], config: { profile: { name: "" } } };
  stageIntro(null);
  setWelcomingBot(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("what Dusk says first", () => {
  it("as the Chief: one message, who it is and that it wants one real job, never by the person's name", () => {
    expect(introLine({ name: "Dusk", chief: true })).toBe("Hi! I'm Dusk. Hand me one real job and I'll get it done.");
    expect(introLine({ name: "Dusk", chief: true, person: "Ada" })).toBe("Hi! I'm Dusk. Hand me one real job and I'll get it done.");
  });

  it("on a cloud set up from the computer: the Chief greets the person by name and says what came along", () => {
    const line = introLine({ name: "Dusk", chief: true, person: "Ada", fromComputer: true, carried: true });
    expect(line).toMatch(/^Hi Ada! I'm Dusk\./);
    expect(line).toMatch(/I brought over what you told me about yourself on your computer\.$/);
  });

  it("keeps a helper's hello and what it does for a Dusk that is not the Chief, or a Team Cloud member's", () => {
    expect(introLine({ name: "Dusk", chief: false })).toBe(`${introLines({ name: "Dusk", chief: false })[0]} ${introLines({ name: "Dusk", chief: false })[1]}`);
    expect(introLine({ name: "Dusk", chief: false, team: "Acme" })).toContain("On Acme, I'm here for you and look after your own bots.");
  });

  it("a follow-up an older intro wrote never names the AI it thinks with", () => {
    const none = { apps: [], bots: 0, routines: 0 };
    expect(followupLine({ ai: "own", apps: ["Gmail", "GitHub"], bots: 0, routines: 0 })).toContain("I can already use Gmail and GitHub.");
    expect(followupLine({ ai: "none", ...none })).toBe(t("helperIntro.followup.noAi"));
    expect(followupLine({ ai: "backup", ...none })).toContain("free backup model");
    expect(whoConnectsAi(null), "off a team").toBeUndefined();
  });
});

describe("in the chat (Simple mode)", () => {
  it("says one message as the chat's own bubble, then the starter card, then chips for only what is missing", async () => {
    f.services = { gmail: { connected: false } };
    await show();
    expect(lines()).toEqual(["Hi! I'm Dusk. Hand me one real job and I'll get it done."]);
    const first = host.querySelector<HTMLElement>('[data-helper-line="0"]')!;
    expect(first.dataset.chatBubble, "the chat's own Simple bubble").toBe("simple");
    expect(first.className).toContain(SIMPLE_BOT_BUBBLE);
    expect(host.querySelector("[data-helper-start]")?.textContent).toContain("What should we start with?");
    expect(asks()).toEqual(["Help me plan my week", "Watch a price for me", "Research something for me"]);
    expect(host.querySelector("[data-helper-start] textarea")?.getAttribute("aria-label"), "and the person's own words").toBe("Something else");
    expect(chips()).toEqual(["apps", "phone", "cloud"]);
    expect(f.followups, "no follow-up is asked for any more").toEqual([]);
  });

  it("keeps the follow-up an older intro already wrote, under its message", async () => {
    await show(true, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    expect(lines()).toHaveLength(2);
    expect(host.querySelector("[data-helper-followup]")?.textContent).toContain("nothing's waiting on you yet");
  });

  it("shows no card or chips while the app connects or reconnects, or the transcript is still loading", async () => {
    f.state = { ...f.state, connected: false };
    await show();
    expect(chips()).toEqual([]);
    expect(host.querySelector("[data-helper-start]")).toBeNull();
    f.state = { ...f.state, connected: true, bots: [maus({ transcriptLoaded: false })] };
    await show();
    expect(host.querySelector("[data-helper-start]")).toBeNull();
    f.state = { ...f.state, bots: [maus()] };
    await show();
    expect(host.querySelector("[data-helper-start]"), "back under the message once the chat is shown").not.toBeNull();
  });

  it("offers no phone while the phone app is hidden", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    await show();
    expect(chips()).toEqual(["apps", "cloud"]);
  });

  it("with no AI says what is missing, with no card yet, and a User hears the team's owner connects it", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    expect(lines()[1]).toBe(t("helperIntro.followup.noAi"));
    expect(host.querySelector("[data-helper-start]")).toBeNull();
    expect(chips()).toEqual(["ai", "apps", "phone"]);
    const dana = { email: "dana@acme.test", name: "Dana", role: "member", you: true as const };
    const olive = { email: "olive@acme.test", name: "Olive", role: "owner" };
    f.state = { ...f.state, instances: [] };
    setTeamPeople({ people: [dana, olive], me: dana, admin: false, needsYou: [] });
    await show();
    expect(lines()[1]).toBe(t("helperIntro.followup.noAiOwner", { name: "Olive" }));
    setTeamPeople(null);
  });

  it("a tapped chip stays to be tapped again", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="phone"]')!.click(); });
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", section: "companion", phonePairing: true }));
    expect(chips()).toEqual(["ai", "apps", "phone"]);
  });

  it("opens the Connect an AI dialog in place from its chip, not Settings", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="ai"]')!.click(); });
    expect(host.querySelector("[data-connect-ai]")).not.toBeNull();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("offers the starter card on OpenCode's free model, which it never counts as the person's own AI", async () => {
    f.state = { ...f.state, instances: [{ instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode",
      snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "m", options: [] } }] };
    await show();
    expect(asks()).toHaveLength(3);
    expect(chips()[0]).toBe("ai");
  });

  it("offers to bring in skills this computer has, looking only from its own window", async () => {
    f.local = true;
    f.found = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };
    await show();
    expect(chips()).toEqual(["apps", "import", "phone"]);
    expect(chipAction("import")).toEqual({ type: "toggleAppSettings", open: true, section: "import" });
  });

  it("sends a first job or the person's own words as their first message, and the message box takes the focus", async () => {
    const box = document.createElement("div");
    box.dataset.tour = "composer";
    const field = document.createElement("textarea");
    box.append(field);
    document.body.append(box);
    await show();
    await act(async () => { host.querySelector<HTMLElement>("[data-helper-ask]")!.click(); });
    await act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "answerCard", botId: "maus", threadId: "t", messageId: "intro", answer: "Help me plan my week" });
    expect(analytics.track).toHaveBeenCalledWith("onboarding_starter", { task: "week" });
    expect(document.activeElement).toBe(field);
    box.remove();
  });

  it("fits the first jobs to a connected inbox and calendar", async () => {
    rememberConnectorStatus({ gmail: { connected: true }, googlecalendar: { connected: true } } as Parameters<typeof rememberConnectorStatus>[0], true);
    await show();
    rememberConnectorStatus({}, true);
    expect(asks()).toEqual(["Summarize my inbox", "What's on my calendar today?", "Help me plan my week"]);
  });

  it("drops the card and chips once the person has written, and no longer looks for skills", async () => {
    f.local = true;
    await show(true);
    expect(lines()).toHaveLength(1);
    expect(host.querySelector("[data-helper-start]")).toBeNull();
    expect(chips()).toEqual([]);
    expect(f.detect).not.toHaveBeenCalled();
  });

  it("counts Try Cloud as the first run's Cloud moment, then opens Add a Cloud", async () => {
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="cloud"]')!.click(); });
    expect(analytics.track).toHaveBeenCalledWith("onboarding_cloud", { action: "start_trial" });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_onboarding" });
  });

  it("opens the app's own flow for each chip", () => {
    expect(chipAction("apps")).toEqual({ type: "togglePlugins", open: true, surface: "apps" });
    expect(chipAction("phone")).toMatchObject({ type: "toggleAppSettings", section: "companion", phonePairing: true });
    expect(chipAction("cloud")).toEqual({ type: "openCloudAdd", source: "app_onboarding" });
  });

  it("says nothing while the Chief step still introduces Dusk", async () => {
    setWelcomingBot("maus");
    await show();
    expect(host.querySelector("[data-helper-intro]")).toBeNull();
  });
});

describe("as a first run lands in the chat", () => {
  it("arrives part by part: the message, then the starter card and the chips", async () => {
    vi.useFakeTimers();
    stageIntro("maus");
    await show();
    expect(lines()).toEqual([]);
    await tick(INTRO_TIMING.first);
    expect(lines()).toHaveLength(1);
    expect(host.querySelector("[data-helper-start]")).toBeNull();
    await tick(INTRO_TIMING.card);
    expect(asks()).toHaveLength(3);
    expect(chips()).toEqual(["apps", "phone", "cloud"]);
  });

  it("shows everything at once with reduced motion", async () => {
    f.reduced = true;
    stageIntro("maus");
    await show();
    expect(lines()).toHaveLength(1);
    expect(asks()).toHaveLength(3);
  });
});
