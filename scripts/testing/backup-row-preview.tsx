import { createRoot } from "react-dom/client";
import { ChatNotice } from "../../src/components/ChatErrorBanner";
import { ModelCard } from "../../src/components/bot-panel/DetailsTab";
import { SettingsPage } from "../../src/components/bot-panel/SettingsPage";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, type SkinId } from "../../src/lib/skins";
import { StoreProvider, useStore } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";

// Served only by scripts/verify-backup-row.ts: the bot's Model card on Details, its Advanced settings with the Backup AI
// switch, and the note a send with no AI connected gets. ?view=details|advanced|note, ?skin=.
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "details";
setEmailGateDone("skipped");
applySkin((params.get("skin") ?? "daylight") as SkinId);

function Preview() {
  const { state } = useStore();
  const bot = state.bots[0];
  if (!bot) return null;
  return (
    <main className={`m-6 flex flex-col gap-6 rounded-2xl bg-panel p-4 ${view === "note" ? "w-[600px]" : "w-[380px]"}`} data-preview-ready="">
      {view === "note"
        ? <ChatNotice notice={{ kind: "note", botName: null, text: "Connect an AI first, so bots can answer.", connect: true }} />
        : view === "advanced" ? <SettingsPage bot={bot} onOpen={() => {}} /> : <ModelCard bot={bot} />}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
