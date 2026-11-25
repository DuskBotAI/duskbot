import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AudioLines, Check, ChevronLeft, Eye, FileText, Mic, MoreHorizontal, Plus, Search, ShieldCheck, Trash2, X } from "../icons";
import { MausAvatar } from "../components/Avatar";
import { SignIn } from "../components/account-gate/SignIn";
import { CARD_BUTTON_MD, cardPrimary, cardSecondary, cardTertiary } from "../components/AskCard";
import { SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_USER_BUBBLE } from "../components/chat-bubble";
import { SIMPLE_COMPOSER, SIMPLE_CONTROL } from "../components/composer-simple";
import { PRIMARY_BUTTON } from "../components/NoticeCard";
import { SettingRow, SettingsGroup, SettingsRows, SIMPLE_BUTTONS, Switch } from "../components/SettingsPrimitives";
import { SettingGlyph, type SettingGlyphName } from "../components/ui/SettingGlyph";
import { SettingsRow as PhoneRow, SettingsSection as PhoneSection, SettingsSwitch as PhoneSwitch } from "../mobile/sheets/SettingsRow";
import { PRIMARY as PHONE_PRIMARY, QUIET as PHONE_QUIET } from "../mobile/onboarding/parts";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";
import { userBubbleStyle } from "../lib/user-bubble-tone";
import type { MausColor } from "../../shared/wire";

export const COPY = {
  notesPlain: "Now and then, your own AI reads a few recent messages on this computer and writes a short note on how the session went. Names, emails and links are taken out before it's sent.",
  notesFacts: "Notes aren't linked to your account, are kept 30 days and use a little of your AI plan.",
  countsHint: "How often features are used and what broke. Never what you write.",
  euOff: "You're in the EU or UK, so these stay off until you turn them on.",
  footnote: "Nothing is sent before you sign in. Notes aren't linked to your account and are kept 30 days.",
};

export const EXAMPLE_NOTE = {
  head: "Session note, Tue 24 Nov, research bot",
  lines: [
    ["How it went", "Mostly good. They asked to compare three flats near [place] and draft a short note to a landlord. The comparison landed first time."],
    ["What got in the way", "The first draft was too formal, so they asked for a shorter one. One listing page didn't load, and the bot said it couldn't check that price."],
    ["How it ended", "Happy. They said thanks and sent the note."],
  ] as Array<[string, string]>,
  removed: "Taken out before sending: 2 names, 1 email, 3 links.",
};

type Shared = { kind: "note" | "counts" | "crash"; when: string; title: string; body: string; extra?: string };
const SHARED: Shared[] = [
  { kind: "note", when: "Today, 14:02", title: "Session note", body: "Went well. They planned a weekend trip to [place] and the bot booked nothing without asking. The train times were right first try.", extra: "Taken out: 1 name, 2 links" },
  { kind: "counts", when: "Today", title: "Usage counts", body: "12 chats, 3 routines ran, 1 app connected, 2 voice calls." },
  { kind: "note", when: "Yesterday, 19:40", title: "Session note", body: "Slow. A spreadsheet was too big to read in one go, so the bot asked to split it. They gave up and asked for a summary of the first sheet only.", extra: "Taken out: 1 email" },
  { kind: "crash", when: "Sun 22 Nov", title: "Crash report", body: "The app closed while a chat was loading. Version 0.2.31 on macOS 15." },
];
const KIND_GLYPH: Record<Shared["kind"], SettingGlyphName> = { note: "bubble", counts: "chart", crash: "bolt" };

/** The scrubbed example note, folding open on a grid row so the height eases instead of jumping. */
export function ExampleNote({ open, compact = false }: { open: boolean; compact?: boolean }) {
  return (
    <div className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }} aria-hidden={!open}>
      <div className="min-h-0 overflow-hidden">
        <div className={cn("mt-3 rounded-[12px] bg-ink/[0.045] text-start", compact ? "px-3 py-2.5" : "px-3.5 py-3")}>
          <p className="m-0 text-[12px] leading-4 text-ink-secondary">{EXAMPLE_NOTE.head}</p>
          <dl className="m-0 mt-2 flex flex-col gap-1.5">
            {EXAMPLE_NOTE.lines.map(([label, text]) => (
              <div key={label}><dt className="text-[12.5px] font-medium leading-[17px] text-ink">{label}</dt><dd className="m-0 text-[12.5px] leading-[17px] text-ink-secondary">{text}</dd></div>
            ))}
          </dl>
          <p className="m-0 mt-2 text-[12px] leading-4 text-ink-tertiary">{EXAMPLE_NOTE.removed}</p>
        </div>
      </div>
    </div>
  );
}

function ExampleToggle({ open, onToggle, className }: { open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      className={cn("inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", className)}>
      {open ? "Hide the example" : "See an example note"}
    </button>
  );
}


