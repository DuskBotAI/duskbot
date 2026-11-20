import { Check, X } from "../../icons";
import { cn } from "@/lib/cn";

/** The short pill a viewer shows after an action lands ("Copied", "Saved"), over its foot. */
export function ViewerNote({ show, text, failed = false, dark = false }: { show: boolean; text: string; failed?: boolean; dark?: boolean }) {
  return (
    <div role={failed ? "alert" : "status"} aria-live="polite"
      className={cn("viewer-note pointer-events-none fixed inset-x-0 bottom-[calc(var(--m-safe-bottom)+24px)] z-10 flex justify-center", show ? "viewer-note-in" : "viewer-note-out")}>
      {show && <span className={cn("flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium shadow-[0_4px_16px_rgb(0_0_0/0.16)]",
        dark ? "bg-[rgb(245_245_245/0.16)] text-[rgb(245_245_245)]" : "bg-ink text-app")}>
        {failed ? <X size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{text}
      </span>}
    </div>
  );
}
