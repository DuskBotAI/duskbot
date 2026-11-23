// The whole app as the desktop app's own window shows it, for "Move from Grok Bot" (scripts/verify-grok-move-ui.ts): the
// bridge says this is the computer's own server, and its openExternal only records what it was asked to open. Grok Bot
// is installed where these run, so a grokbot:// link must never really open. ?skin= picks a skin.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { applySkinChoice, readSkinChoice, type SkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

const opened: string[] = [];
Object.assign(window, { grokOpened: opened });
window.duskDesktop = {
  platform: "darwin",
  remoteClient: { active: false },
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
  openExternal: async (url: string) => { opened.push(url); return true; },
} as unknown as typeof window.duskDesktop;
setEmailGateDone("skipped");
localStorage.setItem(GROK_MOVE_NOTICE, "1");
// the one-time move to the default skin (skins.ts) has happened, so ?skin= holds
localStorage.setItem("dusk-skin-grok", "1");
const skin = new URLSearchParams(location.search).get("skin");
applySkinChoice((skin as SkinChoice | null) ?? readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