/** Scales a fixed-size device to the room it is given, never above 1. */
export function Fit({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / w));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [w]);
  return (
    <div ref={host} className="w-full" style={{ height: h * scale }}>
      <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
    </div>
  );
}

export function DesktopFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative size-full overflow-hidden rounded-[12px] bg-app text-ink shadow-[0_24px_48px_-12px_rgb(28_28_28/0.18),0_4px_12px_-4px_rgb(28_28_28/0.08)] [transform:translateZ(0)]">
      {children}
    </div>
  );
}

export function PhoneFrame({ dark, children }: { dark: boolean; children: ReactNode }) {
  return (
    <div className="size-full rounded-[54px] bg-[#1a1a1a] p-[10px] shadow-[0_24px_48px_-12px_rgb(28_28_28/0.25)]">
      <div className="dusk-mobile relative size-full overflow-hidden rounded-[44px] bg-app text-ink [transform:translateZ(0)]" data-scheme={dark ? "dark" : "light"}
        style={{ "--m-sheet-page": "color-mix(in srgb, var(--color-ink) 5%, var(--color-app))" } as CSSProperties}>
        <div aria-hidden className="absolute left-1/2 top-[11px] z-50 h-[34px] w-[120px] -translate-x-1/2 rounded-full bg-[#0b0b0b]" />
        {children}
      </div>
    </div>
  );
}


const later = <T,>(value: T, ms = 500) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function ConsentLine({ phone = false }: { phone?: boolean }) {
  const link = "rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <p className={cn("m-0 text-center text-ink-tertiary", phone ? "mt-2 text-[13px] leading-5" : "text-[12px] leading-[18px]")}>
      By continuing you agree to the <a className={link} href="https://dusk.bot/terms" target="_blank" rel="noreferrer">Terms</a> and <a className={link} href="https://dusk.bot/privacy" target="_blank" rel="noreferrer">Privacy policy</a>.
    </p>
  );
}

/** The real sign-in screen with a pretend account service: any provider or code signs straight in. */
export function LoginScreen({ phone = false, onSignedIn }: { phone?: boolean; onSignedIn: () => void }) {
  return (
    <div className={cn("size-full", phone && "pt-12")}>
      <SignIn
        mobile={phone}
        options={() => later({ providers: ["google", "apple"], recovery: true }, 0)}
        emailStart={(email) => later({ outcome: "sent", email, resendAt: Date.now() + 30_000, signupOpen: true } as never)}
        emailVerify={() => later({ outcome: "signed-in" } as never)}
        browser={() => later(null, 350).then(onSignedIn)}
        cancelEmail={() => later(null, 0)}
        onSignedIn={onSignedIn}
      >
        <ConsentLine phone={phone} />
      </SignIn>
    </div>
  );
}


type Bot = { name: string; color: MausColor; preview: string };
const BOTS: Bot[] = [
  { name: "dusk bot", color: "chrome", preview: "Hi! I'm dusk bot, your helper for everything here." },
  { name: "Scout", color: "green", preview: "The Alcântara flat is the closest to the station." },
  { name: "Quill", color: "blue", preview: "Here's a shorter version of the note." },
];

export type ChatTurn = { me?: string; bot?: string };
export const FIRST_CHAT: ChatTurn[] = [{ bot: t("helperIntro.hi.helper", { name: "dusk bot" }) + " " + t("helperIntro.lead.member") }];
export const FIFTH_CHAT: ChatTurn[] = [
  { me: "Can you compare the three flats I sent and tell me which is closest to a metro station?" },
  { bot: "The Alcântara one wins: it's a 4 minute walk to the tram and 9 minutes to the train. The Arroios flat is 6 minutes from the metro but €180 more a month. The Graça flat has the best view and the longest walk, about 15 minutes." },
  { me: "Great, draft a short note to the Alcântara landlord asking for a viewing on Saturday." },
  { bot: "Here it is:\n\nHi, I'm Sid. I'm moving to Lisbon in January and I'd love to see the flat on Saturday, 28 November. Any time after 11 works for me. Thanks!" },
];

