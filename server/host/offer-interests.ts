// What the person is working toward, kept as one memory topic of the proactive bot (memory/interests.md) so they can read
// and edit it under What it remembers. One undated line each: memory upkeep never touches undated lines.
//   - Job hunting: product design roles in Lisbon · weight 1.5 · since 2026-11-20 · id job-hunting-lisbon
//   - Moving to Porto · stopped · since 2026-10-02 · id moving-porto
// A line typed by hand with none of the marks counts too, at weight 1.

export const INTERESTS_TOPIC = "interests.md";
export const MAX_INTERESTS = 8;
export const WEIGHT = { start: 1, min: 0.2, max: 3, took: 0.5, skipped: 0.3, lapsed: 0.15 } as const;
const TITLE_CHARS = 140;
const HEADER = [
  "---",
  "title: What you're working toward",
  "description: Ongoing goals dusk bot looks out for. Edit a line to change what it looks for, or delete it.",
  "aliases: goals, plans, job hunting, looking for, working toward",
  "---",
  "",
];

export interface Interest {
  id: string;
  title: string;
  weight: number;
  since: string;
  /** Don't suggest this: never looked at again, and never added back. */
  stopped: boolean;
}

const LINE = /^\s*[-*]\s+(.+?)\s*$/;
const MARK = / · (weight (\d+(?:\.\d+)?)|stopped|since (\d{4}-\d{2}-\d{2})|id ([a-z0-9][a-z0-9-]{0,47}))(?= · |$)/g;

export function interestId(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug || "interest";
}

export function cleanTitle(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\r\n·]+/g, " ").replace(/\s+/g, " ").replace(/^[-*\s]+/, "").trim().slice(0, TITLE_CHARS) : "";
}

const clampWeight = (value: number): number => Math.round(Math.min(WEIGHT.max, Math.max(WEIGHT.min, value)) * 100) / 100;

export function parseInterests(text: string | null, today: string): Interest[] {
  if (!text) return [];
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out: Interest[] = [];
  for (const raw of body.split("\n")) {
    const line = LINE.exec(raw)?.[1];
    if (!line || line.startsWith("~~") || /^\d{4}-\d{2}-\d{2} · /.test(line)) continue;
    let weight: number = WEIGHT.start, stopped = false, since = today, id = "";
    for (const mark of line.matchAll(MARK)) {
      if (mark[2]) weight = clampWeight(Number(mark[2]));
      else if (mark[1] === "stopped") stopped = true;
      else if (mark[3]) since = mark[3];
      else if (mark[4]) id = mark[4];
    }
    const title = cleanTitle(line.replace(MARK, ""));
    if (!title) continue;
    id ||= interestId(title);
    if (out.some((one) => one.id === id)) continue;
    out.push({ id, title, weight, since, stopped });
  }
  return out;
}

export function renderInterests(interests: readonly Interest[]): string {
  const lines = interests.map((one) => `- ${one.title}${one.stopped ? " · stopped" : ` · weight ${clampWeight(one.weight)}`} · since ${one.since} · id ${one.id}`);
  return `${[...HEADER, ...lines].join("\n")}\n`;
}

export type Learned = "took" | "skipped" | "lapsed" | "stopped";

/** Do it raises an interest, Not now and an offer left unanswered lower it, and Don't suggest this stops it for good. */
export function learn(interests: readonly Interest[], id: string, outcome: Learned): Interest[] {
  return interests.map((one) => {
    if (one.id !== id) return one;
    if (outcome === "stopped") return { ...one, stopped: true };
    const step = outcome === "took" ? WEIGHT.took : -(outcome === "skipped" ? WEIGHT.skipped : WEIGHT.lapsed);
    return { ...one, weight: clampWeight(one.weight + step) };
  });
}

/** New interests from a spot join at the starting weight; a title that matches a stopped one never comes back. Ended ones
 * leave. Live ones beyond the cap drop, lowest weight first. */
export function mergeSpotted(current: readonly Interest[], spotted: readonly { id?: string; title: string; ended?: boolean }[], today: string): Interest[] {
  let next = [...current];
  for (const item of spotted) {
    const id = item.id && next.some((one) => one.id === item.id) ? item.id : interestId(item.title);
    const same = next.find((one) => one.id === id || one.title.toLowerCase() === item.title.toLowerCase());
    if (item.ended) {
      if (same && !same.stopped) next = next.filter((one) => one !== same);
      continue;
    }
    if (same) {
      if (!same.stopped && item.title && item.title !== same.title) next = next.map((one) => (one === same ? { ...one, title: item.title } : one));
      continue;
    }
    next.push({ id, title: item.title, weight: WEIGHT.start, since: today, stopped: false });
  }
  const live = next.filter((one) => !one.stopped).sort((a, b) => b.weight - a.weight);
  const dropped = new Set(live.slice(MAX_INTERESTS).map((one) => one.id));
  return next.filter((one) => !dropped.has(one.id));
}
