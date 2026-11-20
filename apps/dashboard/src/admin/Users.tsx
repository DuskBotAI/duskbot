import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "@/icons";
import { Button, Segmented } from "../ui/kit";
import { toast } from "../lib/toast";
import { Nil, Table, Td, Th } from "../ui/table";
import { ago } from "../lib/format";
import { Link } from "../lib/router";
import { useNow } from "../lib/now";
import { adminCall, AdminApiError, useAdmin, type UserDetail, type UserRow } from "./api";
import { CloudTable } from "./Clouds";
import { duration } from "./kit";
import { endLabel, PlanEditor } from "./PlanEditor";
import { m } from "../ui/motion";
import { AdminHeader, Failed, Loading, money, n, Pager, SearchBox, Section, stamp, Status, Tile } from "./ui";

const FILTERS = [{ value: "all", label: "everyone" }, { value: "paying", label: "paying" }, { value: "cloud", label: "with a cloud" }, { value: "app", label: "with the app" }] as const;
type Filter = (typeof FILTERS)[number]["value"];

function useDebounced(value: string, ms = 220) {
  const [out, setOut] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setOut(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return out;
}

export function UsersPage({ tabs }: { tabs?: ReactNode }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [offset, setOffset] = useState(0);
  const search = useDebounced(q.trim().toLowerCase());
  useEffect(() => setOffset(0), [search, filter]);
  const { data, error, loading, reload } = useAdmin<{ total: number; offset: number; limit: number; users: UserRow[] }>(`/users?q=${encodeURIComponent(search)}&filter=${filter}&offset=${offset}&limit=50`);
  const now = useNow(60_000);
  return (
    <>
      <AdminHeader title="people" sub={data ? `${n(data.total)} ${filter === "all" && !search ? "accounts" : "match"}` : "everyone with an account"} tabs={tabs} />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SearchBox value={q} onChange={setQ} label="search users" placeholder="email, name or account id" />
        <Segmented<Filter> label="show" value={filter} options={[...FILTERS]} onChange={setFilter} />
      </div>
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (data.users.length ? (
        <>
          <Table label="users">
            <thead><tr><Th>account</Th><Th>plan</Th><Th className="!text-end">clouds</Th><Th>app</Th><Th>signed up</Th><Th>last seen</Th></tr></thead>
            <tbody>
              {data.users.map((user) => (
                <m.tr key={user.id} className="hover-row" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ layout: { type: "spring", visualDuration: 0.26, bounce: 0 }, opacity: { duration: 0.18 } }}>
                  <Td className="max-w-[320px]">
                    <Link to={`/admin/users/${encodeURIComponent(user.id)}`} className="text-link block min-w-0 rounded-[6px]">
                      <span className="block truncate text-14 text-ink">{user.email}</span>
                      <span className="block truncate text-12 text-ink-3">{user.name ?? "no name"} · {user.methods.join(", ")}{user.optOut ? " · opted out" : ""}</span>
                    </Link>
                  </Td>
                  <Td>{user.plan ? <Status value={user.plan.trial ? "trial" : user.plan.status} label={`${user.plan.plan ?? "custom"}${user.plan.trial ? ", trial" : user.plan.status === "active" ? "" : `, ${user.plan.status.replace(/_/g, " ")}`}`} /> : <span className="text-13 text-ink-3">free</span>}</Td>
                  <Td className="text-end font-mono num">{user.clouds || <Nil />}</Td>
                  <Td className="text-13 text-ink-2">{user.devices ? `${user.devices} · ${user.platforms.join(", ")}` : <Nil />}</Td>
                  <Td className="t-id whitespace-nowrap text-ink-2">{stamp(user.createdAt).slice(0, 10)}</Td>
                  <Td className="whitespace-nowrap text-13 text-ink-3">{ago(user.lastSeenAt, now)}</Td>
                </m.tr>
              ))}
            </tbody>
          </Table>
          <Pager offset={data.offset} limit={data.limit} total={data.total} onChange={setOffset} />
        </>
      ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">{search ? `no account matches "${search}".` : "no accounts in this view yet."}</p>)}
    </>
  );
}

const EVENT_LABEL: Record<string, string> = {
  account_created: "account created", signup: "signed up", sign_in: "signed in", app_paired: "paired an app", app_active: "used the app", cloud_state: "cloud changed",
  first_bot_reply: "first bot reply", checkout_paid: "payment received", checkout_started: "checkout started", subscription_paid: "plan started", subscription_pending: "plan pending",
  payment: "payment", page_view: "opened a page", onboarding_step: "onboarding step", onboarding_done: "finished onboarding", plan_chosen: "picked a plan",
};
function describe(item: UserDetail["timeline"][number]) {
  const p = item.props;
  if (item.name === "cloud_state") return `${String(p.from ?? "").replace(/_/g, " ")} to ${String(p.to ?? "").replace(/_/g, " ")}`;
  if (item.name === "page_view") return String(p.path ?? "");
  if (typeof p.amountCents === "number") return `${money(p.amountCents)}${p.status ? `, ${p.status}` : ""}`;
  return Object.entries(p).filter(([key]) => key !== "cloudId").map(([key, value]) => key === "ms" && typeof value === "number" ? `for ${duration(value)}` : `${key} ${value}`).join(", ");
}

/** the owner's switch for the growth admin role: analytics and revenue, read only */
function AdminAccess({ detail, onChange }: { detail: UserDetail; onChange(next: UserDetail): void }) {
  const [busy, setBusy] = useState(false);
  const admin = detail.account.admin;
  if (!admin) return null;
  const on = admin.role === "growth";
  const flip = async () => {
    setBusy(true);
    try {
      const answer = await adminCall<{ role: "growth" | null }>(`/users/${encodeURIComponent(detail.account.id)}/admin-role`, { method: "POST", body: { role: on ? null : "growth" } });
      onChange({ ...detail, account: { ...detail.account, admin: { ...admin, role: answer.role } } });
      toast(answer.role ? "growth admin on. they see analytics and revenue." : "growth admin off.");
    } catch (err) {
      toast(err instanceof AdminApiError ? err.message : "that didn't save.", "bad");
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 rounded-[18px] bg-card px-4 py-3">
      <div className="min-w-0">
        <div className="text-14 text-ink">admin access</div>
        <div className="mt-0.5 text-12 text-ink-3">{admin.owner ? "full admin, from the admin email list." : on ? "growth admin: analytics and revenue, read only." : "none. growth admin lets them read analytics and revenue, nothing else."}</div>
      </div>
      {!admin.owner && <Button size="sm" disabled={busy} onClick={flip}>{on ? "remove growth admin" : "make growth admin"}</Button>}
    </div>
  );
}

export function UserPage({ id }: { id: string }) {
  const { data, error, loading, reload, setData } = useAdmin<UserDetail>(`/users/${encodeURIComponent(id)}`);
  const now = useNow(60_000);
  return (
    <>
      <Link to="/admin/people" className="text-link mb-4 inline-flex items-center gap-1.5 text-13"><ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> people</Link>
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={10} />}
      {data && (
        <>
          <AdminHeader title={data.account.name ?? data.account.email} sub={<span className="flex flex-wrap gap-x-3"><span>{data.account.email}</span><span className="t-id">{data.account.id}</span></span>} />
          <div className="grid grid-cols-3 gap-2.5 max-lg:grid-cols-2">
            <Tile label="signed up" value={stamp(data.account.createdAt).slice(0, 10)} note={`with ${data.methods.join(", ")}`} />
            <Tile label="last seen" value={ago(data.account.lastSeenAt, now)} note={data.account.optOut ? "opted out of analytics" : "analytics on"} />
            <Tile label="bot replies, 30 days" value={n(data.workspaces.reduce((sum, ws) => sum + ws.turns30d, 0))} note={`${n(data.workspaces.reduce((sum, ws) => sum + ws.bots, 0))} bots`} />
          </div>
          <AdminAccess detail={data} onChange={setData} />

          <div className="mt-6 grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-start gap-6 max-xl:grid-cols-1">
            <PlanEditor detail={data} onChange={setData} />
            <div className="min-w-0">
              <Section className="!mt-0" title="clouds">{data.clouds.length ? <CloudTable clouds={data.clouds} onChanged={reload} owner={false} /> : <p className="text-14 text-ink-3">no clouds.</p>}</Section>
              <Section title="billing history">
                {data.subscriptions.length || data.payments.length ? (
                  <Table label="billing history">
                    <thead><tr><Th>what</Th><Th>status</Th><Th className="!text-end">amount</Th><Th>when</Th></tr></thead>
                    <tbody>
                      {data.subscriptions.map((sub) => <tr key={sub.id}><Td><span className="block text-14 text-ink">{sub.plan ?? "custom"} plan{sub.comp ? ", comp" : ""}</span><span className="block text-12 text-ink-3">{endLabel(sub)}</span></Td><Td><Status value={sub.status} /></Td><Td className="text-end font-mono text-money num">{sub.comp ? "free" : money(sub.totalCents)}</Td><Td className="t-id text-ink-2">{stamp(sub.createdAt)}</Td></tr>)}
                      {data.payments.map((pay) => <tr key={pay.id}><Td>payment</Td><Td><Status value={pay.status} /></Td><Td className="text-end font-mono text-money num">{money(pay.amountCents)}</Td><Td className="t-id text-ink-2">{stamp(pay.createdAt)}</Td></tr>)}
                    </tbody>
                  </Table>
                ) : <p className="text-14 text-ink-3">nothing billed yet.</p>}
              </Section>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-10 max-lg:grid-cols-1">
            <Section className="!mt-0" title="devices and sessions">
              {data.devices.length ? (
                <ul className="">
                  {data.devices.map((device) => (
                    <li key={device.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <span className="min-w-0"><span className="block truncate text-14 text-ink">{device.name}</span><span className="block text-12 text-ink-3">{device.kind}{device.platform ? ` · ${device.platform}` : ""}{device.appVersion ? ` · ${device.appVersion}` : ""}</span></span>
                      <span className="shrink-0 text-13 text-ink-3">{ago(device.lastSeenAt, now)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-14 text-ink-3">signed in nowhere right now.</p>}
            </Section>
            <Section className="!mt-0" title="workspaces">
              {data.workspaces.length ? (
                <ul className="">
                  {data.workspaces.map((ws) => (
                    <li key={ws.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <span className="min-w-0"><span className="block truncate text-14 text-ink">{ws.name}</span><span className="block text-12 text-ink-3">{ws.kind} · {ws.version || "version unknown"} · {ws.bots} bots · {n(ws.turns30d)} replies in 30 days</span></span>
                      <span className="shrink-0 text-13 text-ink-3">{ws.lastReportAt ? `reported ${ago(ws.lastReportAt, now)}` : "never reported"}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-14 text-ink-3">no workspace connected.</p>}
            </Section>
          </div>

          <Section title="timeline" action={<Link to={`/admin/events?account=${encodeURIComponent(data.account.id)}`} className="text-link text-13">in the events explorer</Link>}>
            {data.timeline.length ? (
              <ol className="relative ms-1">
                {data.timeline.map((item, i) => (
                  <li key={`${item.at}-${item.name}-${i}`} className="relative flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-2 ps-5">
                    <span className={`absolute -start-[4px] top-[15px] size-[7px] rounded-[2px] ${item.source === "record" ? "bg-ink" : "bg-accent"}`} aria-hidden />
                    <span className="t-id w-[136px] shrink-0 text-ink-3">{stamp(item.at)}</span>
                    <span className="text-14 text-ink">{EVENT_LABEL[item.name] ?? item.name.replace(/_/g, " ")}</span>
                    <span className="min-w-0 truncate text-13 text-ink-3">{describe(item)}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-14 text-ink-3">nothing recorded yet{data.account.optOut ? ": this person opted out of analytics" : ""}.</p>}
          </Section>
        </>
      )}
    </>
  );
}
