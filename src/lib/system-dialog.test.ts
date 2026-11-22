// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askConfirm, ConfirmDialog } from "@/components/ConfirmDialog";
import { FormDialog } from "@/components/ListRows";
import { confirmWithSystem, installSystemDialogs, plainDialogText, type SystemDialogs } from "@/lib/system-dialog";
import { PlatformContext, webPlatform, type BarConfig, type MobileChrome } from "@/mobile/platform";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  installSystemDialogs(null);
});

afterEach(() => {
  installSystemDialogs(null);
  act(() => root.unmount());
  host.remove();
});

describe("plainDialogText", () => {
  it("extracts plain copy from strings, fragments, and inline formatting", () => {
    expect(plainDialogText("Delete this?")).toBe("Delete this?");
    expect(plainDialogText(createElement("span", null, "Remove ", createElement("strong", null, "Micro"), "?"))).toBe("Remove Micro?");
    expect(plainDialogText(createElement("p", null, "First line."))).toBe("First line.\n");
  });

  it("returns null for interactive or custom layout markup", () => {
    expect(plainDialogText(createElement("button", null, "Learn more"))).toBeNull();
    expect(plainDialogText(createElement("div", null, "Box"))).toBeNull();
  });
});

describe("confirmWithSystem", () => {
  it("delegates to native alert when systemDialogs is installed", async () => {
    const alert = vi.fn<SystemDialogs["alert"]>(async () => "confirm");
    installSystemDialogs({ alert, form: vi.fn() });

    const ok = await confirmWithSystem("Remove skill?", "Delete", { cancelLabel: "Cancel" });
    expect(ok).toBe(true);
    expect(alert).toHaveBeenCalledWith({
      title: "Remove skill?",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      tone: "danger",
    });
  });

  it("falls back to window.confirm when no native dialogs are installed", async () => {
    const before = window.confirm;
    const spy = vi.fn(() => false);
    window.confirm = spy;
    try {
      expect(await confirmWithSystem("Proceed?", "OK")).toBe(false);
      expect(spy).toHaveBeenCalledWith("Proceed?");
    } finally {
      window.confirm = before;
    }
  });
});

describe("ConfirmDialog and askConfirm with native dialogs", () => {
  it("presents a native UIAlertController for ConfirmDialog and renders no web modal DOM", async () => {
    const alert = vi.fn<SystemDialogs["alert"]>(async () => "confirm");
    installSystemDialogs({ alert, form: vi.fn() });
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(createElement(ConfirmDialog, {
        open: true,
        title: "Delete bot?",
        body: "All history will be removed.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        tone: "danger",
        onConfirm,
        onCancel,
      }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector("[role=alertdialog]")).toBeNull();
    expect(alert).toHaveBeenCalledWith({
      title: "Delete bot?",
      message: "All history will be removed.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      alternativeLabel: undefined,
      tone: "danger",
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("routes alternative action from native alert", async () => {
    const alert = vi.fn<SystemDialogs["alert"]>(async () => "alternative");
    installSystemDialogs({ alert, form: vi.fn() });
    const onAlternative = vi.fn();
    const onConfirm = vi.fn();

    await act(async () => {
      root.render(createElement(ConfirmDialog, {
        open: true,
        title: "Move bot?",
        body: "Choose what happens to files.",
        confirmLabel: "Move",
        alternative: { label: "Keep copy", onClick: onAlternative },
        onConfirm,
        onCancel: vi.fn(),
      }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(onAlternative).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses native alert for imperative askConfirm", async () => {
    const alert = vi.fn<SystemDialogs["alert"]>(async () => "cancel");
    installSystemDialogs({ alert, form: vi.fn() });

    const confirmed = await askConfirm({
      title: "Reset memory?",
      body: "This cannot be undone.",
      confirmLabel: "Reset",
    });

    expect(confirmed).toBe(false);
    expect(alert).toHaveBeenCalledWith({
      title: "Reset memory?",
      message: "This cannot be undone.",
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
      tone: "danger",
    });
  });
});

describe("FormDialog with native SwiftUI form", () => {
  it("delegates to native form, passes saved values to onSaved, and renders no web dialog DOM", async () => {
    const form = vi.fn<SystemDialogs["form"]>(async () => ({
      saved: true,
      values: { name: "Nova", title: "Lead Agent" },
    }));
    const dismissForm = vi.fn();
    installSystemDialogs({ alert: vi.fn(), form, dismissForm });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(createElement(FormDialog, {
        title: "Profile",
        onSave: vi.fn(),
        onClose,
        nativeForm: {
          fields: [
            { id: "name", label: "Name", value: "Micro", required: true, autoFocus: true },
            { id: "title", label: "Title", value: "Main Agent" },
          ],
          onSaved,
        },
        children: createElement("div", null, "Web fallback"),
      }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(form).toHaveBeenCalledWith(expect.objectContaining({
      title: "Profile",
      fields: [
        { id: "name", label: "Name", value: "Micro", required: true, autoFocus: true },
        { id: "title", label: "Title", value: "Main Agent" },
      ],
    }));
    expect(onSaved).toHaveBeenCalledWith({ name: "Nova", title: "Lead Agent" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("upgrades non-native FormDialog into a native sheet bar on iOS when chrome is active", async () => {
    const presentSheet = vi.fn(async () => {});
    const dismissSheet = vi.fn(async () => {});
    const bars: (BarConfig | null)[] = [];
    const chrome: MobileChrome = {
      setBar: (config) => { bars.push(config); },
      onBarPress: () => () => {},
      onPictureTaken: () => () => {},
      freeze: async () => {},
      thaw: async () => {},
      presentSheet,
      resizeSheet: () => {},
      dismissSheet,
      onSheetDismissed: () => () => {},
    };
    const platform = { ...webPlatform(), native: true, kind: "ios" as const, chrome };
    const onSave = vi.fn();
    const onClose = vi.fn();
    document.documentElement.dataset.mobileApp = "ios";
    try {
      await act(async () => {
        root.render(
          createElement(
            PlatformContext.Provider,
            { value: platform },
            createElement(FormDialog, {
              title: "Custom Dialog",
              saveLabel: "Apply",
              canSave: true,
              onSave,
              onClose,
              children: createElement("input", { "aria-label": "Custom" }),
            }),
          ),
        );
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(presentSheet).toHaveBeenCalled();
      expect(bars.some((bar) => bar?.title === "Custom Dialog" && bar.trailing.some((item) => item.label === "Apply" && item.role === "confirm"))).toBe(true);
    } finally {
      delete document.documentElement.dataset.mobileApp;
    }
  });
});