function Sidebar({ active }: { active: string }) {
  return (
    <aside className="flex w-[248px] shrink-0 flex-col bg-panel px-3 pb-3 pt-3">
      <div className="flex justify-end gap-2 pb-3">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-composer text-ink/70 shadow-[0_1px_3px_rgb(28_28_28/0.08)]"><Search size={16} /></span>
        <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-composer text-ink/70 shadow-[0_1px_3px_rgb(28_28_28/0.08)]"><Plus size={16} /></span>
      </div>
      <nav aria-label="Bots" className="flex flex-col gap-1">
        {BOTS.map((bot) => (
          <div key={bot.name} className={cn("flex items-center gap-3 rounded-[12px] px-2.5 py-2", bot.name === active && "bg-ink/[0.07]")}>
            <MausAvatar color={bot.color} size={32} state="idle" animated={false} personality={false} />
            <div className="min-w-0">
              <div className="truncate text-[14px] leading-5 text-ink">{bot.name}</div>
              <div className="truncate text-[12.5px] leading-[18px] text-ink-secondary">{bot.preview}</div>
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2">
        <span aria-hidden className="size-9 shrink-0 rounded-full bg-[#c9b8f0]" />
        <span className="flex h-9 flex-1 items-center justify-center rounded-full bg-composer text-[13px] text-ink shadow-[0_1px_3px_rgb(28_28_28/0.06)]">Connect apps</span>
      </div>
    </aside>
  );
}

function Bubbles({ turns, color }: { turns: ChatTurn[]; color: MausColor }) {
  const mine = { ...userBubbleStyle(color, { flat: true }), backgroundImage: undefined };
  return (
    <>
      {turns.map((turn, i) => turn.me
        ? <div key={i} className="flex justify-end"><div data-chat-bubble="simple" className={cn("chat-text w-fit whitespace-pre-wrap", SIMPLE_BUBBLE_MAX, SIMPLE_USER_BUBBLE)} style={mine}>{turn.me}</div></div>
        : <div key={i} data-chat-bubble="simple" className={cn("chat-text w-fit whitespace-pre-wrap", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE)}>{turn.bot}</div>)}
    </>
  );
}

export function DesktopChat({ bot = "dusk bot", turns, below, overlay }: { bot?: string; turns: ChatTurn[]; below?: ReactNode; overlay?: ReactNode }) {
  const color = BOTS.find((b) => b.name === bot)?.color ?? "chrome";
  return (
    <div className="flex size-full">
      <Sidebar active={bot} />
      <main className="relative flex min-w-0 flex-1 flex-col bg-app">
        <div className="flex justify-center pt-3">
          <span className="flex h-10 items-center gap-2 rounded-full bg-composer px-3.5 text-[14px] shadow-[0_2px_10px_-2px_rgb(28_28_28/0.1)]">
            <MausAvatar color={color} size={20} state="idle" animated={false} personality={false} />{bot}
          </span>
        </div>
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-end gap-4 overflow-hidden px-8 pb-4 pt-4">
          <Bubbles turns={turns} color={color} />
          {below}
        </div>
        <div className="mx-auto w-full max-w-[720px] px-8 pb-5">
          <div className={cn(SIMPLE_COMPOSER, "rounded-[26px]")}>
            <div className="flex items-center gap-2">
              <span aria-hidden className={cn(SIMPLE_CONTROL, "flex items-center justify-center")}><Plus size={15} /></span>
              <span className="flex-1 text-[15px] text-ink-tertiary">Message {bot}</span>
              <span aria-hidden className={cn(SIMPLE_CONTROL, "flex items-center justify-center")}><Mic size={15} /></span>
              <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-ink text-app"><AudioLines size={15} /></span>
            </div>
          </div>
        </div>
        {overlay}
      </main>
    </div>
  );
}


type Answer = { onYes: () => void; onNo: () => void };

function Modal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-scrim absolute inset-0 z-20 flex items-center justify-center p-4 [animation:dusk-fade-in_200ms_var(--dusk-ease-out)_backwards]">
      <div role="dialog" aria-modal="true" aria-label={label} className="ui-modal relative flex w-[400px] flex-col items-center border-0 px-6 pb-4 pt-7 text-center text-ink">
        {children}
      </div>
    </div>
  );
}

export function CardA({ example, eu, onYes, onNo }: { example: boolean; eu: boolean } & Answer) {
  const [open, setOpen] = useState(example);
  useEffect(() => setOpen(example), [example]);
  return (
    <Modal label="Help make dusk bot better?">
      <MausAvatar color="chrome" size={52} state="idle" animated={false} />
      <h2 className="mt-4 text-[19px] font-semibold leading-6 tracking-[-0.012em]">Help make dusk bot better?</h2>
      <p className="mt-1.5 text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">
        Share usage counts, crash reports and short notes on how sessions went. Your own AI writes each note on this computer from a few recent messages, and takes out names, emails and links first.
      </p>
      <p className="mt-2 text-[13px] leading-[18px] text-ink-tertiary">{eu ? "Nothing is shared unless you say yes. " : ""}{COPY.notesFacts}</p>
      <ExampleToggle open={open} onToggle={() => setOpen((v) => !v)} className="mt-1" />
      <div className="w-full"><ExampleNote open={open} /></div>
      <button type="button" onClick={onYes} className={cn(PRIMARY_BUTTON, "mt-4 w-full justify-center")}>Sure, help out</button>
      <button type="button" onClick={onNo} className="mt-1 min-h-9 rounded-full px-3 text-[13px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">Not now</button>
    </Modal>
  );
}

export function CardE({ example, eu, onYes, onNo }: { example: boolean; eu: boolean } & Answer) {
  const [open, setOpen] = useState(example);
  const [counts, setCounts] = useState(false);
  useEffect(() => setOpen(example), [example]);
  return (
    <Modal label="Help make dusk bot better?">
      <MausAvatar color="chrome" size={52} state="idle" animated={false} />
      <h2 className="mt-4 text-[19px] font-semibold leading-6 tracking-[-0.012em]">Help make dusk bot better?</h2>
      <div data-settings-look="simple" className="mt-4 w-full text-start">
        {eu ? (
          <div className="flex items-center gap-3 rounded-[12px] bg-ink/[0.045] px-3 py-2.5">
            <div className="min-w-0 flex-1"><div id="e-counts" className="text-[13px] leading-[18px] text-ink">Usage counts and crash reports</div><div className="text-[12.5px] leading-[17px] text-ink-secondary">{COPY.countsHint}</div></div>
            <Switch checked={counts} aria-labelledby="e-counts" onClick={() => setCounts((v) => !v)} />
          </div>
        ) : (
          <p className="m-0 flex gap-2 rounded-[12px] bg-ink/[0.045] px-3 py-2.5 text-[12.5px] leading-[17px] text-ink-secondary">
            <Check size={14} aria-hidden className="mt-px shrink-0 text-ink" />
            <span>Usage counts and crash reports are on, as the Terms say. They never include what you write. Change this in Settings anytime.</span>
          </p>
        )}
        <h3 className="mt-4 text-[14px] font-medium leading-5">Session notes</h3>
        <p className="m-0 mt-1 text-[13px] leading-[18px] text-ink-secondary">{COPY.notesPlain}</p>
        <p className="m-0 mt-1.5 text-[12.5px] leading-[17px] text-ink-tertiary">{COPY.notesFacts}</p>
        <ExampleToggle open={open} onToggle={() => setOpen((v) => !v)} className="-ms-2 mt-1" />
        <ExampleNote open={open} />
      </div>
      <button type="button" onClick={onYes} className={cn(PRIMARY_BUTTON, "mt-4 w-full justify-center")}>Share session notes</button>
      <button type="button" onClick={onNo} className="mt-1 min-h-9 rounded-full px-3 text-[13px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">Not now</button>
    </Modal>
  );
}


export function FirstLaunch({ eu, example, phone = false, onContinue }: { eu: boolean; example: boolean; phone?: boolean; onContinue: () => void }) {
  const [counts, setCounts] = useState(!eu);
  const [notes, setNotes] = useState(false);
  const [open, setOpen] = useState(example);
  useEffect(() => setOpen(example), [example]);
  if (phone) {
    return (
      <div className="flex size-full flex-col overflow-y-auto px-2 pb-8 pt-16" style={{ background: "var(--m-sheet-page)" }}>
        <div className="flex justify-center"><MausAvatar color="green" size={64} state="idle" animated={false} personality={false} /></div>
        <h1 className="mt-4 text-center text-[24px] font-semibold tracking-tight">Before you start</h1>
        <p className="mx-6 mt-2 text-center text-[15px] leading-[1.45] text-ink-secondary">Two quick choices. You can change both in Settings.</p>
        <PhoneSection card>
          <PhoneSwitch label="Usage counts and crash reports" detail={eu ? `${COPY.countsHint} Off until you turn it on.` : `${COPY.countsHint} Part of the Terms.`} checked={counts} onChange={setCounts} />
        </PhoneSection>
        <PhoneSection card hint={<><span className="block">{COPY.notesFacts}</span><ExampleToggle open={open} onToggle={() => setOpen((v) => !v)} className="-ms-2" /><ExampleNote open={open} compact /></>}>
          <PhoneSwitch label="Session notes" detail={COPY.notesPlain} checked={notes} onChange={setNotes} />
        </PhoneSection>
        <div className="mt-6 px-4"><button type="button" className={PHONE_PRIMARY} onClick={onContinue}>Continue</button>
          <p className="mt-3 text-center text-[13px] text-ink-secondary">Nothing is sent until you sign in.</p></div>
      </div>
    );
  }
  return (
    <main className="flex size-full flex-col items-center overflow-y-auto bg-app px-6 py-8" data-settings-look="simple">
      <div className="my-auto flex w-full max-w-[420px] flex-col gap-4">
        <div className="flex justify-center"><MausAvatar color="green" size={80} state="idle" animated={false} personality={false} /></div>
        <div className="text-center"><h1 className="text-[24px] font-semibold tracking-tight">Before you start</h1><p className="mt-2 text-[14px] leading-5 text-ink-secondary">Two quick choices. You can change both in Settings.</p></div>
        <SettingsRows>
          <SettingRow icon="chart" title="Usage counts and crash reports" subtitle={eu ? `${COPY.countsHint} Off until you turn it on.` : `${COPY.countsHint} Part of the Terms.`}>
            <Switch checked={counts} aria-label="Usage counts and crash reports" onClick={() => setCounts((v) => !v)} />
          </SettingRow>
          <SettingRow icon="bubble" title="Session notes" subtitle={<>{COPY.notesPlain} {COPY.notesFacts}<span className="block"><ExampleToggle open={open} onToggle={() => setOpen((v) => !v)} className="-ms-2" /></span></>}>
            <Switch checked={notes} aria-label="Session notes" onClick={() => setNotes((v) => !v)} />
          </SettingRow>
        </SettingsRows>
        <div className="px-1"><ExampleNote open={open} /></div>
        <button type="button" onClick={onContinue} className="flex min-h-11 w-full items-center justify-center rounded-full bg-ink px-5 text-[14px] font-medium text-app hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">Continue</button>
        <p className="text-center text-[13px] text-ink-tertiary">Nothing is sent until you sign in.</p>
      </div>
    </main>
  );
}


export type InlineState = "ask" | "example" | "yes";

export function InlineAsk({ state, onYes, onNo, onExample, phone = false }: { state: InlineState; onYes: () => void; onNo: () => void; onExample: () => void; phone?: boolean }) {
  const yes = cardPrimary(CARD_BUTTON_MD);
  if (state === "yes") {
    return <p className="-mt-1 flex items-center gap-2 text-[13px] text-ink-secondary [animation:dusk-fade-in_200ms_var(--dusk-ease-out)_backwards]"><Check size={14} aria-hidden />Thanks. Change this anytime in Settings › Privacy.</p>;
  }
  return (
    <div className="-mt-1 text-ink [animation:dusk-fade-in_240ms_var(--dusk-ease-out)_backwards]">
      <p className={cn("m-0 flex gap-2 text-ink-secondary", phone ? "text-[14px] leading-5" : "text-[13.5px] leading-5")}>
        <span className="mt-px shrink-0"><MausAvatar color="chrome" size={18} state="idle" animated={false} personality={false} /></span>
        <span>Mind if your AI keeps a short note on how chats like this go? It's written here, names and links are taken out, and it isn't linked to you.</span>
      </p>
      <ExampleNote open={state === "example"} compact />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onYes} className={yes.className} style={yes.style}>Sure</button>
        <button type="button" onClick={onNo} className={cardSecondary(CARD_BUTTON_MD)}>Not now</button>
        <button type="button" aria-expanded={state === "example"} onClick={onExample} className={cardTertiary(CARD_BUTTON_MD)}>{state === "example" ? "Hide the example" : "See an example"}</button>
      </div>
    </div>
  );
}


