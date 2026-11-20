import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { phoneAppPrompted } from "@/lib/feature-flags";
import { track } from "@/lib/analytics";
import { DEFAULT_BOT_NAME, introAsks, introAsksOffered, introChips, introStaged, stageIntro, useWelcomingBot, type IntroAsk } from "@/lib/default-bot";
import { activeLocale, t } from "@/lib/i18n";
import { detectSetupWithin, localSetupImport, setupImportApi } from "@/lib/setup-import";
import { api, useStore, type Bot, type InstanceInfo, type Message } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { useTeamPeople, type TeamPeople } from "@/state/team-people";
import { freeFallback } from "../../shared/ai-ranking";
import { greetingName } from "../../shared/greeting-name";
import { CLOUD_FROM_COMPUTER } from "../../shared/cloud-hints";
import { hintSeen } from "@/lib/onboarding";
import { followupText, type HelperFollowupFacts } from "../../shared/helper-followup";
import { joinedCorners, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX } from "./chat-bubble";
import { loadAppCards } from "./bot-settings/useBotApps";
import { engineReady } from "./EngineLibrary";
import { AskCard, AskChoices, AskReply, choiceLetter, returnFocusToComposer } from "./AskCard";
import { IntroChips } from "./HelperSetup";
import { usePrefersReducedMotion } from "./mascot-clock";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { CloudSignInLine, useMissingCloudAi } from "./onboarding/CloudSignInLine";

/** How long after the part before each part arrives, when a first run has just landed here: Dusk's one message, then
 * its starter card and the chips. */
export const INTRO_TIMING = { first: 300, card: 700 } as const;
const LOOK_MS = 3_000;
/** Parts in order: none, the message, the card and chips. */
const ALL = 2;
const DELAYS = [INTRO_TIMING.first, INTRO_TIMING.card];

const ASK_LABEL: Record<IntroAsk, LocaleKey> = {
  inboxSummary: "helperIntro.ask.inboxSummary",
  today: "helperIntro.ask.today",
  week: "helperIntro.ask.week",
  price: "helperIntro.ask.price",
  research: "helperIntro.ask.research",
};

/** Dusk's one opening message: who it is and that it wants one real job. A Dusk that is not the Chief keeps its helper's
 * hello and what it does; a Team Cloud member's says what it does on the team. */
export function introLine(input: { name: string; chief: boolean; person?: string; team?: string; fromComputer?: boolean; carried?: boolean }): string {
  if (input.chief && !input.team) {
    const hello = input.person && input.fromComputer ? t("helperIntro.singleNamed", { name: input.name, person: input.person }) : t("helperIntro.single", { name: input.name });
    return input.carried ? `${hello} ${t("helperIntro.carried")}` : hello;
  }
  const [hello, lead] = introLines(input);
  return `${hello} ${lead}`;
}

/** Dusk's three lines: who it is, what it does here, and that it is looking around. A Dusk that is not the Chief
 * keeps its helper's lines; a Team Cloud member's leaves their day to the team's Chief. */
/** `fromComputer`: a cloud the desktop app set up, where the Chief greets the person by the name it brought along;
 * `carried`: what they told dusk bot there about themselves came too. */
export function introLines(input: { name: string; chief: boolean; person?: string; team?: string; fromComputer?: boolean; carried?: boolean }): string[] {
  const team = input.team ? t("helperIntro.team", { team: input.team }) : "";
  const carried = input.carried ? t("helperIntro.carried") : "";
  const lead = input.chief ? t("helperIntro.lead.chiefOfStaff") : input.team ? t("helperIntro.lead.member") : t("helperIntro.lead.helper");
  const hello = input.chief ? (input.person && input.fromComputer ? t("helperIntro.helloNamed", { name: input.name, person: input.person }) : t("helperIntro.hello", { name: input.name }))
    : input.person ? t("helperIntro.hi.helperNamed", { name: input.name, person: input.person }) : t("helperIntro.hi.helper", { name: input.name });
  return [hello, [lead, team, carried].filter(Boolean).join(" "), t("helperIntro.lookingAround")];
}

/** The follow-up in the viewer's language. */
export function followupLine(facts: HelperFollowupFacts): string {
  return followupText(facts, (key, params) => t(key, params), (items) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(items));
}

