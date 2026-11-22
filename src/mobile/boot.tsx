import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { productName } from "@/lib/brand";
import { loadPageLanguage } from "@/lib/language-preference";
import { applySkinChoice, readSkinChoice, THEME_SKINS, type SkinChoice } from "@/lib/skins";
import { applyFont, readFont } from "@/lib/fonts";
import { applyMotionSpeed } from "@/lib/motion-speed";
import { PageBoundary } from "@/components/PageBoundary";
import { watchStaleChunks } from "@/lib/stale-chunks";
import "./styles.css";
import "@/styles/overlays.css";
import "@/styles/motion.css";
import "./mobile.css";
import "./glass.css";
import { installHaptics } from "./haptics";
import { installLiveActivitySetting } from "./live-activity-setting";
import { installSystemMenu } from "@/lib/system-menu";
import { installSystemControls } from "@/lib/system-control";
import { installSystemDialogs } from "@/lib/system-dialog";
import { phoneControlCover } from "./control-cover";
import { followSystemTextSize } from "./text-scale";
import { PlatformContext, type MobilePlatform } from "./platform";
import { AccountGate } from "./account/AccountGate";
import { claimFreshInstall } from "./account/install";
import { moveLegacyStorage } from "./legacy-storage";
import { ConnectionGate } from "./connection/ConnectionGate";
import { MobileApp } from "./MobileApp";
import { installNativeAbort } from "./transport/native-abort";

const PHONE_SKINS: readonly SkinChoice[] = ["system", THEME_SKINS.light, THEME_SKINS.dark];

/** The phone keeps to the two default looks; a desktop skin picked in a shared browser profile falls back to the system's. */
function phoneSkin(params: URLSearchParams): SkinChoice {
  const asked = params.get("scheme");
  if (asked === "dark") return THEME_SKINS.dark;
  if (asked === "light") return THEME_SKINS.light;
  const stored = readSkinChoice();
  return PHONE_SKINS.includes(stored) ? stored : "system";
}

export function mountMobile(platform: MobilePlatform): void {
  // the preview page's switches (?frame, ?scheme, ?pair) are for the browser preview: the installed app reads none of them
  const params = new URLSearchParams(platform.native ? "" : location.search);
  if (params.has("frame")) document.documentElement.dataset.phoneFrame = "";
  // the phone page in a browser loads parts of itself later; after a deploy one quiet reload fetches the new ones
  if (!platform.native) watchStaleChunks();
  else installNativeAbort();
  followSystemTextSize(platform);
  if (platform.chrome) document.documentElement.dataset.nativeChrome = "";
  installSystemControls(platform.controls ?? null, phoneControlCover);
  installSystemDialogs(platform.dialogs ?? null);
  const showMenu = platform.showMenu;
  if (showMenu) installSystemMenu((anchor, items) => showMenu({ x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height }, items));
  document.documentElement.dataset.mobileApp = platform.kind;
  // the app never zooms: webkit's pinch gestures are stopped, a double tap never scales
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  if (platform.kind === "ios" || params.has("frame")) document.documentElement.dataset.mobileGlass = "";
  applySkinChoice(phoneSkin(params));
  applyFont(readFont());
  applyMotionSpeed(document.documentElement);
  const dark = document.documentElement.dataset.skin === THEME_SKINS.dark;
  platform.setStatusBar?.(dark ? "light" : "dark");
  document.title = productName();
  // the install is claimed before anything this launch writes a preference, which would make a new install look like an
  // update; what an earlier build kept under its old names moves before anything reads it
  const storage = platform.native ? claimFreshInstall(platform).then(() => moveLegacyStorage(platform)).catch(() => {}) : null;
  void Promise.all([storage, loadPageLanguage(), installHaptics(platform), installLiveActivitySetting(platform)]).then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <PageBoundary>
          <PlatformContext value={platform}>
            <AccountGate>
              <ConnectionGate forcePair={params.has("pair")}>
                <MobileApp />
              </ConnectionGate>
            </AccountGate>
          </PlatformContext>
        </PageBoundary>
      </StrictMode>,
    );
  });
}
