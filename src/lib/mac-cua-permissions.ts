import { COMPUTER_HELPER_APP, permissionHolder } from "../../shared/your-computer";
import { t } from "./i18n";
import { MAC_PERMISSIONS, type MacPermissionStatus } from "./mac-permissions";

export type MacCuaPermission = "screen" | "accessibility";

export function missingMacCuaPermissions(reason: unknown): MacCuaPermission[] {
  if (typeof reason !== "string" || reason.length > 2_000) return [];
  const missingList = reason.match(/(Accessibility(?: and Screen Recording)?|Screen Recording(?: and Accessibility)?) required\b/i)?.[1];
  if (!missingList) return [];
  const missing: MacCuaPermission[] = [];
  if (/Screen Recording/i.test(missingList)) missing.push("screen");
  if (/Accessibility/i.test(missingList)) missing.push("accessibility");
  return missing;
}

/** The helper app macOS lists the grants under when this Mac is driven through it, or null when it is the app itself. */
export function macCuaPermissionHelper(reason: unknown): string | null {
  return typeof reason === "string" && permissionHolder(reason) === COMPUTER_HELPER_APP ? COMPUTER_HELPER_APP : null;
}

export function macCuaPermissionMessage(permissions: MacCuaPermission[], reason?: unknown): string | null {
  if (!permissions.length) return null;
  const helper = macCuaPermissionHelper(reason);
  if (helper) {
    return permissions.length > 1
      ? t("computer.mac.permission.helperBoth", { helper })
      : t("computer.mac.permission.helperOne", { helper, permission: permissions[0] === "screen" ? "Screen Recording" : "Accessibility" });
  }
  if (permissions.length > 1) return t("computer.mac.permission.requiredBoth");
  return t("computer.mac.permission.requiredOne", {
    permission: permissions[0] === "screen" ? "Screen Recording" : "Accessibility",
  });
}

/** The one System Settings pane to open: System Settings shows a single pane, so a second one would hide the first. */
export function macPermissionPaneToOpen(reason: unknown, status: MacPermissionStatus | null): MacCuaPermission {
  const reported = missingMacCuaPermissions(reason);
  const missing = MAC_PERMISSIONS.find((kind) => reported.includes(kind))
    ?? (status?.supported ? MAC_PERMISSIONS.find((kind) => status[kind] !== "granted") : undefined);
  return missing ?? "accessibility";
}