/** Who a User reads connects the AI, once the team's people are known; nothing for someone who can connect one themselves. */
export function whoConnectsAi(team: Pick<TeamPeople, "people" | "admin"> | null): string | undefined {
  return team && !team.admin ? team.people.find((person) => person.role === "owner")?.name ?? "" : undefined;
}

function thinksWith(bot: Bot | undefined, instances: readonly InstanceInfo[]): HelperFollowupFacts["ai"] {
  const works = (instance: InstanceInfo) => engineReady(instance) && !freeFallback(instance);
  if (instances.some((instance) => instance.instanceId === bot?.modelSelection.instanceId && works(instance)) || instances.some(works)) return "own";
  return instances.some((instance) => engineReady(instance) && freeFallback(instance)) ? "backup" : "none";
}

interface Look {
  apps: string[] | null;
  /** The connected apps' slugs, for fitting the first jobs (introAsks). */
  slugs?: string[];
  phonePaired?: boolean;
  importFound?: boolean;
  settled: boolean;
}

/** A real look around, without asking an AI: the apps connected here, a paired phone, skills to bring in. Settles within
 * LOOK_MS; anything not known by then is left out. `deep` also looks for skills on this computer. */
function useLookAround(deep: boolean): Look {
  const [found, setFound] = useState<Look>({ apps: null, settled: false });
  useEffect(() => {
    let active = true;
    const apps = Promise.all([preloadConnectedApps(), loadAppCards()])
      .then(([inventory, cards]) => Object.entries(inventory.services).filter(([, status]) => status.connected)
        .map(([slug]) => ({ slug, label: cards.get(slug)?.label ?? slug })))
      .catch(() => null);
    const phones = api<{ phones?: unknown[] }>("/api/phones").then((response) => (response.phones?.length ?? 0) > 0).catch(() => undefined);
    const look = deep && localSetupImport(false) ? detectSetupWithin(setupImportApi) : null;
    const timer = setTimeout(() => { if (active) setFound((now) => ({ ...now, settled: true })); }, LOOK_MS);
    void Promise.all([apps, phones, look?.found ?? null]).then(([connected, phonePaired, detection]) => {
      if (active) setFound({ apps: connected?.map((app) => app.label) ?? null, slugs: connected?.map((app) => app.slug), phonePaired, importFound: Boolean(detection), settled: true });
    });
    return () => {
      active = false;
      clearTimeout(timer);
      look?.cancel();
    };
  }, [deep]);
  return found;
}

/** How far the intro has come: everything at once, or part by part when a first run has just landed here (stageIntro).
 * The card waits for the look around. Staging starts when the intro is first seen, not when it mounts behind the Chief
 * step. Reduced motion shows everything at once. */
function useArrival(first: boolean, ready: boolean): { shown: number; staged: boolean } {
  const reduced = usePrefersReducedMotion();
  const animate = first && !reduced;
  const [run, setRun] = useState<number | null>(null);
  useEffect(() => {
    if (animate) setRun(0);
  }, [animate]);
  useEffect(() => {
    if (run === null || run >= ALL || (run === 1 && !ready)) return;
    const timer = setTimeout(() => setRun(run + 1), DELAYS[run]!);
    return () => clearTimeout(timer);
  }, [run, ready]);
  return { shown: run ?? (animate ? 0 : ALL), staged: run !== null };
}

/** The first jobs, one tap each, and the person's own words: whichever they pick is sent as their first message. */
function StarterCard({ asks, color, onSend }: { asks: readonly IntroAsk[]; color: Bot["color"] | undefined; onSend: (text: string, ask: IntroAsk | "own") => void }) {
  const [own, setOwn] = useState("");
  const title = t("helperIntro.start");
  return (
    <div data-helper-start="" className="animate-msg-in mt-1.5 w-full">
      <AskCard title={title} ariaLabel={title}>
        <AskChoices choices={asks.map((ask) => ({ label: t(ASK_LABEL[ask]) }))} label={title} tag="data-helper-ask"
          onPick={(label) => onSend(label, asks.find((ask) => t(ASK_LABEL[ask]) === label) ?? "own")} />
        <AskReply label={t("helperIntro.startOther")} placeholder={t("helperIntro.startOther")} color={color} value={own} onChange={setOwn}
          letter={choiceLetter(asks.length)} onSend={(text) => onSend(text, "own")} />
      </AskCard>
    </div>
  );
}

