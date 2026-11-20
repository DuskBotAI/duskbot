import type { ReactNode } from "react";
import { Clock, CreditCard, Gauge, KeyRound, Sparkles } from "@/icons";
import { cx } from "../ui/kit";
import { m, SwapText, useSlots } from "../ui/motion";
import { Figure } from "../ui/Figure";
import { Table, Td, Th } from "../ui/table";
import { duration, percent } from "./kit";
import { n } from "./ui";

interface Count { key: string; count: number }
interface RateRow { key: string; total: number; good: number; bad: number; rate: number | null; reason?: string }
export interface MoreAnswer {
  setup: { onboarding: Array<{ step: string; reached: number; medianMs: number | null }>; signIn: RateRow[];
    /** the app's account sign-in funnel, by install; absent from an older server */
    account?: { steps: Array<{ step: string; reached: number }>; methods: RateRow[]; errors: Count[] };
    /** the app's account step to the website and back, one person across both; absent from an older server */
    handoff?: Array<{ step: string; side: "app" | "web"; from: string | null; reached: number; medianMs: number | null }> };
  reliability: { firstP50: number | null; firstP90: number | null; engines: Array<{ key: string; turns: number; p50: number | null; p90: number | null; firstP50: number | null }>;
    models: Array<{ key: string; turns: number; p50: number | null; firstP50: number | null; failRate: number | null }>; toolErrors: Array<{ kind: "tool" | "app"; key: string; errors: number; turns: number; rate: number | null }>;
    /** absent from an older server */
    toolFailures?: Array<{ tool: string; error: string; turns: number; calls: number; people: number }>;
    crashes: { count: number; people: number; top: Count[] }; wake: { count: number; p50Ms: number | null; p90Ms: number | null } };
  engagement: { sessionsPerPersonDay: number | null; sessionMedianMs: number | null; hours: number[]; weekdays: number[]; turnsPerChat: number | null; chatsPerPersonDay: number | null;
    attachments: Count[]; attachmentSizes: Count[]; chatsDeleted: number; archivedShare: number | null; settings: Count[] };
  bots: { perPerson: number | null; engines: Count[]; topBotShare: number | null; memory: Count[]; roles: Count[] };
  apps: { connects: RateRow[]; actions: Count[] };
  routines: { every: RateRow[]; runP50: number | null; survival: { eligible: number; survived: number; share: number | null } };
  money: { planViews: number; checkouts: { started: number; paid: number; abandoned: number; rate: number | null }; cancelReasons: Count[]; upgrades: number; downgrades: number };
  discovery: Array<{ feature: string; people: number; share: number | null; medianDays: number | null }>;
  setups: Record<"version" | "os" | "arch" | "locale" | "screen" | "theme" | "skin" | "notifications", Count[]>;
}
export type MoreDetail = "setup" | "reliability" | "daily" | "bots" | "connects" | "money" | "discovery" | "setups";
export const MORE_TITLE: Record<MoreDetail, string> = { setup: "setup and sign-in", reliability: "speed and errors", daily: "day to day", bots: "bots", connects: "connecting apps",
  money: "money", discovery: "features people find", setups: "what people run it on" };

const I = { size: 14, strokeWidth: 1.75 } as const;
const words = (key: string) => key.replace(/_/g, " ");
const TOOL_WORDS: Record<string, string> = { app: "connected apps", web: "web search", computer: "computer use", mcp: "mcp tools", other: "other tools" };
const TOOL_ERROR_WORDS: Record<string, string> = { not_found: "not found", schema_invalid: "bad arguments (model)", bot_wall: "bot wall", crashed: "crashed" };
const toolWords = (kind: "tool" | "app", key: string) => kind === "tool" ? TOOL_WORDS[key] ?? words(key) : words(key);
const ACCOUNT_STEP: Record<string, string> = { shown: "saw the sign-in", method: "picked a way", handoff: "went to the website", returned: "came back signed in",
  cancelled: "cancelled", skipped: "skipped", error: "hit an error", back: "back from the website" };
const HANDOFF_STEP: Record<string, string> = { shown: "saw the account step", method: "picked a way", handoff: "went to the website", landed: "opened the sign-in page",
  signed_in: "app signed in by itself", app_place: "app: picked where bots live", app_done: "app: finished its first run", name: "named themselves", plan: "saw the plans",
  checkout: "opened checkout", all_set: "reached all set", sent_back: "sent back to the app", back: "back in the app" };
