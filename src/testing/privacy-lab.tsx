import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { applyMotionSpeed } from "../lib/motion-speed";
import { applySkin, THEME_SKINS } from "../lib/skins";
import { cn } from "../lib/cn";
import {
  CardA, CardE, DesktopChat, DesktopFrame, DesktopSettings, FIFTH_CHAT, FIRST_CHAT, FirstLaunch, Fit, InlineAsk, LoginScreen,
  PhoneChat, PhoneFrame, PhoneSettings, PhoneSheet, type SettingsView,
} from "./privacy-lab-screens";
import "../font-faces.css";
import "../styles.css";
import "../styles/overlays.css";
import "../styles/motion.css";
import "../styles/settings.css";
import "../components/chat.css";
import "../mobile/mobile.css";
import "../mobile/sheets/sheets.css";

type Device = "desktop" | "phone";
type Ctx = { eu: boolean; next: () => void; skip: () => void };
type Step = { title: string; note: string; eu?: string; screen: (ctx: Ctx) => ReactNode };
type Approach = {
  id: string; letter: string; name: string; summary: string;
  pros: string[]; cons: string[]; optIn: string; risk: string;
  desktop: Step[]; phone: Step[];
};

const login = (note = "Sign-in, with the consent line at the bottom. Nothing is sent before this."): Step => ({
  title: "Sign in", note, screen: ({ next }) => <LoginScreen onSignedIn={next} />,
});
const phoneLogin = (note = "Sign-in on the phone, the same consent line."): Step => ({
  title: "Sign in", note, screen: ({ next }) => <LoginScreen phone onSignedIn={next} />,
});
const settings = (title: string, note: string, view: SettingsView, counts: (eu: boolean) => boolean, notes: boolean, chat: ReactNode = <DesktopChat turns={FIRST_CHAT} />): Step => ({
  title, note, eu: "Counts and crash reports start off here; the footnote says why.",
  screen: ({ eu }) => <DesktopSettings view={view} counts={counts(eu)} notes={notes} eu={eu} behind={chat} />,
});
const phoneSettings = (title: string, note: string, view: SettingsView, counts: (eu: boolean) => boolean, notes: boolean): Step => ({
  title, note, screen: ({ eu }) => <PhoneSettings view={view} counts={counts(eu)} notes={notes} eu={eu} />,
});
const regional = (eu: boolean) => !eu;
const on = () => true;

const SHARED_TAIL: Step[] = [
  settings("See what's been shared", "Every note, count and crash report this computer sent, newest first. Notes show what was taken out.", "shared", on, true),
  settings("Delete all", "One confirm inline, no second dialog. Removed on our side within a day.", "confirm", on, true),
  settings("Deleted", "A plain empty state that says what happens next.", "empty", on, true),
];

