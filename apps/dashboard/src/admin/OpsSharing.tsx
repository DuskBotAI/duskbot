import { useAdmin } from "./api";
import { percent } from "./kit";
import { Empty, Panel } from "./Ops";
import type { OpsSharingAnswer, OpsSharingWindow } from "./ops-types";
import { Failed, Loading, PartialNote, n } from "./ui";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-[14px] px-2.5 py-2">
      <div className="t-meta">{label}</div>
      <div className="num mt-0.5 text-20 font-medium text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-12 leading-4 text-ink-3">{sub}</div>}
    </div>
  );
}

const placeLine = (w: OpsSharingWindow) => `settings ${n(w.byPlace.settings.enables)} on, ${n(w.byPlace.settings.disables)} off · first run ${n(w.byPlace.first_run.enables)} on, ${n(w.byPlace.first_run.disables)} off`;

/** the desktop app's "share anonymous usage statistics" switch: who has it on now, and how often it moved */
export function OpsSharing() {
  const { data, error, loading, reload } = useAdmin<OpsSharingAnswer>("/ops/sharing", 5 * 60_000);
  const week = data?.windows.find((w) => w.days === 7), month = data?.windows.find((w) => w.days === 30);
  return (
    <Panel id="ops-sharing" title="usage sharing" meta="desktop app, per install">
      {error && !data ? <Failed error={error} retry={reload} /> : !data ? (loading ? <Loading rows={1} /> : null) : data.optedIn + data.optedOut === 0 && !month?.enables && !month?.disables ? <Empty>no installs have reported yet.</Empty> : (
        <div className="grid grid-cols-4 gap-1 max-md:grid-cols-2">
          {data.partialBefore ? <div className="col-span-full"><PartialNote before={data.partialBefore} /></div> : null}
          <Stat label="sharing now" value={n(data.optedIn)} sub="active in the last 30 days" />
          <Stat label="opted out" value={n(data.optedOut)} sub={data.outShare === null ? undefined : `${percent(data.outShare)} of installs`} />
          {week && <Stat label="last 7 days" value={`${n(week.enables)} on · ${n(week.disables)} off`} sub={placeLine(week)} />}
          {month && <Stat label="last 30 days" value={`${n(month.enables)} on · ${n(month.disables)} off`} sub={placeLine(month)} />}
        </div>
      )}
    </Panel>
  );
}
