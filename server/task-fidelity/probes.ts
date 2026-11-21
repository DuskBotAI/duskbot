// What a case needs the prompt and tool descriptions to tell the model, checked with no model in the loop.
import type { Case } from "./cases.ts";
import { worldPrompt, worldTools } from "./world.ts";

export interface Probe { id: string; applies(c: Case): boolean; test: RegExp; where: "prompt" | "slack_dm" | "slack_post" }

const outward = (c: Case) => c.expect.destination !== "none" && c.expect.destination !== "any";

export const PROBES: Probe[] = [
  { id: "destination-from-words", applies: outward, where: "prompt", test: /channel[^.]*\b(DM|direct message)\b[^.]*(never|not)\b|\b(never|not)\b[^.]*\b(DM|direct message)\b[^.]*channel|\b(never|not)\b[^.]*channel[^.]*\b(DM|direct message)\b/i },
  { id: "ask-when-open", applies: (c) => c.expect.ask === true, where: "prompt", test: /\b(unclear|open|ambiguous)\b[^.]*\bask\b[^.]*\bone\b[^.]*question|\bask\b[^.]*\bone\b[^.]*question[^.]*\b(which|who|where)\b/i },
  { id: "draft-before-send", applies: (c) => c.expect.draft === true, where: "prompt", test: /\b(show|share)\b[^.]*\bdraft\b[^.]*\b(before|then)\b[^.]*\b(send|post)/i },
  { id: "connected-app-first", applies: (c) => c.expect.tool.includes("connector") && (c.world.browser || !!c.world.computer), where: "prompt", test: /connected app[^.]*before any browser or screen/i },
  { id: "browser-before-screen", applies: (c) => c.expect.tool.includes("browser") && !!c.world.computer, where: "prompt", test: /\b(web apps?|website)[^.]*\bbrowser\b[^.]*\bbefore\b[^.]*\b(screen|desktop app)/i },
  { id: "no-file-hunting", applies: (c) => !c.expect.files && !!c.world.computer, where: "prompt", test: /\b(do not|never)\b[^.]*\bsearch\b[^.]*\b(computer|files|folders|disk)\b[^.]*\b(unless|only when)\b/i },
  { id: "dm-tool-only-for-a-person", applies: (c) => c.world.slack === "bridge" && outward(c), where: "slack_dm", test: /\bonly\b[^.]*\b(asked|named)\b/i },
  { id: "post-tool-for-teams", applies: (c) => c.world.slack === "bridge" && outward(c), where: "slack_post", test: /\b(team|channel)\b[^.]*\bupdate|\bupdate\b[^.]*\b(team|channel)\b/i },
];

export interface ProbeResult { caseId: string; probes: Array<{ id: string; pass: boolean }>; pass: boolean }

export function probeCase(c: Case): ProbeResult {
  const prompt = worldPrompt(c.world);
  const tools = worldTools(c.world);
  const text = (where: Probe["where"]) => where === "prompt" ? prompt : tools.find((t) => t.name === where)?.description ?? "";
  const probes = PROBES.filter((p) => p.applies(c)).map((p) => ({ id: p.id, pass: p.test.test(text(p.where)) }));
  return { caseId: c.id, probes, pass: probes.every((p) => p.pass) };
}
