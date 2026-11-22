import { describe, expect, it } from "vitest";
import { macCuaPermissionHelper, macCuaPermissionMessage, macPermissionPaneToOpen, missingMacCuaPermissions } from "./mac-cua-permissions";

describe("macOS CUA permission recovery", () => {
  it("names only the grants the host reported missing", () => {
    expect(missingMacCuaPermissions("embedded host failed: Screen Recording required; restart dusk bot")).toEqual(["screen"]);
    expect(missingMacCuaPermissions("Accessibility and Screen Recording required")).toEqual(["screen", "accessibility"]);
    expect(macCuaPermissionMessage(["accessibility"])).toContain("Accessibility is required for dusk bot");
    expect(macCuaPermissionMessage(["screen"])).toContain("relaunch dusk bot");
  });

  it("tells the person to turn on CuaDriver, not to relaunch, when the helper app waits for a grant", () => {
    const reason = "Screen Recording required for CuaDriver; turn on CuaDriver in System Settings > Privacy & Security";
    expect(missingMacCuaPermissions(reason)).toEqual(["screen"]);
    expect(macCuaPermissionHelper(reason)).toBe("CuaDriver");
    const message = macCuaPermissionMessage(["screen"], reason);
    expect(message).toContain("Turn on CuaDriver");
    expect(message).toContain("Screen Recording");
    expect(message).not.toContain("relaunch");
    expect(macCuaPermissionMessage(["screen", "accessibility"], reason)).toContain("Screen Recording and Accessibility");
    expect(macCuaPermissionHelper("embedded host failed: Screen Recording required; restart dusk bot")).toBeNull();
    // the server's line for the chat names the grant the same way, so the card offers its pane
    expect(missingMacCuaPermissions("dusk bot can't use this computer yet: Screen Recording required. Turn on CuaDriver in System Settings > Privacy & Security > Screen Recording; dusk bot notices by itself, no restart needed.")).toEqual(["screen"]);
  });

  it("does not diagnose missing or malformed status as a grant failure", () => {
    expect(missingMacCuaPermissions(null)).toEqual([]);
    expect(missingMacCuaPermissions({ reason: "Screen Recording required" })).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording available")).toEqual([]);
    expect(missingMacCuaPermissions("Screen Recording granted; Accessibility required")).toEqual(["accessibility"]);
    expect(macCuaPermissionMessage([])).toBeNull();
  });

  it("opens one pane: the first missing permission, Accessibility before Screen Recording", () => {
    expect(macPermissionPaneToOpen("Accessibility and Screen Recording required", null)).toBe("accessibility");
    expect(macPermissionPaneToOpen("Screen Recording required", { supported: true, accessibility: "missing", screen: "missing" })).toBe("screen");
    expect(macPermissionPaneToOpen(undefined, { supported: true, accessibility: "granted", screen: "asked" })).toBe("screen");
    expect(macPermissionPaneToOpen(undefined, { supported: true, accessibility: "missing", screen: "missing" })).toBe("accessibility");
    expect(macPermissionPaneToOpen("helper exited", { supported: false })).toBe("accessibility");
    expect(macPermissionPaneToOpen(undefined, null)).toBe("accessibility");
  });
});