const APPROACHES: Approach[] = [
  {
    id: "a", letter: "A", name: "Card after sign-in",
    summary: "Once, right after sign-in and before the first chat: the mascot asks one question that covers counts, crash reports and session notes.",
    pros: ["One clear moment, asked once, never again", "The example note answers \"are you reading my chats?\" before it's asked", "Works the same in the EU and UK"],
    cons: ["Asks before people have seen what a session even is", "One answer for everything: Not now also turns off crash reports", "A popup on day one is one more thing between sign-in and the first chat"],
    optIn: "About 45 to 60 percent say yes", risk: "Legal: low, it's a clear opt-in. Drama: low to medium, a \"reads your messages\" popup on day one can get screenshotted.",
    desktop: [
      login(),
      { title: "The card", note: "Shown once, over the empty first chat. Not now is as easy as Sure.", eu: "In the EU and UK it adds: Nothing is shared unless you say yes.", screen: ({ eu, skip }) => <DesktopChat turns={FIRST_CHAT} overlay={<CardA example={false} eu={eu} onYes={skip} onNo={skip} />} /> },
      { title: "See an example note", note: "The note folds open in place: what a real scrubbed note looks like, and what was taken out.", screen: ({ eu, next }) => <DesktopChat turns={FIRST_CHAT} overlay={<CardA example eu={eu} onYes={next} onNo={next} />} /> },
      { title: "First chat", note: "After Sure, straight into the first chat. No thank-you screen.", screen: () => <DesktopChat turns={FIRST_CHAT} /> },
      settings("Settings › Privacy", "Two switches now, not one, so turning notes off never stops crash reports.", "privacy", on, true),
      ...SHARED_TAIL,
    ],
    phone: [
      phoneLogin(),
      { title: "The sheet", note: "On the phone the card is a bottom sheet, the same words.", screen: ({ eu, skip }) => <PhoneChat bot="dusk bot" turns={FIRST_CHAT} sheet={<PhoneSheet split={false} eu={eu} example={false} onYes={skip} onNo={skip} />} /> },
      { title: "See an example note", note: "The example opens inside the sheet.", screen: ({ eu, next }) => <PhoneChat bot="dusk bot" turns={FIRST_CHAT} sheet={<PhoneSheet split={false} eu={eu} example onYes={next} onNo={next} />} /> },
      phoneSettings("Settings › Privacy", "The same two switches and the shared list.", "privacy", on, true),
      phoneSettings("What's been shared", "The list, with Delete all at the end.", "shared", on, true),
    ],
  },
  {
    id: "b", letter: "B", name: "Ask at first launch",
    summary: "Before sign-in, one screen with two choices: usage counts and crash reports (on, part of the Terms) and session notes (off, ask).",
    pros: ["Honest split: what's covered by the Terms vs what's asked", "Nobody is surprised later", "Fits the EU and UK by flipping one default"],
    cons: ["A screen before the person has even signed in or seen the app", "People skim setup screens and press Continue, so notes stay off", "More drop-off on first launch"],
    optIn: "About 10 to 20 percent turn notes on", risk: "Legal: low. Drama: low. The cost is first-launch friction, not trust.",
    desktop: [
      { title: "Before you start", note: "First launch, before sign-in. Counts are on (Terms), notes are off until switched on.", eu: "In the EU and UK both switches start off.", screen: ({ eu, skip }) => <FirstLaunch eu={eu} example={false} onContinue={skip} /> },
      { title: "See an example note", note: "The example opens under the switches.", screen: ({ eu, next }) => <FirstLaunch eu={eu} example onContinue={next} /> },
      login("Then sign-in. Choices are kept on this computer and only start after sign-in."),
      { title: "First chat", note: "No more questions after this.", screen: () => <DesktopChat turns={FIRST_CHAT} /> },
      settings("Settings › Privacy", "Most people pressed Continue, so notes are off here.", "privacy", regional, false),
      SHARED_TAIL[0],
    ],
    phone: [
      { title: "Before you start", note: "The phone's first screen, as iOS-style switch rows.", screen: ({ eu, next }) => <FirstLaunch phone eu={eu} example={false} onContinue={next} /> },
      phoneLogin(),
      phoneSettings("Settings › Privacy", "The same two switches later.", "privacy", regional, false),
    ],
  },
  {
    id: "c", letter: "C", name: "Ask in context",
    summary: "Counts and crash reports follow the Terms. After the fifth chat that went well, one quiet line under the finished reply asks about notes. Shown once.",
    pros: ["Asked right after it worked, so the reason is obvious", "Uses the existing Do it / Not now look, nothing new", "No popup, no setup screen"],
    cons: ["Many people never reach a fifth good chat, so they're never asked", "Spotting a \"good\" chat needs counts, which are off in the EU", "Can read like an ad inside a chat"],
    optIn: "About 30 percent of those asked, 10 to 15 percent overall", risk: "Legal: low. Drama: low, but a line inside a private chat about that chat can feel watched.",
    desktop: [
      login(),
      { title: "Chats one to four", note: "Nothing is asked. Counts and crash reports run as the Terms say.", eu: "In the EU and UK counts are off, so \"a good chat\" is judged on this computer only.", screen: () => <DesktopChat bot="Scout" turns={FIFTH_CHAT.slice(0, 2)} /> },
      { title: "The fifth good chat", note: "The reply finishes, then one quiet line appears under it. Shown once, ever.", screen: ({ next, skip }) => <DesktopChat bot="Scout" turns={FIFTH_CHAT} below={<InlineAsk state="ask" onYes={skip} onNo={skip} onExample={next} />} /> },
      { title: "See an example", note: "The example opens right there in the chat.", screen: ({ next }) => <DesktopChat bot="Scout" turns={FIFTH_CHAT} below={<InlineAsk state="example" onYes={next} onNo={next} onExample={next} />} /> },
      { title: "Answered", note: "One line of thanks, then the chat carries on.", screen: () => <DesktopChat bot="Scout" turns={FIFTH_CHAT} below={<InlineAsk state="yes" onYes={() => {}} onNo={() => {}} onExample={() => {}} />} /> },
      settings("Settings › Privacy", "Notes now on.", "privacy", regional, true, <DesktopChat bot="Scout" turns={FIFTH_CHAT} />),
      SHARED_TAIL[0],
    ],
    phone: [
      { title: "The fifth good chat", note: "On the phone the same line sits under the reply.", screen: ({ next, skip }) => <PhoneChat turns={FIFTH_CHAT.slice(2)} below={<InlineAsk phone state="ask" onYes={skip} onNo={skip} onExample={next} />} /> },
      { title: "See an example", note: "It opens in place.", screen: ({ next }) => <PhoneChat turns={FIFTH_CHAT.slice(3)} below={<InlineAsk phone state="example" onYes={next} onNo={next} onExample={next} />} /> },
      phoneSettings("Settings › Privacy", "Notes on after Sure.", "privacy", regional, true),
    ],
  },
  {
    id: "d", letter: "D", name: "Settings only",
    summary: "No question anywhere. Session notes are a separate switch in Settings › Privacy, off until someone turns it on.",
    pros: ["Zero friction, zero drama", "The cleanest story for lawyers and press", "Nothing to build except the switch"],
    cons: ["Almost nobody opens Settings, so almost no notes", "The notes that do come in are from power users only, not typical people"],
    optIn: "About 1 to 3 percent", risk: "Legal: lowest. Drama: none.",
    desktop: [
      login(),
      { title: "Chats as usual", note: "No card, no line in the chat.", screen: () => <DesktopChat bot="Scout" turns={FIFTH_CHAT} /> },
      settings("Settings › Privacy", "Session notes off by default. Counts follow the Terms (off in the EU and UK).", "privacy", regional, false, <DesktopChat bot="Scout" turns={FIFTH_CHAT} />),
      settings("Turned on", "Someone who cares turns it on here.", "privacy", regional, true, <DesktopChat bot="Scout" turns={FIFTH_CHAT} />),
      SHARED_TAIL[0],
    ],
    phone: [
      phoneSettings("Settings › Privacy", "The phone's Privacy section.", "privacy", regional, false),
      phoneSettings("What's been shared", "The same list.", "shared", regional, true),
    ],
  },
  {
    id: "e", letter: "E", name: "My pick: one honest card, split choices",
    summary: "A's card after sign-in, but notes are their own choice: counts and crash reports are stated as on (Terms), notes are asked. Settings keeps them separate, as in D.",
    pros: ["Asks once, with the example, like A", "No on crash reports isn't forced by a no on notes", "Counts are stated, not hidden, so nothing feels sneaky later", "EU and UK get a real switch for counts in the same card"],
    cons: ["Still a popup before the first chat", "A little more to read than A"],
    optIn: "About 35 to 50 percent say yes to notes", risk: "Legal: low, notes are a clear opt-in and counts are disclosed. Drama: low, the card says exactly what is and isn't sent.",
    desktop: [
      login(),
      { title: "The card", note: "Counts and crash reports are a stated fact; session notes are the one question.", eu: "In the EU and UK counts become a switch in the card, off.", screen: ({ eu, skip }) => <DesktopChat turns={FIRST_CHAT} overlay={<CardE example={false} eu={eu} onYes={skip} onNo={skip} />} /> },
      { title: "See an example note", note: "Same example as A.", screen: ({ eu, next }) => <DesktopChat turns={FIRST_CHAT} overlay={<CardE example eu={eu} onYes={next} onNo={next} />} /> },
      { title: "First chat", note: "Straight in.", screen: () => <DesktopChat turns={FIRST_CHAT} /> },
      settings("Settings › Privacy", "Two switches, the shared list underneath.", "privacy", regional, true),
      ...SHARED_TAIL,
    ],
    phone: [
      phoneLogin(),
      { title: "The sheet", note: "The split card as a bottom sheet.", screen: ({ eu, skip }) => <PhoneChat bot="dusk bot" turns={FIRST_CHAT} sheet={<PhoneSheet split eu={eu} example={false} onYes={skip} onNo={skip} />} /> },
      { title: "See an example note", note: "Opens in the sheet.", screen: ({ eu, next }) => <PhoneChat bot="dusk bot" turns={FIRST_CHAT} sheet={<PhoneSheet split eu={eu} example onYes={next} onNo={next} />} /> },
      phoneSettings("Settings › Privacy", "Separate switches.", "privacy", regional, true),
      phoneSettings("Delete all", "Confirm in place.", "confirm", regional, true),
      phoneSettings("Deleted", "Empty state.", "empty", regional, true),
    ],
  },
];

