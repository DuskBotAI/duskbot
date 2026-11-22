import { isValidElement, type ReactNode } from "react";

export interface SystemAlertOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  alternativeLabel?: string;
  tone?: "danger" | "neutral";
  singleAction?: boolean;
  style?: "alert" | "actionSheet";
}

export type SystemAlertOutcome = "confirm" | "alternative" | "cancel";

export interface SystemFormField {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  kind?: "text" | "multiline" | "number" | "password" | "url";
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  monospaced?: boolean;
  autoFocus?: boolean;
  hint?: string;
}

export interface SystemFormOptions {
  title: string;
  description?: string;
  saveLabel?: string;
  cancelLabel?: string;
  /** Require at least one field value to differ from its initial value to enable Save (default true). */
  requireChange?: boolean;
  /** Runs while the native form stays open with a spinner; return an error string to keep it open and display it. */
  onSubmit?: (values: Record<string, string>) => Promise<string | null | undefined> | string | null | undefined;
  fields: SystemFormField[];
}

export type SystemFormResult =
  | { saved: true; values: Record<string, string> }
  | { saved: false };

export interface SystemDialogs {
  alert(options: SystemAlertOptions): Promise<SystemAlertOutcome>;
  form(options: SystemFormOptions): Promise<SystemFormResult>;
  dismissForm?(): void;
}

let installed: SystemDialogs | null = null;

/** The phone app installs its platform's native dialogs here so shared components present UIKit/SwiftUI dialogs. */
export function installSystemDialogs(next: SystemDialogs | null): void {
  installed = next;
}

export function systemDialogs(): SystemDialogs | null {
  return installed;
}

/** Presents a native confirmation alert when available (iOS), falling back to window.confirm elsewhere. */
export async function confirmWithSystem(
  message: string,
  confirmLabel: string,
  options?: { cancelLabel?: string; tone?: "danger" | "neutral" },
): Promise<boolean> {
  if (installed) {
    const outcome = await installed.alert({
      title: message,
      confirmLabel,
      cancelLabel: options?.cancelLabel,
      tone: options?.tone ?? "danger",
    });
    return outcome === "confirm";
  }
  return window.confirm(message);
}

/** Extracts plain text from simple React copy; returns null when the node contains interactive or rich layout markup. */
export function plainDialogText(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const parts: string[] = [];
    for (const child of node) {
      const text = plainDialogText(child);
      if (text === null) return null;
      parts.push(text);
    }
    return parts.join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const type = node.type;
    if (typeof type === "string" && (type === "span" || type === "strong" || type === "em" || type === "code" || type === "p" || type === "b" || type === "i")) {
      const inner = plainDialogText(node.props.children);
      if (inner === null) return null;
      return type === "p" ? `${inner}\n` : inner;
    }
    if (typeof type === "symbol") return plainDialogText(node.props.children);
    return null;
  }
  return null;
}
