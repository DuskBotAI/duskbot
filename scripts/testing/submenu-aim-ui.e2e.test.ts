// The account menu's Support submenu stays open while the pointer crosses the row below on its way to the submenu, and
// closes when the pointer heads away. Pointer paths are only provable in a browser.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { CHROME_PATH, openHeadlessChrome, type HeadlessPage } from "./headless-chrome.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.DUSK_UI_E2E === "1" || existsSync(CHROME_PATH);
if (!enabled) console.info("skipping submenu aim UI e2e: no Chrome at DUSK_CDP_CHROME");

(enabled ? it : it.skip)("keeps the Support submenu open on a diagonal path and closes it on a straight one", async () => {
  const profile = mkdtempSync(join(tmpdir(), "dusk-submenu-chrome-"));
  let ui: MountedPreview | undefined;
  let page: HeadlessPage | undefined;
  try {
    ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/submenu-aim-preview.tsx", route: "/__submenu-aim.html", title: "Isolated submenu aim", logLevel: "warn" });
    page = await openHeadlessChrome(profile);
    const { send, evaluate, until } = page;
    await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: ui.previewUrl });
    await until(`document.querySelector('button[aria-haspopup="menu"]')`);

    const mouse = (x: number, y: number) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const box = (selector: string) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`) as Promise<{ left: number; right: number; top: number; bottom: number; x: number; y: number }>;
    const subOpen = () => evaluate(`Boolean(document.querySelector('[data-sidebar-popover-submenu]'))`) as Promise<boolean>;
    const row = (key: string) => `[data-sidebar-popover-menu] [data-menu-key="${key}"]`;
    const walk = async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 14, pause = 20) => {
      for (let step = 1; step <= steps; step++) {
        await mouse(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
        await delay(pause);
      }
    };
    const openSupport = async () => {
      await mouse(5, 5);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      await until(`!document.querySelector('[data-sidebar-popover-menu]')`);
      const trigger = await box('button[aria-haspopup="menu"]');
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await until(`document.querySelector('${row("support")}')`);
      await delay(300);
      const support = await box(row("support"));
      await walk({ x: support.left - 40, y: support.y }, { x: support.left + 30, y: support.y }, 4);
      await until(`document.querySelector('[data-sidebar-popover-submenu]')`);
      await delay(250);
      return { support, from: { x: support.left + 30, y: support.y } };
    };

    // down and toward the submenu's lower rows, across Settings, ending inside the submenu
    let { from } = await openSupport();
    const sub = await box("[data-sidebar-popover-submenu]");
    const target = await box(`[data-sidebar-popover-submenu] [data-menu-key="export"]`);
    await walk(from, { x: sub.left + 20, y: target.y }, 24, 40);
    await delay(500);
    expect(await subOpen(), "a diagonal path across Settings keeps the submenu").toBe(true);
    const settings = await box(row("settings"));
    expect(target.y, "the path really passed the Settings row's height").toBeGreaterThan(settings.top);

    // straight across into the 4px between the menu and the submenu, resting there
    ({ from } = await openSupport());
    const menu = await box("[data-sidebar-popover-menu]");
    const gapSub = await box("[data-sidebar-popover-submenu]");
    const gapX = (menu.right + gapSub.left) / 2;
    await walk(from, { x: gapX, y: from.y }, 8);
    await delay(500);
    expect(await subOpen(), "resting in the gap keeps the submenu").toBe(true);
    await walk({ x: gapX, y: from.y }, { x: gapSub.left + 20, y: from.y }, 4);
    await delay(300);
    expect(await subOpen(), "and it is still there once inside").toBe(true);

    // straight down away from the submenu: Settings, then Sign out
    ({ from } = await openSupport());
    const signOut = await box(row("signout"));
    await walk(from, { x: from.x, y: signOut.y }, 10);
    await delay(500);
    expect(await subOpen(), "a straight path down closes it").toBe(false);

    // grok-styled SidebarPopoverMenu anchored on the right edge: submenu flips LEFT, clamped above bottom
    const openRightSupport = async () => {
      await mouse(5, 5);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      await until(`!document.querySelector('[data-sidebar-popover-menu]')`);
      const trigger = await box('[data-right-popover] button[aria-haspopup="menu"]');
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await until(`document.querySelector('${row("support")}')`);
      await delay(250);
      const support = await box(row("support"));
      const start = { x: support.right - 30, y: support.y };
      await walk({ x: support.right + 20, y: support.y }, start, 4);
      await until(`document.querySelector('[data-sidebar-popover-submenu]')`);
      await delay(200);
      return { support, from: start };
    };
    const rightStart = (await openRightSupport()).from;
    const rightMenu = await box("[data-sidebar-popover-menu]");
    const leftSub = await box("[data-sidebar-popover-submenu]");
    expect(leftSub.right, "submenu flipped to the left side of the right-edge menu").toBeLessThan(rightMenu.left);
    // diagonal down-left across Settings into About
    const about = await box(`[data-sidebar-popover-submenu] [data-menu-key="about"]`);
    await walk(rightStart, { x: leftSub.right - 25, y: about.y }, 18, 25);
    await delay(400);
    expect(await subOpen(), "diagonal glide down-left across Settings keeps flipped submenu open").toBe(true);
    // resting in the left-side 4px gap keeps it open
    const rightStart2 = (await openRightSupport()).from;
    const leftGapX = (leftSub.right + rightMenu.left) / 2;
    await walk(rightStart2, { x: leftGapX, y: rightStart2.y }, 8, 20);
    await delay(500);
    expect(await subOpen(), "resting in the left-side gap keeps flipped submenu open").toBe(true);
    // diagonal up-left across Usage into Help center (submenu clamped upward above Support)
    const rightStart3 = (await openRightSupport()).from;
    const helpCenter = await box(`[data-sidebar-popover-submenu] [data-menu-key="help"]`);
    await walk(rightStart3, { x: leftSub.right - 25, y: helpCenter.y }, 14, 25);
    await delay(300);
    expect(await subOpen(), "diagonal glide up-left keeps clamped submenu open").toBe(true);

    // BotContextMenu ("Move to" flyout): the same safe corridor and gap bridge
    const botMenu = () => `[data-bot-menu][aria-label="Actions for Scout"]`;
    const moveOpen = () => evaluate(`Boolean(document.querySelector('[data-bot-menu-flyout="move"]'))`) as Promise<boolean>;
    const botRowBox = (label: string) => evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-bot-menu] [role^="menuitem"]')].find((node) => node.textContent?.includes(${JSON.stringify(label)})).getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`) as Promise<{ left: number; right: number; top: number; bottom: number; x: number; y: number }>;
    const openMove = async (byClick = false) => {
      await mouse(5, 5);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      await until(`!document.querySelector(${JSON.stringify(botMenu())})`);
      const trigger = await box("[data-open-bot-menu]");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await until(`document.querySelector('[data-bot-menu-move]')`);
      await delay(200);
      const move = await box("[data-bot-menu-move]");
      const start = { x: move.left + 40, y: move.y };
      if (byClick) {
        await mouse(start.x, start.y);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x, y: start.y, button: "left", clickCount: 1 });
      } else {
        await walk({ x: move.left - 30, y: move.y }, start, 4);
      }
      await until(`document.querySelector('[data-bot-menu-flyout="move"]')`);
      await delay(150);
      return { move, from: start };
    };

    // 1. Dwell open without moving again, then glide diagonally across Mark as unread & Rename bot into Create section
    let botFrom = (await openMove(false)).from;
    const flyoutBox = await box('[data-bot-menu-flyout="move"]');
    const createSection = await botRowBox("Create section");
    const markUnread = await botRowBox("Mark as unread");
    const renameBot = await botRowBox("Rename bot");
    expect(createSection.y, "path crosses Mark as unread's height").toBeGreaterThan(markUnread.top);
    const midPoint = { x: (botFrom.x + flyoutBox.left) / 2, y: (botFrom.y + createSection.y) / 2 };
    await walk(botFrom, midPoint, 10, 20);
    expect(await evaluate(`document.querySelector(${JSON.stringify(botMenu())}).hasAttribute("data-submenu-aiming")`), "aiming suppresses sibling hover while crossing").toBe(true);
    await walk(midPoint, { x: flyoutBox.left + 30, y: createSection.y }, 10, 20);
    await delay(400);
    expect(await moveOpen(), "diagonal path across Mark as unread and Rename bot keeps Move to open").toBe(true);
    expect(await evaluate(`document.querySelector(${JSON.stringify(botMenu())}).hasAttribute("data-submenu-aiming")`), "aiming clears once inside the submenu").toBe(false);

    // 2. Returning from the submenu onto Rename bot closes Move to immediately
    await walk({ x: flyoutBox.left + 30, y: createSection.y }, { x: renameBot.x, y: renameBot.y }, 8, 20);
    await delay(100);
    expect(await moveOpen(), "returning from submenu onto sibling row closes it").toBe(false);

    // 3. Click open, then diagonal glide into Create section
    botFrom = (await openMove(true)).from;
    await walk(botFrom, { x: flyoutBox.left + 30, y: createSection.y }, 18, 25);
    await delay(400);
    expect(await moveOpen(), "click-opened Move to stays open on diagonal path").toBe(true);

    // 4. Straight across into the 4px gap between menu and flyout, resting there, then into Grok Bot
    botFrom = (await openMove(false)).from;
    const botSheet = await box(botMenu());
    const moveGapX = (botSheet.right + flyoutBox.left) / 2;
    await walk(botFrom, { x: moveGapX, y: botFrom.y }, 8, 20);
    await delay(500);
    expect(await moveOpen(), "resting in the 4px gap keeps Move to open").toBe(true);
    await walk({ x: moveGapX, y: botFrom.y }, { x: flyoutBox.left + 25, y: botFrom.y }, 4, 20);
    await delay(300);
    expect(await moveOpen(), "entering Grok Bot after the gap keeps it open").toBe(true);

    // 5. Grazing slightly up into Pin while heading right toward Grok Bot keeps Move to open
    const { move: moveBox } = await openMove(false);
    const pin = await botRowBox("Pin");
    const grokBot = await botRowBox("Grok Bot");
    await mouse(moveBox.left + 50, moveBox.top + 3);
    await walk({ x: moveBox.left + 50, y: moveBox.top + 3 }, { x: moveBox.right - 20, y: pin.bottom - 2 }, 6, 20);
    await walk({ x: moveBox.right - 20, y: pin.bottom - 2 }, { x: flyoutBox.left + 30, y: grokBot.y }, 6, 20);
    await delay(300);
    expect(await moveOpen(), "grazing Pin on the way right into Grok Bot keeps Move to open").toBe(true);

    // 6. Clicking a sibling row mid-aim still triggers it immediately
    botFrom = (await openMove(false)).from;
    const aimClick = { x: botFrom.x + 30, y: markUnread.y };
    await walk(botFrom, aimClick, 6, 15);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: aimClick.x, y: aimClick.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: aimClick.x, y: aimClick.y, button: "left", clickCount: 1 });
    await until(`!document.querySelector(${JSON.stringify(botMenu())})`);

    // 7. Straight down onto Mark as unread and Rename bot closes Move to
    botFrom = (await openMove(false)).from;
    await walk(botFrom, { x: botFrom.x, y: renameBot.y }, 10, 20);
    await delay(200);
    expect(await moveOpen(), "straight down onto sibling rows closes Move to").toBe(false);
  } finally {
    page?.close();
    await ui?.close();
    await delay(300);
    rmSync(profile, { recursive: true, force: true });
  }
}, 120_000);
