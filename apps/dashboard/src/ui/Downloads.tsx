import { Download } from "@/icons";
import android from "../art/os/android.svg";
import apple from "../art/os/apple.svg";
import linux from "../art/os/linux.svg";
import windows from "../art/os/windows.svg";
import { track } from "../lib/analytics";
import { detectOs, useReleaseState, WAITLIST_URL, type Platform } from "../lib/downloads";
import { siteUrl } from "../lib/site";
import releases from "../../../site/releases.json";
import { Skeleton } from "./kit";

// os marks: gilbarbara/logos, cc0 1.0
const LOGO: Record<Platform, string> = { macos: apple, windows, linux, android, ios: apple };
const NAME: Record<Platform, string> = { macos: "macos", windows: "windows", linux: "linux", android: "android", ios: "ios" };

function Mark({ platform }: { platform: Platform }) {
  const src = LOGO[platform];
  // apple's mark is one colour, so it takes the ink and stays visible in both themes
  if (src === apple) return <span aria-hidden className="block size-[22px] bg-ink" style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }} />;
  return <img src={src} alt="" width={22} height={22} className="size-[22px] object-contain" draggable={false} />;
}

const files: Record<string, string | undefined> = releases.files;
const sizes: Record<string, number | undefined> = releases.sizes;
const file = (key: string) => { const f = files[key]; return f ? (f.startsWith("https://") ? f : releases.base + f) : null; };
const mb = (key: string) => (sizes[key] ? `${Math.round(sizes[key]! / 1e6)} mb` : "");

// the file itself, so a press downloads right here instead of opening another page
const DIRECT: Partial<Record<Platform, { href: string | null; also?: { label: string; href: string | null } }>> = {
  macos: { href: file("mac-arm64"), also: { label: "intel mac", href: file("mac-x64") } },
  windows: { href: file("windows") },
  linux: { href: file("linux-appimage"), also: { label: ".deb", href: file("linux-deb") } },
};
const NOTE_DIRECT: Partial<Record<Platform, string>> = { macos: "apple silicon", windows: "windows 10 and 11", linux: "appimage" };
const PHONES: { p: "ios" | "android"; href: string | null; note: string; store: boolean }[] = [
  { p: "ios", href: releases.ios || null, note: "iphone", store: true },
  { p: "android", href: releases.android || file("android"), note: releases.android ? "google play" : [".apk", mb("android")].filter(Boolean).join(" · "), store: Boolean(releases.android) },
];

const BUTTON = "inline-flex shrink-0 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-14 text-pop transition-opacity hover:opacity-90";

/** the visitor's own computer, downloading in place, then the phone apps, then every other platform on the site */
export function Downloads() {
  const release = useReleaseState();
  const detected = detectOs();
  const desktops: Platform[] = detected === "macos" || detected === "windows" || detected === "linux" ? [detected] : ["macos", "windows", "linux"];
  const clicked = (p: Platform) => track({ name: "download_click", props: { platform: p, detected_os: detected } });
  return (
    <div>
      <ul className="flex flex-col gap-1.5" aria-label="downloads">
        {desktops.map((p) => {
          const direct = DIRECT[p]!;
          const soon = release === "soon" || !direct.href;
          return (
            <li key={p} className="flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-15 font-medium text-ink">{NAME[p]}</span>
                <span className="block truncate text-13 text-ink-3">
                  {NOTE_DIRECT[p]}
                  {direct.also?.href && !soon && <> · <a href={direct.also.href} download className="underline-offset-2 hover:text-ink hover:underline" onClick={() => clicked(p)}>{direct.also.label}</a></>}
                </span>
              </span>
              {release === null
                ? <Skeleton className="h-5 w-20" />
                : <a href={soon ? WAITLIST_URL : direct.href!} {...(soon ? { target: "_blank", rel: "noreferrer" } : { download: "" })} onClick={() => clicked(p)} className={BUTTON}>
                    {soon ? "join waitlist" : <><Download size={15} strokeWidth={1.75} aria-hidden />download</>}
                  </a>}
            </li>
          );
        })}
        {PHONES.map(({ p, href, note, store }) => (
          <li key={p} aria-disabled={href ? undefined : "true"} className={`flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5${href ? "" : " opacity-50"}`}>
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-15 font-medium text-ink">{NAME[p]}</span>
              {href && <span className="block truncate text-13 text-ink-3">{note}</span>}
            </span>
            {!href
              ? <span className="shrink-0 text-14 text-ink-3">coming soon</span>
              : <a href={href} {...(store ? { target: "_blank", rel: "noreferrer" } : { download: "" })} onClick={() => clicked(p)} className={BUTTON}>
                  {store ? (p === "ios" ? "app store" : "google play") : <><Download size={15} strokeWidth={1.75} aria-hidden />download</>}
                </a>}
          </li>
        ))}
      </ul>
      <a href={siteUrl("/download")} className="text-link mt-2 inline-flex min-h-11 items-center px-1 text-14">other platforms</a>
    </div>
  );
}
