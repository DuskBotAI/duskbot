import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MENU_MOTION_MS } from "@/components/MenuMotion";
import { applyDesktopMotion, DESKTOP_MOTION, DESKTOP_MOTIONS, desktopMotionVars } from "./desktop-motion";
import { dialogMotion, SHEET_EXIT, sheetLeave, SWAP, swapMotion } from "./motion-presets";
import { MOTION, pacedMs, pacedOut, pacedSeconds } from "./motion-speed";

function fakeRoot(dataset: Record<string, string> = {}) {
  const props: Record<string, string> = {};
  return { root: { dataset, style: { setProperty: (name: string, value: string) => { props[name] = value; } } } as unknown as HTMLElement, props };
}

describe("desktop motion", () => {
  it("ships the owner's pick, B", () => {
    expect(DESKTOP_MOTION.pick).toBe("b");
  });

  it("leaves the root alone at A and on the phone", () => {
    const desk = fakeRoot();
    applyDesktopMotion(desk.root, DESKTOP_MOTIONS.a);
    expect(desk.root.dataset).toEqual({});
    expect(desk.props).toEqual({});
    const phone = fakeRoot({ mobileApp: "ios" });
    applyDesktopMotion(phone.root, DESKTOP_MOTIONS.c);
    expect(phone.root.dataset).toEqual({ mobileApp: "ios" });
    expect(phone.props).toEqual({});
  });

  it("marks the root and sets every value the stylesheet reads at a pick past A", () => {
    const { root, props } = fakeRoot();
    applyDesktopMotion(root, DESKTOP_MOTIONS.c);
    expect(root.dataset).toEqual({ desktopMotion: "c", desktopMotionPalette: "", desktopMotionRows: "", desktopMotionToast: "" });
    const css = readFileSync(new URL("../styles/desktop-motion.css", import.meta.url), "utf8");
    const read = new Set(css.match(/--dm-[a-z-]+/g));
    for (const name of read) expect(props, name).toHaveProperty(name);
    expect(desktopMotionVars(DESKTOP_MOTIONS.b)["--dm-menu-ms"]).toBe(`${pacedMs(110)}ms`);
  });

  it("scopes every rule of its stylesheet to a pick past A", () => {
    const css = readFileSync(new URL("../styles/desktop-motion.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const roots = css.split("\n").filter((line) => /^\s*:root/.test(line) && !line.includes("[data-palette-glide]"));
    expect(roots.length).toBeGreaterThan(0);
    for (const line of roots) expect(line).toMatch(/^\s*:root\[data-desktop-motion[a-z-]*\]:not\(\[data-reduced-motion="true"\]\)/);
  });

  it("plays every dialog and menu exit inside the time a closing overlay stays mounted", () => {
    for (const pick of Object.values(DESKTOP_MOTIONS)) {
      expect(pacedMs(pick.menu.leave.ms)).toBeLessThanOrEqual(MENU_MOTION_MS);
      if (pick.pick !== "a") expect(pacedMs(pick.dialog.leave.ms)).toBeLessThanOrEqual(MENU_MOTION_MS);
    }
  });

  it("keeps the shipped dialog, swap and leave motion at A", () => {
    const ease = pacedOut([0.22, 1, 0.36, 1]);
    expect(dialogMotion(false, DESKTOP_MOTIONS.a).sheet).toEqual({
      initial: { opacity: 0, transform: "scale(0.96)" },
      animate: { opacity: 1, transform: "scale(1)", transition: { duration: pacedSeconds(0.2), ease } },
      exit: { opacity: 0, transform: "scale(0.98)", transition: { duration: pacedSeconds(0.12), ease } },
    });
    expect(swapMotion(DESKTOP_MOTIONS.a)).toEqual({ initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } } });
    expect(SWAP).toEqual(swapMotion(DESKTOP_MOTION));
    expect(sheetLeave(DESKTOP_MOTIONS.a)).toEqual({ opacity: 0, transition: SHEET_EXIT });
  });

  it("drops the travel and blur under reduced motion at every pick", () => {
    for (const pick of Object.values(DESKTOP_MOTIONS)) {
      const { sheet } = dialogMotion(true, pick);
      expect(sheet.initial).toEqual({ opacity: 0, transform: "none" });
    }
  });

  it("grows B and C out of .94 to .98, never from nothing, and leaves faster than it came", () => {
    for (const pick of [DESKTOP_MOTIONS.b, DESKTOP_MOTIONS.c]) {
      for (const enter of [pick.menu.enter, pick.dialog.enter, pick.palette.enter!]) expect(enter.scale).toBeGreaterThanOrEqual(0.94);
      expect(pick.menu.leave.ms).toBeLessThan(pick.menu.enter.ms);
      expect(pick.dialog.leave.ms).toBeLessThan(pick.dialog.enter.ms);
    }
    expect(MOTION.scale).toBeGreaterThan(0);
  });

  it("takes away whatever came in with motion, faster than it came, and nothing at A", () => {
    expect(DESKTOP_MOTIONS.a.palette.leave).toBeNull();
    expect(DESKTOP_MOTIONS.a.toast).toBeNull();
    for (const pick of [DESKTOP_MOTIONS.b, DESKTOP_MOTIONS.c]) {
      expect(pick.palette.leave!.ms).toBeLessThan(pick.palette.enter!.ms);
      expect(pick.toast!.leaveMs).toBeLessThan(pick.toast!.ms);
    }
  });
});