export type SettingsView = "privacy" | "shared" | "confirm" | "empty";
const RAIL: Array<{ label: string; items: Array<[string, SettingGlyphName]> }> = [
  { label: t("settings.rail.you"), items: [[t("settings.section.general"), "gear"], [t("settings.voice.title"), "mic"]] },
  { label: t("settings.rail.yourBots"), items: [[t("settings.simple.page.computer"), "laptop"], [t("settings.grok.group.phone"), "bubble"], [t("settings.pane.permissions"), "shield"], [t("settings.w6.pane.vault"), "key"], [t("settings.pane.models"), "sparkle"]] },
  { label: t("settings.rail.thisApp"), items: [[t("settings.pane.usage"), "chart"], [t("settings.simple.page.updates"), "download"], [t("settings.pane.advanced"), "sliders"]] },
];

function useSettingsState(view: SettingsView, counts: boolean, notes: boolean) {
  const [at, setAt] = useState(view);
  const [c, setC] = useState(counts);
  const [n, setN] = useState(notes);
  useEffect(() => { setAt(view); setC(counts); setN(notes); }, [view, counts, notes]);
  return { at, setAt, c, setC, n, setN };
}

function PrivacyRows({ c, setC, n, setN, onShared, eu }: { c: boolean; setC: (v: boolean) => void; n: boolean; setN: (v: boolean) => void; onShared: () => void; eu: boolean }) {
  return (
    <SettingsGroup label={t("settings.dataSharing.title")} block="data-sharing" footnote={eu ? `${COPY.euOff} ${COPY.footnote}` : COPY.footnote}>
      <SettingsRows>
        <SettingRow icon="chart" title="Usage counts and crash reports" subtitle={COPY.countsHint}>
          <Switch checked={c} aria-label="Usage counts and crash reports" onClick={() => setC(!c)} />
        </SettingRow>
        <SettingRow icon="bubble" title="Session notes" subtitle={<>{COPY.notesPlain}<span className="mt-1 block">{COPY.notesFacts}</span></>}>
          <Switch checked={n} aria-label="Session notes" onClick={() => setN(!n)} />
        </SettingRow>
        <SettingRow icon="shield" title="See what's been shared" subtitle="Every note, count and crash report sent from this computer, with Delete all.">
          <button type="button" className="ui-button" onClick={onShared}>Open</button>
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}

function SharedList({ phone = false }: { phone?: boolean }) {
  return (
    <ul className={cn("m-0 flex list-none flex-col p-0", phone ? "gap-[2px] overflow-hidden rounded-[16px]" : "")}>
      {SHARED.map((item, i) => (
        <li key={i} className={cn("flex gap-3", phone ? "bg-(--color-composer) px-4 py-3" : "rounded-lg px-2 py-2")}>
          <SettingGlyph name={KIND_GLYPH[item.kind]} size={phone ? 22 : 18} className="mt-0.5 shrink-0" mono />
          <div className="min-w-0 flex-1">
            <div className={cn("flex items-baseline justify-between gap-3", phone ? "text-[15px] font-medium" : "text-[13px] leading-[18px]")}><span>{item.title}</span><span className="shrink-0 text-[12px] font-normal text-ink-tertiary">{item.when}</span></div>
            <p className={cn("m-0 mt-0.5 text-ink-secondary", phone ? "text-[14px] leading-5" : "text-[13px] leading-[18px]")}>{item.body}</p>
            {item.extra && <p className="m-0 mt-0.5 text-[12px] leading-4 text-ink-tertiary">{item.extra}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const SHARED_LEAD = "Everything sent from this computer in the last 30 days. Notes aren't linked to your account, so this list lives only here, and Delete all is the way to remove them from our side too.";

function SharedPane({ at, setAt }: { at: SettingsView; setAt: (v: SettingsView) => void }) {
  if (at === "empty") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-16 text-center [animation:dusk-fade-in_200ms_var(--dusk-ease-out)_backwards]">
        <span className="flex size-10 items-center justify-center rounded-full bg-ink/[0.06]"><Check size={18} aria-hidden /></span>
        <p role="status" className="m-0 text-[14px] font-medium">Deleted</p>
        <p className="m-0 max-w-[44ch] text-[13px] leading-[18px] text-ink-secondary">Nothing shared from this computer is kept anymore. New notes and counts show up here as they're sent.</p>
      </div>
    );
  }
  return (
    <>
      <SettingsGroup label="Sent from this computer" hint={SHARED_LEAD} actions={at === "shared" ? <button type="button" className="ui-button ui-button-danger" onClick={() => setAt("confirm")}><Trash2 size={13} aria-hidden />Delete all</button> : undefined}>
        {at === "confirm" && (
          <div role="alertdialog" aria-label="Delete everything shared?" className="flex flex-wrap items-center gap-3 rounded-[12px] bg-composer px-3 py-2.5 [animation:dusk-fade-in_180ms_var(--dusk-ease-out)_backwards]">
            <div className="min-w-0 flex-1"><p className="m-0 text-[13px] leading-[18px]">Delete everything shared from this computer?</p><p className="m-0 text-[12.5px] leading-[17px] text-ink-secondary">Notes, counts and crash reports are removed on our side within a day.</p></div>
            <button type="button" className="ui-button" onClick={() => setAt("shared")}>Cancel</button>
            <button type="button" className="ui-button ui-button-danger" onClick={() => setAt("empty")}>Delete all</button>
          </div>
        )}
        <SettingsRows><SharedList /></SettingsRows>
      </SettingsGroup>
    </>
  );
}

export function DesktopSettings({ view, counts, notes, eu, behind }: { view: SettingsView; counts: boolean; notes: boolean; eu: boolean; behind: ReactNode }) {
  const s = useSettingsState(view, counts, notes);
  const sub = s.at !== "privacy";
  return (
    <>
      {behind}
      <div className="settings-scrim !absolute" data-settings-sheet data-settings-look="simple">
        <div aria-hidden className="settings-backdrop" />
        <div role="dialog" aria-modal="true" aria-label={t("settings.title")} className="settings-dialog [animation:dusk-fade-in_180ms_var(--dusk-ease-out)_backwards]" style={{ width: 900, maxWidth: 900, maxHeight: 640 }}>
          <div className="settings-layout" style={{ height: 620 }}>
            <nav aria-label={t("settings.grok.navAria")} className="settings-nav">
              {RAIL.map((group) => (
                <div key={group.label} className="settings-nav-group" role="group" aria-label={group.label}>
                  <p aria-hidden className="settings-nav-label">{group.label}</p>
                  <div className="settings-nav-list">
                    {group.items.map(([label, glyph]) => (
                      <button key={label} type="button" className="settings-nav-item" aria-current={label === t("settings.section.general") ? "page" : undefined}>
                        <SettingGlyph name={glyph} size={18} className="-mx-px" mono /><span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
            <section className="settings-panel" aria-label={sub ? "See what's been shared" : t("settings.section.general")}>
              <button type="button" aria-label={t("settings.grok.close")} className="settings-close"><X size={14} /></button>
              <header className="settings-pane-header">
                <div className="flex min-w-0 items-center gap-1.5">
                  {sub && <button type="button" aria-label={t("common.back")} onClick={() => s.setAt("privacy")} className="flex size-8 items-center justify-center rounded-full text-ink/70 hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-focus"><ChevronLeft size={16} /></button>}
                  <h2 className={cn("settings-pane-title", sub && "ps-0")}>{sub ? "See what's been shared" : t("settings.section.general")}</h2>
                </div>
              </header>
              <div className="settings-scroll">
                <div key={sub ? "sub" : "top"} className={cn("settings-pane", SIMPLE_BUTTONS, "[animation:dusk-fade-in_160ms_var(--dusk-ease-out)_backwards]")}>
                  {sub ? <SharedPane at={s.at} setAt={s.setAt} /> : <>
                    <SettingsGroup label={t("settings.section.appearance")}>
                      <SettingsRows>
                        <SettingRow icon="theme" title="Theme"><span className="text-ink-secondary">System</span></SettingRow>
                      </SettingsRows>
                    </SettingsGroup>
                    <PrivacyRows c={s.c} setC={s.setC} n={s.n} setN={s.setN} onShared={() => s.setAt("shared")} eu={eu} />
                  </>}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}


export function PhoneChat({ bot = "Scout", turns, below, sheet }: { bot?: string; turns: ChatTurn[]; below?: ReactNode; sheet?: ReactNode }) {
  const color = BOTS.find((b) => b.name === bot)?.color ?? "chrome";
  return (
    <div className="relative flex size-full flex-col bg-app">
      <div className="flex items-center gap-2 px-4 pt-[58px]">
        <span aria-hidden className="mobile-float flex size-11 items-center justify-center rounded-full bg-composer"><ChevronLeft size={20} /></span>
        <span className="mobile-float mx-auto flex h-11 items-center gap-2 rounded-full bg-composer px-4 text-[16px]"><MausAvatar color={color} size={20} state="idle" animated={false} personality={false} />{bot}</span>
        <span aria-hidden className="mobile-float flex size-11 items-center justify-center rounded-full bg-composer"><MoreHorizontal size={20} /></span>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-3 overflow-hidden px-4 pb-3 [&_[data-chat-bubble]]:max-w-[86%]">
        <Bubbles turns={turns} color={color} />
        {below}
      </div>
      <div className="px-4 pb-8">
        <div className="flex h-[52px] items-center gap-3 rounded-full bg-composer px-4 shadow-[0_2px_10px_-2px_rgb(28_28_28/0.1)]">
          <Plus size={20} aria-hidden className="text-ink/60" /><span className="flex-1 text-[16px] text-ink-tertiary">Message {bot}</span><Mic size={20} aria-hidden className="text-ink/60" />
        </div>
      </div>
      {sheet}
    </div>
  );
}

export function PhoneSheet({ split, eu, example, onYes, onNo }: { split: boolean; eu: boolean; example: boolean } & Answer) {
  const [open, setOpen] = useState(example);
  const [counts, setCounts] = useState(false);
  useEffect(() => setOpen(example), [example]);
  return (
    <div className="absolute inset-0 z-30">
      <div aria-hidden className="absolute inset-0 bg-[rgb(12_12_14/0.30)] [animation:dusk-fade-in_220ms_var(--m-ease-out)_backwards]" />
      <div role="dialog" aria-modal="true" aria-label="Help make dusk bot better?" className="mobile-sheet absolute inset-x-0 bottom-0 flex max-h-[calc(100%-60px)] flex-col overflow-hidden rounded-t-[28px] bg-(--m-sheet-page) [animation:privacy-lab-rise_320ms_var(--m-ease-out)_backwards]">
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-9 shrink-0 rounded-full bg-ink/[0.14]" />
        <div className="overflow-y-auto px-5 pb-8 pt-4">
          <MausAvatar color="chrome" size={52} state="idle" animated={false} />
          <h2 className="mt-3 text-[22px] font-semibold leading-7 tracking-tight">Help make dusk bot better?</h2>
          {split ? <>
            {eu
              ? <div className="-mx-4 mt-3"><PhoneSection card><PhoneSwitch label="Usage counts and crash reports" detail={COPY.countsHint} checked={counts} onChange={setCounts} /></PhoneSection></div>
              : <p className="mt-2 flex gap-2 text-[15px] leading-[1.45] text-ink-secondary"><Check size={16} aria-hidden className="mt-[3px] shrink-0 text-ink" />Usage counts and crash reports are on, as the Terms say. They never include what you write.</p>}
            <h3 className="mt-4 text-[17px] font-semibold">Session notes</h3>
            <p className="mt-1 text-[15px] leading-[1.45] text-ink-secondary">{COPY.notesPlain}</p>
          </> : <p className="mt-2 text-[16px] leading-6 text-ink">Share usage counts, crash reports and short notes on how sessions went. Your own AI writes each note from a few recent messages, and takes out names, emails and links first.</p>}
          <p className="mt-2 text-[14px] leading-5 text-ink-secondary">{COPY.notesFacts}</p>
          <ExampleToggle open={open} onToggle={() => setOpen((v) => !v)} className="-ms-2 mt-1 min-h-11 text-[14px]" />
          <ExampleNote open={open} compact />
          <div className="mt-5 flex flex-col gap-1">
            <button type="button" className={PHONE_PRIMARY} onClick={onYes}>{split ? "Share session notes" : "Sure, help out"}</button>
            <button type="button" className={PHONE_QUIET} onClick={onNo}>Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PhoneSettings({ view, counts, notes, eu }: { view: SettingsView; counts: boolean; notes: boolean; eu: boolean }) {
  const s = useSettingsState(view, counts, notes);
  const sub = s.at !== "privacy";
  return (
    <div className="flex size-full flex-col" style={{ background: "var(--m-sheet-page)" }}>
      <div className="flex min-h-[52px] shrink-0 items-center gap-3 px-4 pb-2 pt-[58px]">
        {sub && <button type="button" aria-label={t("common.back")} onClick={() => s.setAt("privacy")} className="mobile-press flex size-11 items-center justify-center rounded-full bg-composer"><ChevronLeft size={20} /></button>}
        <div className="min-w-0 flex-1 truncate ps-1 text-[17px] font-semibold">{sub ? "What's been shared" : t("settings.title")}</div>
        <span aria-hidden className="flex size-11 items-center justify-center rounded-full bg-composer"><X size={18} /></span>
      </div>
      <div key={sub ? "sub" : "top"} className="min-h-0 flex-1 overflow-y-auto pb-10 [animation:dusk-fade-in_160ms_var(--m-ease-out)_backwards]">
        {!sub ? <>
          <PhoneSection card title="Bots">
            <PhoneRow icon={<FileText />} label="Routines" onClick={() => {}} />
          </PhoneSection>
          <PhoneSection card title={t("settings.dataSharing.title")} hint={eu ? `${COPY.euOff} ${COPY.footnote}` : COPY.footnote}>
            <PhoneSwitch icon={<ShieldCheck />} label="Usage counts and crash reports" detail={COPY.countsHint} checked={s.c} onChange={s.setC} />
            <PhoneSwitch icon={<FileText />} label="Session notes" detail={`${COPY.notesPlain} ${COPY.notesFacts}`} checked={s.n} onChange={s.setN} />
            <PhoneRow icon={<Eye />} label="See what's been shared" onClick={() => s.setAt("shared")} />
          </PhoneSection>
        </> : s.at === "empty" ? (
          <div className="flex flex-col items-center gap-2 px-8 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-ink/[0.06]"><Check size={20} aria-hidden /></span>
            <p role="status" className="m-0 text-[17px] font-semibold">Deleted</p>
            <p className="m-0 text-[15px] leading-[1.45] text-ink-secondary">Nothing shared from your computer is kept anymore. New notes and counts show up here as they're sent.</p>
          </div>
        ) : <>
          <p className="mx-8 mb-3 mt-1 text-[14px] leading-5 text-ink-secondary">{SHARED_LEAD.replace("this computer", "your computer")}</p>
          <div className="px-4"><SharedList phone /></div>
          <div className="mt-6 px-4">
            {s.at === "confirm" ? <div role="alertdialog" aria-label="Delete everything shared?" className="rounded-[16px] bg-composer p-4">
              <p className="m-0 text-[16px] font-medium">Delete everything shared from your computer?</p>
              <p className="m-0 mt-1 text-[14px] leading-5 text-ink-secondary">Notes, counts and crash reports are removed on our side within a day.</p>
              <div className="mt-3 flex flex-col gap-1"><button type="button" className={cn(PHONE_PRIMARY, "bg-danger text-white")} onClick={() => s.setAt("empty")}>Delete all</button><button type="button" className={PHONE_QUIET} onClick={() => s.setAt("shared")}>Cancel</button></div>
            </div> : <button type="button" className={cn(PHONE_QUIET, "text-danger")} onClick={() => s.setAt("confirm")}>Delete all</button>}
          </div>
        </>}
      </div>
    </div>
  );
}