const STEP: Record<string, string> = { name: "named themselves", plan: "picked a plan", app: "got the app", done: "finished setup" };
const CANCEL: Record<string, string> = { feature: "missing a feature", price: "too expensive", setup: "hard to set up", broken: "something broke", later: "not now", other: "other" };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const days = (value: number | null) => value === null ? "-" : value < 1 ? "same day" : `${Math.round(value)} day${Math.round(value) === 1 ? "" : "s"}`;

function Card({ title, icon, wash = "bg-card", onOpen, children }: { title: string; icon: ReactNode; wash?: string; onOpen(): void; children: ReactNode }) {
  return (
    <section aria-label={title} className={cx("min-w-0 rounded-[24px] p-4", wash)}>
      <button type="button" onClick={onOpen} className="mb-2 flex w-full items-center gap-2 px-1 text-start"><span aria-hidden className="text-ink-3">{icon}</span><h3 className="flex-1 text-14 font-medium text-ink">{title}</h3><span className="text-12 text-ink-3">all</span></button>
      {children}
    </section>
  );
}
function Line({ label, value, bar, note, onClick }: { label: ReactNode; value: string; bar?: number | null; note?: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="hover-row relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-[10px] px-2.5 text-start text-13">
      {bar !== undefined && bar !== null && <m.span className="absolute inset-y-0 left-0 rounded-[10px] bg-accent/10" initial={{ width: 0 }} animate={{ width: `${Math.min(1, bar) * 100}%` }} transition={{ type: "spring", visualDuration: 0.4, bounce: 0 }} aria-hidden />}
      <span className="relative min-w-0 flex-1 truncate text-ink">{typeof label === "string" ? <SwapText text={label} className="w-full" /> : label}</span>
      {note && <span className="relative truncate text-12 font-medium text-ink-3 max-sm:hidden"><SwapText text={note} /></span>}
      <span className="relative min-w-14 shrink-0 whitespace-nowrap text-end font-mono text-ink num"><Figure value={value} className="!font-mono !text-13 !leading-5 !tracking-normal" /></span>
    </button>
  );
}
/** rows whose data swaps keep their elements (see useSlots), so a new window morphs the list instead of rebuilding it */
function Slotted<T>({ rows, keyOf, render }: { rows: T[]; keyOf(row: T): string; render(row: T, key: string): ReactNode }) {
  const slots = useSlots(rows.map(keyOf));
  return <>{rows.map((row, i) => render(row, slots[i]!))}</>;
}
const Empty = ({ children }: { children: ReactNode }) => <p className="px-2 py-3 text-13 text-ink-2">{children}</p>;

