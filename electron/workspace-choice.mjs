// Which workspace the window shows is the person's choice. Only three things move it: their own choice (a click in the
// rail, the Server menu, a dialog they answered), a join they confirmed (a server added, a Cloud bought or moved to),
// or the chosen entry leaving the list. A server that stops answering, a restart, a sign-in screen or a link never do.
import environments from "./environments.cjs";

/** Why a write may change the active workspace. `gone`: the place the window showed ended or left the person's list
 * by the Admin's word, though its entry may still be listed; `unusable`: a local data folder this launch could not start on. */
export const CHOSEN = "chosen";
export const JOINED = "joined";
export const GONE = "gone";
export const UNUSABLE = "unusable";
const ALLOWED = new Set([CHOSEN, JOINED, GONE, UNUSABLE]);

/** The workspace `next` may show after `before`: its own choice when `why` allows it or the chosen entry is gone from
 * `next`, else the one chosen before. Returns `next` itself when nothing is held back. */
export function settledActive(before, next, why = null) {
  if (!before || !next || next.activeId === before.activeId || ALLOWED.has(why)) return next;
  const kept = before.activeId === environments.LOCAL_ID || next.environments.some((entry) => entry.id === before.activeId);
  return kept ? { ...next, activeId: before.activeId } : next;
}

/** What showing this computer's page does to the window. `stay`: it isn't `leaving` a place. `open`: a window with no
 * page yet (re-created after it was closed) while a server is chosen, which opens that server and never moves the
 * choice. `switch`: back to this computer's page, which becomes the chosen workspace. */
export function localPageStep({ leaving, url, serverChosen }) {
  if (!leaving) return "stay";
  return !url && serverChosen ? "open" : "switch";
}
