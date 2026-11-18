import { cn } from "@/lib/cn";
import "./panel-phone.css";

export const BOT_PANEL_ID = "bot-panel";

export const sidePanelCls = (overlay: boolean) => cn(
  "absolute inset-0 z-40 flex h-full min-w-0 flex-col outline-none focus-visible:outline-none",
  // the docked panel draws its own 0.5px edge above its content (PanelShell), unbroken by the sticky tabs
  "bg-app",
  // on a phone the panel is its own full-screen sheet: Grok's grey page under stacks of white segments, no edge
  "side-panel max-md:border-l-0",
  overlay
    ? "md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[var(--side-panel-w,320px)]"
    : "md:relative md:z-auto md:shrink-0 md:w-[var(--side-panel-w,320px)]",
);
