// A turn whose sign-in a site refuses in the bot's automated browser (Google's "this browser may not be secure") moves
// to the person's own Chrome (My Chrome) for the rest of the turn. Security: only the person's own request at this
// computer may move, never a guest's, a room's, the Bot API's, a routine's or another bot's; below Full access it
// waits on the same once-per-request card as any use of their computer. The move is recorded on the turn's own
// server-side capability, so nothing an engine sends can choose the profile or session it lands on.
import { settledWithin } from "../auto-vm-claims.ts";
import { YourComputerDeclined } from "../your-computer-consent.ts";

export const MY_CHROME_ASK_WAIT_MS = 45_000;

export const MY_CHROME_MOVED =
  "This turn now works in the person's own Chrome (My Chrome), where they are usually already signed in. Open the sign-in page again with agent_browser_open and carry on; tabs and refs from the bot's browser are not there.";
export const MY_CHROME_WAITING =
  "dusk bot is asking the person whether you may use their own Chrome for this sign-in, and they have not answered yet, so this call was NOT performed. Do not ask in chat: the question is in front of them. Make a browser call again to keep waiting (each waits up to 45 seconds).";
export const MY_CHROME_NOT_THIS_TURN =
  "This turn cannot move to the person's own Chrome (only their own request at this computer can), so finish without this sign-in: use a connected Google app, or tell them in one line that Google blocks sign-in in the bot's browser.";
export const myChromeDeclined = (why: string) => `The person did not let you use their own Chrome (${why}). Finish without this sign-in: use a connected Google app, or tell them in one line what is left for them to do.`;

/** The turn as the switch sees it: its server-side capability, which the move writes to. */
export interface SwitchTurn { botId: string; threadId: string; generation: string; depth: number; browserProfile?: string; browserSession?: string }
type Result = Record<string, unknown> & { content?: unknown[] };

export interface MyChromeSwitchDeps {
  /** The My Chrome profile this computer can use now, or null. */
  profile(): string | null;
  /** The person's own request at this computer: not a guest, a room, the Bot API, a routine or another bot. */
  ownRequest(turn: SwitchTurn): boolean;
  /** Below Full access the person is asked first. */
  asks(turn: SwitchTurn): boolean;
  /** The once-per-request card; resolves on Allow, rejects with YourComputerDeclined on Deny or when the request ends. */
  ask(turn: SwitchTurn, site: string): Promise<void>;
  /** The session the turn's browser calls reach on this profile. */
  session(turn: SwitchTurn, profile: string): Promise<string | null>;
  waitMs?: number;
}

type Pending = { done: Promise<void>; outcome: "waiting" | "allowed" | "declined"; why?: string; profile: string };

export function createMyChromeSwitch(deps: MyChromeSwitchDeps) {
  const pending = new WeakMap<SwitchTurn, Pending>();
  const waitMs = deps.waitMs ?? MY_CHROME_ASK_WAIT_MS;
  const note = (result: Result, text: string): Result => ({ ...result, content: [...(Array.isArray(result.content) ? result.content : []), { type: "text", text }] });

  /** Waits on the person's answer, and moves the turn once they allowed. A line for the bot, or null once moved. */
  async function settle(turn: SwitchTurn, entry: Pending, signal?: AbortSignal): Promise<string | null> {
    if (entry.outcome === "waiting") await settledWithin(entry.done, waitMs, signal);
    if (entry.outcome === "waiting") return MY_CHROME_WAITING;
    pending.delete(turn);
    if (entry.outcome === "declined") return myChromeDeclined(entry.why ?? "they said no");
    const session = await deps.session(turn, entry.profile);
    if (!session) return MY_CHROME_NOT_THIS_TURN;
    turn.browserProfile = entry.profile;
    turn.browserSession = session;
    return null;
  }

  function start(turn: SwitchTurn, profile: string, site: string): Pending {
    const entry: Pending = { done: Promise.resolve(), outcome: "allowed", profile };
    if (deps.asks(turn)) {
      entry.outcome = "waiting";
      entry.done = deps.ask(turn, site).then(() => { entry.outcome = "allowed"; }, (error: unknown) => {
        entry.outcome = "declined";
        entry.why = error instanceof YourComputerDeclined ? error.message : "the question closed";
      });
    }
    pending.set(turn, entry);
    return entry;
  }

  return {
    /** Before a browser call: while the person is asked, the call waits; an answer moves the turn or tells the bot. */
    async before(turn: SwitchTurn, signal?: AbortSignal): Promise<string | null> {
      const entry = pending.get(turn);
      if (!entry) return null;
      const said = await settle(turn, entry, signal);
      return said && said !== MY_CHROME_WAITING ? `${said} This call was NOT performed.` : said;
    },
    /** After a call whose page refused the sign-in (the runtime's signInRefused flag): starts the move. */
    async after(turn: SwitchTurn, result: unknown, site = "google.com", signal?: AbortSignal): Promise<unknown> {
      if (!result || typeof result !== "object" || !("signInRefused" in result)) return result;
      const { signInRefused: _flag, ...rest } = result as Result;
      if (turn.browserProfile || pending.has(turn)) return rest;
      const profile = deps.profile();
      if (!profile) return rest;
      if (turn.depth > 0 || !deps.ownRequest(turn)) return note(rest, MY_CHROME_NOT_THIS_TURN);
      const said = await settle(turn, start(turn, profile, site), signal);
      return note(rest, said ?? MY_CHROME_MOVED);
    },
  };
}
