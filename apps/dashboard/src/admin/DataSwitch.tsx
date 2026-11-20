import { cx } from "../ui/kit";
import { adminData, adminMoney, adminTests, setAdminData } from "./api";

/** whose analytics the pages show: the live site's (read only) or this service's own; people, clouds and revenue stay this service's */
export function DataSwitch({ live }: { live: string }) {
  const current = adminData();
  const pick = (value: "live" | "own") => { if (value === current) return; setAdminData(value); location.reload(); };
  return (
    <div role="radiogroup" aria-label="analytics from" className="mb-1 flex w-fit gap-0.5 rounded-full bg-card p-0.5 text-12" title="the analytics pages read this site; people, clouds and revenue are always this service's">
      {([["live", live], ["own", "preview"]] as const).map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={current === value} onClick={() => pick(value)}
          className={cx("h-7 rounded-full px-2.5 transition-colors duration-150 ease-out", current === value ? "bg-bg text-ink" : "text-ink-3 hover:text-ink-2")}>{label}</button>
      ))}
    </div>
  );
}

/** a plain line over every page when it isn't production's data, so staging numbers are never read as real */
export function StagingTag({ environment, live }: { environment: string; live: string | null | undefined }) {
  if (environment === "production") return null;
  const money = adminMoney();
  const analytics = live && adminData() === "live" ? `visits from ${live}; ` : "";
  return (
    <p className="mb-5 flex flex-wrap items-center gap-2 text-12 text-ink-3">
      <span className="inline-flex h-[22px] items-center rounded-full bg-wash-lemon px-2 text-ink">{environment === "preview" ? "staging data" : `${environment} data`}</span>
      <span>{analytics}people, money and clouds from {environment === "preview" ? "preview" : "this service"}, counting {money === "all" ? "live and test money" : `${money} money only`}{money !== "test" && !adminTests() ? ", test accounts left out" : ""}.</span>
    </p>
  );
}