/** the decisions behind setup, speed, money and discovery, each a card that opens its table */
export function MoreCards({ more, open }: { more: MoreAnswer; open(detail: MoreDetail): void }) {
  const r = more.reliability, money = more.money, signups = Math.max(1, more.setup.onboarding[0]?.reached ?? 0);
  const peak = more.engagement.hours.indexOf(Math.max(...more.engagement.hours));
  return (
    <>
      <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
        <Card title="setup and sign-in" icon={<KeyRound {...I} />} wash="bg-wash-sky" onOpen={() => open("setup")}>
          {more.setup.onboarding.map((step) => <Line key={step.step} label={STEP[step.step] ?? words(step.step)} value={n(step.reached)} bar={step.reached / signups} onClick={() => open("setup")} />)}
          {more.setup.handoff?.[0]?.reached ? <p className="mt-2 px-1 text-12 text-ink-3">sign-up from the app: {n(more.setup.handoff.find((row) => row.step === "back")?.reached ?? 0)} of {n(more.setup.handoff[0].reached)} back in the app</p> : null}
          {more.setup.account?.steps[0]?.reached ? <p className="mt-2 px-1 text-12 text-ink-3">app sign-in: {n(more.setup.account.steps.find((row) => row.step === "returned")?.reached ?? 0)} of {n(more.setup.account.steps[0].reached)} who saw it signed in</p> : null}
          {more.setup.signIn.length ? <p className="mt-2 px-1 text-12 text-ink-3">ai sign-ins that finish: {more.setup.signIn.slice(0, 4).map((row) => `${row.key} ${percent(row.rate)}`).join(", ")}</p> : null}
        </Card>
        <Card title="speed and errors" icon={<Gauge {...I} />} onOpen={() => open("reliability")}>
          <div className="mb-2 grid grid-cols-3 gap-2">
            {[["first reply", duration(r.firstP50)], ["cloud wakes in", duration(r.wake.p50Ms)], ["crashes", n(r.crashes.count)]].map(([label, value]) => (
              <button key={label} type="button" onClick={() => open("reliability")} className="rounded-[16px] bg-pop px-3 py-2 text-start"><span className="block truncate text-12 text-ink-3">{label}</span><span className="block font-mono text-[20px] font-medium leading-7 text-ink num">{value}</span></button>
            ))}
          </div>
          {r.toolErrors.length ? <Slotted rows={r.toolErrors.slice(0, 3)} keyOf={(row) => `${row.kind}:${row.key}`} render={(row, key) => <Line key={key} label={`${toolWords(row.kind, row.key)} ${row.kind}`} value={percent(row.rate)} note={`${n(row.errors)} errors`} onClick={() => open("reliability")} />} />
            : <Empty>no tool errors in this window.</Empty>}
        </Card>
      </div>
      <div className="grid grid-cols-3 gap-2 max-lg:grid-cols-1">
        <Card title="money" icon={<CreditCard {...I} />} wash="bg-wash-lime" onOpen={() => open("money")}>
          <Line label="looked at plans" value={n(money.planViews)} onClick={() => open("money")} />
          <Line label="started a checkout" value={n(money.checkouts.started)} onClick={() => open("money")} />
          <Line label="paid" value={n(money.checkouts.paid)} note={percent(money.checkouts.rate)} bar={money.checkouts.rate} onClick={() => open("money")} />
          <p className="mt-2 px-1 text-12 text-ink-3">{money.cancelReasons.length ? `why people cancel: ${money.cancelReasons.slice(0, 3).map((row) => `${CANCEL[row.key] ?? words(row.key)} ${n(row.count)}`).join(", ")}. ` : "no cancellations in this window. "}{n(money.upgrades)} upgrades, {n(money.downgrades)} downgrades.</p>
        </Card>
        <Card title="day to day" icon={<Clock {...I} />} onOpen={() => open("daily")}>
          <Line label="sessions a day" value={more.engagement.sessionsPerPersonDay === null ? "-" : String(Math.round(more.engagement.sessionsPerPersonDay * 10) / 10)} onClick={() => open("daily")} />
          <Line label="a session lasts" value={duration(more.engagement.sessionMedianMs)} onClick={() => open("daily")} />
          <Line label="turns per chat" value={more.engagement.turnsPerChat === null ? "-" : n(more.engagement.turnsPerChat)} onClick={() => open("daily")} />
          <Line label="busiest hour" value={Math.max(...more.engagement.hours) > 0 ? `${String(peak).padStart(2, "0")}:00` : "-"} onClick={() => open("daily")} />
          <button type="button" onClick={() => open("setups")} className="hover-link mt-1 px-2.5 text-12 text-ink-3">what people run it on</button>
        </Card>
        <Card title="features people find" icon={<Sparkles {...I} />} wash="bg-wash-lilac" onOpen={() => open("discovery")}>
          {more.discovery.length ? <Slotted rows={more.discovery.slice(0, 5)} keyOf={(row) => row.feature} render={(row, key) => <Line key={key} label={words(row.feature)} value={percent(row.share)} bar={row.share} note={days(row.medianDays)} onClick={() => open("discovery")} />} />
            : <Empty>no feature use recorded yet.</Empty>}
        </Card>
      </div>
    </>
  );
}

function CountTable({ title, rows, label = words }: { title: string; rows: Count[]; label?(key: string): string }) {
  return (
    <Table label={title}>
      <thead><tr><Th>{title}</Th><Th className="!text-end">count</Th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><Td>{label(row.key)}</Td><Td className="text-end font-mono num">{n(row.count)}</Td></tr>)}{!rows.length && <tr><Td colSpan={2} className="py-6 text-center text-ink-3">nothing yet.</Td></tr>}</tbody>
    </Table>
  );
}
function RateTable({ title, rows, good, bad }: { title: string; rows: RateRow[]; good: string; bad: string }) {
  return (
    <Table label={title}>
      <thead><tr><Th>{title}</Th><Th className="!text-end">tries</Th><Th className="!text-end">{good}</Th><Th className="!text-end">{bad}</Th><Th className="!text-end">rate</Th><Th>mostly</Th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><Td>{words(row.key)}</Td><Td className="text-end font-mono num">{n(row.total)}</Td><Td className="text-end font-mono num">{n(row.good)}</Td><Td className="text-end font-mono num">{n(row.bad)}</Td><Td className="text-end font-mono num">{percent(row.rate)}</Td><Td className="text-ink-3">{row.reason ? words(row.reason) : ""}</Td></tr>)}
        {!rows.length && <tr><Td colSpan={6} className="py-6 text-center text-ink-3">nothing yet.</Td></tr>}</tbody>
    </Table>
  );
}

