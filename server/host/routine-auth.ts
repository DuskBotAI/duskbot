// Which connected apps a routine run found signed out, read from its own chat: the note the connector proxy adds to a
// call that failed for want of a sign-in (connector-signed-out-hint.ts), or a reconnect card the run asked for.
import type { ConnectorCardData } from "../../shared/connector-card.ts";
import type { RoutineRun } from "../routines.ts";
import { RECONNECT_KEY } from "./routine-guard.ts";

const SIGNED_OUT_NOTE = /dusk bot note: ([\w ,.-]{1,200}?) is signed out \(its sign-in expired or was revoked\)/;

export interface RunMessage {
  at: number;
  kind?: string;
  tool?: { output?: string };
  connector?: Pick<ConnectorCardData, "slug" | "status" | "source">;
}

export function signedOutApps(messages: readonly RunMessage[], run: Pick<RoutineRun, "threadId" | "startedAt" | "finishedAt">): string[] {
  if (!run.threadId || run.startedAt === undefined) return [];
  const from = run.startedAt, to = run.finishedAt ?? Number.MAX_SAFE_INTEGER;
  const apps = new Set<string>();
  for (const message of messages) {
    if (message.at < from || message.at > to) continue;
    const note = message.tool?.output ? SIGNED_OUT_NOTE.exec(message.tool.output)?.[1] : undefined;
    for (const slug of note && note !== "The app" ? note.split(/,\s*/) : []) apps.add(slug.trim().toLowerCase());
    const card = message.kind === "connector" ? message.connector : undefined;
    if (card && card.source !== "mcp" && card.status !== "connected") apps.add(card.slug.toLowerCase());
  }
  return [...apps];
}

export const appLabel = (slug: string): string => slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/** The one card that reconnects the app: Connect on it resumes the routine (RECONNECT_KEY). */
export function reconnectCard(routineId: string, slug: string, text: string): { role: "bot"; kind: "connector"; text: string; connector: ConnectorCardData } {
  return {
    role: "bot",
    kind: "connector",
    text,
    connector: { slug, label: appLabel(slug), description: text, status: "required", resumeKey: `${RECONNECT_KEY}${routineId}` },
  };
}
