import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { applySkin, type SkinId } from "../../src/lib/skins";
import { SIDEBAR_DENSITY_KEY } from "../../src/lib/sidebar-preferences";
import "../../src/styles.css";

// Served only by scripts/verify-sidebar-motion.ts: the real app against its disposable fixture. ?skin= the skin,
// ?rail=1 opens the sidebar as its column of avatars.
const params = new URLSearchParams(location.search);
setEmailGateDone("skipped");
localStorage.setItem(GROK_MOVE_NOTICE, "1");
localStorage.setItem(SIDEBAR_DENSITY_KEY, params.get("rail") === "1" ? "avatars" : "comfortable");
applySkin((params.get("skin") ?? "daylight") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