export function MoreTable({ detail, more }: { detail: MoreDetail; more: MoreAnswer }) {
  const r = more.reliability, e = more.engagement;
  if (detail === "setup") return (
    <div className="flex flex-col gap-4">
      <Table label="setup steps"><thead><tr><Th>step</Th><Th className="!text-end">people</Th><Th className="!text-end">time on the step before</Th></tr></thead>
        <tbody>{more.setup.onboarding.map((step) => <tr key={step.step}><Td>{STEP[step.step] ?? words(step.step)}</Td><Td className="text-end font-mono num">{n(step.reached)}</Td><Td className="text-end font-mono num">{duration(step.medianMs)}</Td></tr>)}</tbody></Table>
      {more.setup.handoff && more.setup.handoff[0]!.reached > 0 && (
        <Table label="sign-up from the app"><thead><tr><Th>step</Th><Th>where</Th><Th className="!text-end">people</Th><Th className="!text-end">share</Th><Th className="!text-end">median time</Th><Th>since</Th></tr></thead>
          <tbody>{more.setup.handoff.map((row) => <tr key={row.step}><Td>{HANDOFF_STEP[row.step] ?? words(row.step)}</Td><Td>{row.side}</Td><Td className="text-end font-mono num">{n(row.reached)}</Td>
            <Td className="text-end font-mono num">{percent(row.reached / more.setup.handoff![0]!.reached)}</Td><Td className="text-end font-mono num">{duration(row.medianMs)}</Td>
            <Td className="text-ink-3">{row.from ? HANDOFF_STEP[row.from] ?? words(row.from) : ""}</Td></tr>)}</tbody></Table>
      )}
      {more.setup.account && <>
        <Table label="app sign-in"><thead><tr><Th>app sign-in step</Th><Th className="!text-end">installs</Th></tr></thead>
          <tbody>{more.setup.account.steps.map((row) => <tr key={row.step}><Td>{ACCOUNT_STEP[row.step] ?? words(row.step)}</Td><Td className="text-end font-mono num">{n(row.reached)}</Td></tr>)}</tbody></Table>
        <RateTable title="app sign-in by way" rows={more.setup.account.methods} good="signed in" bad="errors" />
        <CountTable title="app sign-in errors" rows={more.setup.account.errors} />
      </>}
      <RateTable title="ai sign-in" rows={more.setup.signIn} good="worked" bad="failed" />
    </div>
  );
  if (detail === "reliability") return (
    <div className="flex flex-col gap-4">
      <Table label="by engine"><thead><tr><Th>engine</Th><Th className="!text-end">turns</Th><Th className="!text-end">first reply</Th><Th className="!text-end">median</Th><Th className="!text-end">slowest 10%</Th></tr></thead>
        <tbody>{r.engines.map((row) => <tr key={row.key}><Td>{row.key}</Td><Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{duration(row.firstP50)}</Td><Td className="text-end font-mono num">{duration(row.p50)}</Td><Td className="text-end font-mono num">{duration(row.p90)}</Td></tr>)}</tbody></Table>
      <Table label="by model"><thead><tr><Th>model</Th><Th className="!text-end">turns</Th><Th className="!text-end">first reply</Th><Th className="!text-end">median</Th><Th className="!text-end">failed</Th></tr></thead>
        <tbody>{r.models.map((row) => <tr key={row.key}><Td>{row.key}</Td><Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{duration(row.firstP50)}</Td><Td className="text-end font-mono num">{duration(row.p50)}</Td><Td className="text-end font-mono num">{percent(row.failRate)}</Td></tr>)}</tbody></Table>
      <Table label="tool and app errors"><thead><tr><Th>what</Th><Th className="!text-end">turns using it</Th><Th className="!text-end">errors</Th><Th className="!text-end">rate</Th></tr></thead>
        <tbody>{r.toolErrors.map((row) => <tr key={`${row.kind}:${row.key}`}><Td>{toolWords(row.kind, row.key)} <span className="text-ink-4">{row.kind}</span></Td><Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{n(row.errors)}</Td><Td className="text-end font-mono num">{percent(row.rate)}</Td></tr>)}</tbody></Table>
      {r.toolFailures?.length ? <Table label="tool failures"><thead><tr><Th>tool</Th><Th>error</Th><Th className="!text-end">turns</Th><Th className="!text-end">calls</Th><Th className="!text-end">people</Th></tr></thead>
        <tbody>{r.toolFailures.map((row) => <tr key={`${row.tool}|${row.error}`}><Td className="font-mono">{row.tool}</Td><Td>{TOOL_ERROR_WORDS[row.error] ?? words(row.error)}</Td><Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{n(row.calls)}</Td><Td className="text-end font-mono num">{n(row.people)}</Td></tr>)}</tbody></Table> : null}
      <CountTable title={`app errors (${n(r.crashes.count)} from ${n(r.crashes.people)} people)`} rows={r.crashes.top} />
      <p className="text-13 text-ink-3">cloud wakes: {n(r.wake.count)}, half within {duration(r.wake.p50Ms)}, 90% within {duration(r.wake.p90Ms)}.</p>
    </div>
  );
  if (detail === "daily") return (
    <div className="flex flex-col gap-4">
      <div><p className="mb-2 text-13 text-ink-3">when apps open, by hour</p><div className="flex h-20 items-end gap-0.5">{e.hours.map((value, hour) => <span key={hour} title={`${hour}:00 ${value}`} className="flex-1 rounded-[3px] bg-accent/60 transition-[height] duration-300 ease-out" style={{ height: `${Math.max(4, (value / Math.max(1, ...e.hours)) * 100)}%` }} />)}</div></div>
      <CountTable title="by weekday" rows={e.weekdays.map((count, day) => ({ key: DAYS[day]!, count }))} />
      <CountTable title="attachments" rows={e.attachments} />
      <CountTable title="attachment size" rows={e.attachmentSizes} label={(key) => ({ lt100k: "under 100 kb", lt1m: "under 1 mb", lt10m: "under 10 mb", gte10m: "10 mb or more" } as Record<string, string>)[key] ?? key} />
      <CountTable title="settings changed" rows={e.settings} label={(key) => key} />
      <p className="text-13 text-ink-3">{n(e.chatsDeleted)} chats deleted; {percent(e.archivedShare)} of chats archived; {e.chatsPerPersonDay === null ? "-" : Math.round(e.chatsPerPersonDay * 10) / 10} chats a day per active person.</p>
    </div>
  );
  if (detail === "bots") return (
    <div className="flex flex-col gap-4">
      <p className="text-13 text-ink-3">the middle person has {more.bots.perPerson ?? "-"} bots; their busiest bot does {percent(more.bots.topBotShare)} of their turns.</p>
      <CountTable title="bots by engine" rows={more.bots.engines} label={(key) => key} />
      <CountTable title="roles picked when making a bot" rows={more.bots.roles} />
      <CountTable title="memory size per workspace" rows={more.bots.memory} label={(key) => key} />
    </div>
  );
  if (detail === "connects") return (
    <div className="flex flex-col gap-4">
      <RateTable title="connect attempts" rows={more.apps.connects} good="connected" bad="failed" />
      <CountTable title="actions used most" rows={more.apps.actions} />
    </div>
  );
  if (detail === "money") return (
    <div className="flex flex-col gap-4">
      <p className="text-13 text-ink-3">{n(more.money.planViews)} plan page views, {n(more.money.checkouts.started)} checkouts started, {n(more.money.checkouts.paid)} paid, {n(more.money.checkouts.abandoned)} left unpaid; {n(more.money.upgrades)} upgrades and {n(more.money.downgrades)} downgrades.</p>
      <CountTable title="why people cancel" rows={more.money.cancelReasons} label={(key) => CANCEL[key] ?? words(key)} />
    </div>
  );
  if (detail === "discovery") return (
    <Table label="features"><thead><tr><Th>feature</Th><Th className="!text-end">people</Th><Th className="!text-end">of active people</Th><Th className="!text-end">time to first use</Th></tr></thead>
      <tbody>{more.discovery.map((row) => <tr key={row.feature}><Td>{words(row.feature)}</Td><Td className="text-end font-mono num">{n(row.people)}</Td><Td className="text-end font-mono num">{percent(row.share)}</Td><Td className="text-end font-mono num">{days(row.medianDays)}</Td></tr>)}
        {!more.discovery.length && <tr><Td colSpan={4} className="py-6 text-center text-ink-3">nothing yet.</Td></tr>}</tbody></Table>
  );
  return (
    <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
      {(Object.keys(more.setups) as Array<keyof MoreAnswer["setups"]>).map((key) => <CountTable key={key} title={key === "version" ? "app version" : key} rows={more.setups[key]} label={(value) => value.replace(/_/g, " ")} />)}
    </div>
  );
}