/** Dusk's first messages in Simple mode, in the viewer's language: one message, then a starter card of three first jobs
 * and the person's own words, with chips for what is still missing. Card and chips go once the person writes anything
 * after it (`answered`). An older intro keeps the follow-up it already wrote (helperFollowup) under the message. */
export function SimpleHelperIntro({ botId, threadId, message, answered, followup }: {
  botId: string; threadId: string; message: Message; answered: boolean; followup?: Message;
}) {
  const { state, dispatch } = useStore();
  const welcoming = useWelcomingBot();
  const hidden = welcoming === botId;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const team = bot?.defaultBot?.person ? state.config?.team?.name : undefined;
  const person = greetingName(state.config?.profile?.name) || undefined;
  const fromComputer = hintSeen(state.config?.onboarding, CLOUD_FROM_COMPUTER);
  const carried = fromComputer && Boolean(state.config?.profile?.aboutMe?.trim());
  const line = introLine({ name: bot?.name ?? DEFAULT_BOT_NAME, chief: Boolean(bot?.chiefOfStaff), person, team, fromComputer, carried });
  const look = useLookAround(!answered);
  const ai = thinksWith(bot, state.instances);
  // a new cloud whose AIs didn't come along: the one it misses is named, with its sign-in, in place of the AI chip
  const missing = useMissingCloudAi(fromComputer && state.config?.cloudHome === true, ai === "own");
  const connects = whoConnectsAi(useTeamPeople());

  const [first, setFirst] = useState(false);
  const due = !hidden && introStaged(botId);
  useEffect(() => {
    if (!due) return;
    stageIntro(null);
    setFirst(true);
  }, [due]);
  const { shown, staged } = useArrival(first || due, look.settled);
  if (hidden) return null;

  const saved = followup?.helperFollowup;
  // with no AI to think with there is no card yet: the message says what is missing
  const after = saved ? { connects, ...saved } : ai === "none" && look.settled ? { ai, apps: [], bots: 0, routines: 0, ...(connects === undefined ? {} : { connects }) } : null;
  const bubbles = shown >= 1 ? [line, ...(after ? [followupLine(after)] : [])] : [];
  // the card and chips belong under the message: none while the app connects, reconnects or the transcript is still loading
  const onScreen = state.connected && bot?.transcriptLoaded !== false && bubbles.length > 0;
  const open = !answered && onScreen && shown >= ALL && look.settled;
  const chips = !open ? [] : introChips({
    aiReady: ai === "own" || missing !== null,
    ownBots: state.bots.filter((candidate) => !candidate.hidden && !candidate.defaultBot).length,
    onCloud: state.config?.cloudHome === true,
    team: Boolean(state.config?.team),
    remote: typeof window !== "undefined" && window.duskDesktop?.remoteClient?.active === true,
    appsConnected: Boolean(look.apps?.length),
    phonePaired: look.phonePaired,
    phoneApp: phoneAppPrompted(),
    importFound: look.importFound,
  });
  const send = (text: string, ask: IntroAsk | "own") => {
    track("onboarding_starter", { task: ask });
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text });
    returnFocusToComposer();
  };
  return (
    <div data-helper-intro={message.id} className="flex w-full flex-col items-start gap-1">
      {bubbles.map((text, index) => (
        <div
          key={index}
          data-chat-bubble="simple"
          data-helper-line={index}
          {...(index === 1 ? { "data-helper-followup": "" } : {})}
          className={cn("w-fit", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE, joinedCorners("start", { above: index > 0, below: index < bubbles.length - 1 }),
            staged && "animate-msg-in")}
        >
          {text}
        </div>
      ))}
      {missing && onScreen && shown >= ALL && <CloudSignInLine tile={missing} />}
      {open && introAsksOffered(ai) && <StarterCard asks={introAsks(look.slugs ?? [])} color={bot?.color} onSend={send} />}
      <IntroChips chips={chips} />
    </div>
  );
}
