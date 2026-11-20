import { createRoot } from "react-dom/client";
import { KeyRow } from "../../src/components/keys/KeyRow";
import { OtherOpenAiCompatServers } from "../../src/components/OpenAiCompatServers";
import { setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, type SkinId } from "../../src/lib/skins";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";

// Served only by scripts/verify-key-check.ts: the OpenAI-compatible key field (?view=row) and the form that adds
// another server (?view=server), whose checks it photographs. ?skin=.
const params = new URLSearchParams(location.search);
setEmailGateDone("skipped");
applySkin((params.get("skin") ?? "daylight") as SkinId);

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <main className="m-6 flex w-[440px] flex-col gap-3 rounded-2xl bg-panel p-4" data-preview-ready="">
      {params.get("view") === "server" ? <OtherOpenAiCompatServers /> : <KeyRow id="openaiCompat" />}
    </main>
  </StoreProvider>,
);
