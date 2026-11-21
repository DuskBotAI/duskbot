import type { ReactNode } from "react";
import type { TableCell, TableColumn } from "@/components/RichTable";

export type PhoneHaptic = "light" | "soft" | "medium" | "selection" | "error" | "success";

export interface PhoneImage {
  src: string;
  name: string;
  /** the picture's own address on the web, when it has one */
  openUrl?: string;
}

/** What the phone shows full screen in place of the desktop's dialogs. */
export type PhoneView =
  | { kind: "code"; code: string; lang: string }
  | { kind: "images"; images: PhoneImage[]; index: number }
  | { kind: "text"; text: string }
  | { kind: "table"; columns: TableColumn[]; rows: TableCell[][]; name: string; direction?: "rtl" | "ltr" }
  | { kind: "page"; title: string; body: ReactNode; actions?: ReactNode };

/** The phone shell's answers to what a shared chat component asks of the device. Registered by the phone app only, so
 * on the desktop and the web every caller keeps its own behaviour. */
export interface PhoneBridge {
  haptic(kind: PhoneHaptic): void;
  /** a web page in the in-app browser sheet */
  openLink(url: string): void;
  /** the system share sheet; absent where the device has none */
  share?(data: { title?: string; text?: string; url?: string }): Promise<void>;
  /** the system share sheet with a file, which offers Save Image and Save to Files; absent where the web view can't */
  shareFile?(file: File): Promise<void>;
  /** opens `view` full screen; `onClose` runs once it is gone */
  view(view: PhoneView, onClose?: () => void): void;
}

let bridge: PhoneBridge | null = null;

export function setPhoneBridge(next: PhoneBridge): () => void {
  bridge = next;
  return () => { if (bridge === next) bridge = null; };
}

export function phoneBridge(): PhoneBridge | null {
  return bridge;
}

/** Web Share with files, where the web view has it (iOS WebKit does; Android's WebView has no Web Share). */
export function webFileShare(): ((file: File) => Promise<void>) | undefined {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return undefined;
  try {
    if (!navigator.canShare({ files: [new File([""], "probe.txt", { type: "text/plain" })] })) return undefined;
  } catch {
    return undefined;
  }
  return async (file) => {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") throw error;
    }
  };
}