const EVERY: Approach = {
  id: "all", letter: "All", name: "Every approach", summary: "The screens every approach shares: sign-in with the consent line, the reworked Privacy section and the shared list. Flip EU and UK to see the other defaults.",
  pros: [], cons: [], optIn: "", risk: "",
  desktop: [login(), settings("Settings › Privacy", "Counts and crash reports, session notes and the shared list.", "privacy", regional, false), ...SHARED_TAIL],
  phone: [phoneLogin(), phoneSettings("Settings › Privacy", "The phone's Privacy section.", "privacy", regional, false), phoneSettings("What's been shared", "The list.", "shared", regional, true), phoneSettings("Delete all", "Confirm in place.", "confirm", regional, true), phoneSettings("Deleted", "Empty state.", "empty", regional, true)],
};

const ALL = [...APPROACHES, EVERY];
const PLAY_MS = 3600;

function readParams() {
  const p = new URLSearchParams(location.search);
  return { approach: p.get("a") ?? "e", device: (p.get("device") === "phone" ? "phone" : "desktop") as Device, step: Number(p.get("step") ?? 0) || 0, eu: p.get("region") === "eu", dark: p.get("theme") === "dark" };
}

function Pill({ pressed, onClick, children, label }: { pressed?: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" aria-pressed={pressed} aria-label={label} onClick={onClick}
      className={cn("min-h-11 rounded-full px-4 text-[14px] transition-[background-color,color] duration-150 ease-[ease] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        pressed ? "bg-ink text-app" : "bg-ink/[0.06] text-ink hover:bg-ink/10")}>
      {children}
    </button>
  );
}

function Lab() {
  const initial = readParams();
  const [approachId, setApproachId] = useState(initial.approach);
  const [device, setDevice] = useState<Device>(initial.device);
  const [step, setStep] = useState(initial.step);
  const [eu, setEu] = useState(initial.eu);
  const [dark, setDark] = useState(initial.dark);
  const [playing, setPlaying] = useState(false);
  const approach = ALL.find((a) => a.id === approachId) ?? APPROACHES[4];
  const steps = approach[device];
  const at = Math.min(step, steps.length - 1);
  const current = steps[at];

  useEffect(() => { applySkin(dark ? THEME_SKINS.dark : THEME_SKINS.light); }, [dark]);
  useEffect(() => {
    const p = new URLSearchParams({ a: approach.id, device, step: String(at), ...(eu ? { region: "eu" } : {}), ...(dark ? { theme: "dark" } : {}) });
    history.replaceState(null, "", `?${p}`);
  }, [approach.id, device, at, eu, dark]);

  const next = useCallback(() => setStep((s) => Math.min(s + 1, steps.length - 1)), [steps.length]);
  const skip = useCallback(() => setStep((s) => Math.min(s + 2, steps.length - 1)), [steps.length]);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setStep((s) => { if (s >= steps.length - 1) { setPlaying(false); return s; } return s + 1; }), PLAY_MS);
    return () => clearInterval(timer);
  }, [playing, steps.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") back();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [next, back]);

  const pick = (id: string) => { setApproachId(id); setStep(0); setPlaying(false); };
  const pickDevice = (d: Device) => { setDevice(d); setStep(0); setPlaying(false); };

  return (
    <div className="min-h-[100dvh] bg-app px-6 py-8 text-ink">
      <header className="mx-auto max-w-[1480px]">
        <h1 className="m-0 text-[24px] font-semibold leading-tight">Privacy lab</h1>
        <p className="mb-5 mt-2 max-w-[78ch] text-[15px] leading-[1.6] text-ink-secondary">
          Five ways to ask about session notes, each played through dusk bot's real screens: sign-in, the ask, Settings › Privacy and the new shared list. Step with Back and Next (or the arrow keys), press Play, or click the buttons inside the screens. Nothing here ships yet.
        </p>
        <nav aria-label="Approaches" className="flex flex-wrap gap-2">
          {ALL.map((a) => <Pill key={a.id} pressed={a.id === approach.id} onClick={() => pick(a.id)}>{a.letter === "All" ? "Every approach" : `${a.letter}  ${a.name}`}</Pill>)}
        </nav>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill pressed={device === "desktop"} onClick={() => pickDevice("desktop")}>Desktop</Pill>
          <Pill pressed={device === "phone"} onClick={() => pickDevice("phone")}>Phone</Pill>
          <span className="w-3" />
          <Pill pressed={!eu} onClick={() => setEu(false)}>Rest of world</Pill>
          <Pill pressed={eu} onClick={() => setEu(true)}>EU and UK</Pill>
          <span className="w-3" />
          <Pill pressed={!dark} onClick={() => setDark(false)}>Light</Pill>
          <Pill pressed={dark} onClick={() => setDark(true)}>Dark</Pill>
        </div>
      </header>

      <main className="mx-auto mt-6 grid max-w-[1480px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-label="Screen" className="min-w-0">
          <div className={cn("mx-auto", device === "phone" ? "max-w-[410px]" : "max-w-[1100px]")}>
            <Fit w={device === "phone" ? 410 : 1100} h={device === "phone" ? 864 : 700}>
              {device === "phone"
                ? <PhoneFrame dark={dark}><div key={`${approach.id}-${at}-${eu}`} className="size-full [animation:dusk-fade-in_180ms_var(--dusk-ease-out)_backwards]">{current.screen({ eu, next, skip })}</div></PhoneFrame>
                : <DesktopFrame><div key={`${approach.id}-${at}-${eu}`} className="size-full [animation:dusk-fade-in_180ms_var(--dusk-ease-out)_backwards]">{current.screen({ eu, next, skip })}</div></DesktopFrame>}
            </Fit>
          </div>
        </section>

        <aside className="flex flex-col gap-5">
          <div>
            <div className="flex items-center gap-2">
              <Pill onClick={back} label="Back">Back</Pill>
              <Pill onClick={next} label="Next">Next</Pill>
              <Pill pressed={playing} onClick={() => { if (!playing && at >= steps.length - 1) setStep(0); setPlaying((v) => !v); }}>{playing ? "Pause" : "Play"}</Pill>
            </div>
            <ol aria-label="Steps" className="m-0 mt-4 flex list-none flex-col gap-1 p-0">
              {steps.map((s, i) => (
                <li key={i}>
                  <button type="button" aria-current={i === at ? "step" : undefined} onClick={() => { setStep(i); setPlaying(false); }}
                    className={cn("flex w-full gap-3 rounded-[12px] px-3 py-2 text-start transition-[background-color] duration-150 ease-[ease] focus-visible:outline-2 focus-visible:outline-focus", i === at ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]")}>
                    <span className="w-4 shrink-0 text-[13px] tabular-nums text-ink-tertiary">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-[14px] leading-5">{s.title}</span>
                      {i === at && <span className="mt-0.5 block text-[13px] leading-[18px] text-ink-secondary">{s.note}{eu && s.eu ? ` ${s.eu}` : ""}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <Label approach={approach} />
        </aside>
      </main>
    </div>
  );
}

function Label({ approach }: { approach: Approach }) {
  return (
    <section aria-label={`About ${approach.name}`} className="rounded-[16px] bg-ink/[0.04] p-4">
      <h2 className="m-0 text-[16px] font-semibold">{approach.letter === "All" ? approach.name : `${approach.letter}. ${approach.name}`}</h2>
      <p className="m-0 mt-1.5 text-[14px] leading-[1.55] text-ink-secondary">{approach.summary}</p>
      {approach.pros.length > 0 && <>
        <h3 className="m-0 mt-4 text-[13px] font-medium">Good</h3>
        <ul className="m-0 mt-1 flex list-disc flex-col gap-1 ps-5 text-[13.5px] leading-5 text-ink-secondary">{approach.pros.map((p) => <li key={p}>{p}</li>)}</ul>
        <h3 className="m-0 mt-3 text-[13px] font-medium">Not so good</h3>
        <ul className="m-0 mt-1 flex list-disc flex-col gap-1 ps-5 text-[13.5px] leading-5 text-ink-secondary">{approach.cons.map((p) => <li key={p}>{p}</li>)}</ul>
        <h3 className="m-0 mt-3 text-[13px] font-medium">Expected opt-in (rough guess)</h3>
        <p className="m-0 mt-1 text-[13.5px] leading-5 text-ink-secondary">{approach.optIn}</p>
        <h3 className="m-0 mt-3 text-[13px] font-medium">Legal and drama risk</h3>
        <p className="m-0 mt-1 text-[13.5px] leading-5 text-ink-secondary">{approach.risk}</p>
      </>}
    </section>
  );
}

applyMotionSpeed(document.documentElement);
createRoot(document.getElementById("root")!).render(<Lab />);
