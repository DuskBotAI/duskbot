// How a person reaches the places the one grok layout keeps off the sidebar:
// Automations, the Team map and the Inbox from Settings > Advanced features,
// bot Templates from Connect apps. Every step goes by accessible name.
import { expect } from "vitest";

type Ui = (verb: string, ...args: string[]) => Promise<Record<string, any>>;
type Ref = { name: string; role: string };

/** Menus and dialogs slide in; a click mid-motion lands where the target was a frame ago, so wait for still frames. */
export async function settled(ui: Ui): Promise<void> {
  await ui("eval", "--js", `new Promise((done) => {
    const until = performance.now() + 2000;
    const tick = () => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity) || performance.now() > until ? done(true) : setTimeout(tick, 16);
    tick();
  })`);
}

/** Click the one element with this role (or a button or menuitem) and name, once React has painted it. */
export async function clickByName(ui: Ui, name: string | RegExp, role?: string, timeout = 10_000): Promise<void> {
  let matches: Array<[string, Ref]> = [];
  const roles = role ? [role] : ["button", "menuitem"];
  let page = "";
  await expect.poll(async () => {
    const state = await ui("snapshot");
    page = state.snapshot as string;
    matches = Object.entries(state.refs as Record<string, Ref>).filter(([, entry]) => roles.includes(entry.role)
      && (typeof name === "string" ? entry.name === name : name.test(entry.name)));
    return matches.length;
  }, { timeout, message: `one ${roles.join("/")} named ${String(name)}` }).toBe(1).catch((error: Error) => {
    if (process.env.TRACE_UI) console.log(page);
    throw error;
  });
  await settled(ui);
  await ui("click", "--ref", `@${matches[0]![0]}`);
}

/** The ref of the one `role "name"` inside the snapshot node whose line contains `container` (e.g. `dialog "Ben"`):
 * the sidebar keeps a button of the same name beside a dialog's own. */
export async function refWithin(ui: Ui, container: string, name: string, role = "button", timeout = 10_000): Promise<string> {
  let refs: string[] = [];
  await expect.poll(async () => {
    const lines = ((await ui("snapshot")).snapshot as string).split("\n");
    const at = lines.findIndex((line) => line.includes(container));
    refs = [];
    if (at < 0) return 0;
    const depth = lines[at]!.search(/\S/);
    for (const line of lines.slice(at + 1)) {
      if (line.search(/\S/) <= depth) break;
      const ref = line.includes(`${role} ${JSON.stringify(name)}`) ? line.match(/ref=(e\d+)/)?.[1] : undefined;
      if (ref) refs.push(ref);
    }
    return refs.length;
  }, { timeout, message: `one ${role} named ${name} in ${container}` }).toBe(1);
  return `@${refs[0]}`;
}

/** A notice card (a GitHub star ask, a Cloud offer) sits over the sidebar's footer; a person closes it first. */
export async function dismissNotices(ui: Ui): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const label = (await ui("eval", "--js", "document.querySelector('aside[data-notice] button[aria-label]')?.getAttribute('aria-label') ?? null")).result as string | null;
    if (!label) return;
    await clickByName(ui, label, "button");
    await expect.poll(async () => (await ui("eval", "--js", `[...document.querySelectorAll('aside[data-notice] button[aria-label]')].some(button => button.getAttribute('aria-label') === ${JSON.stringify(label)})`)).result).toBe(false);
  }
}

/** You > Settings, then a pane of its rail: General, Permissions, Models, Advanced features... */
export async function openSettings(ui: Ui, pane?: string): Promise<void> {
  await dismissNotices(ui);
  await clickByName(ui, "You", "button");
  await clickByName(ui, "Settings", "menuitem");
  if (!pane) return;
  // the rail's own item: a bot panel open under Settings can hold a row of the same name
  const item = `[...document.querySelectorAll('[data-settings-sheet] .settings-nav-item')].find((entry) => entry.querySelector('span')?.textContent.trim() === ${JSON.stringify(pane)})`;
  await expect.poll(async () => (await ui("eval", "--js", `Boolean(${item})`)).result, { timeout: 10_000, message: `rail item ${pane}` }).toBe(true);
  await settled(ui);
  await ui("eval", "--js", `${item}.click(); true`);
}

/** Settings > Advanced features > one of its pages: "Apps and tools", "Storage and backups"... "Bots" is its own pane now,
 * opened on new bots' defaults. */
export async function openAdvancedSettings(ui: Ui, page: string): Promise<void> {
  if (page === "Bots") {
    await openSettings(ui);
    const rail = "document.querySelector('[data-settings-sheet] [data-settings-page=bots]')";
    await expect.poll(async () => (await ui("eval", "--js", `Boolean(${rail})`)).result, { timeout: 10_000 }).toBe(true);
    await ui("eval", "--js", `${rail}.click(); true`);
    await settled(ui);
    await clickByName(ui, "Bot", "combobox");
    await clickByName(ui, "New bots", "option");
    return;
  }
  await openSettings(ui, "Advanced features");
  await clickByName(ui, new RegExp(`^${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`), "button");
}

/** A row of Advanced features' first card, which opens that place straight away. */
export async function openFromBotsSettings(ui: Ui, row: "Inbox" | "Team map" | "Files"): Promise<void> {
  await openSettings(ui, "Advanced features");
  await clickByName(ui, row, "button");
}

export async function openTeamMap(ui: Ui): Promise<void> {
  await openFromBotsSettings(ui, "Team map");
  await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.querySelector('[data-team-canvas]'))")).result, { timeout: 10_000 }).toBe(true);
}

/** Connect apps > Bot templates: the Templates library with its Explore, Import, From a folder and Share tabs. */
export async function openTemplates(ui: Ui): Promise<void> {
  await dismissNotices(ui);
  await clickByName(ui, "Connect apps", "button");
  await clickByName(ui, "Bot templates", "button", 15_000);
  await expect.poll(async () => (await ui("snapshot")).snapshot as string, { timeout: 20_000 }).toContain('dialog "Templates"');
}

/** The bot's panel: the chat header's pill opens it, unless it is open already. */
export async function openBotPanel(ui: Ui, botName: string): Promise<void> {
  await dismissNotices(ui);
  if ((await ui("eval", "--js", "Boolean(document.getElementById('bot-panel'))")).result !== true) await clickByName(ui, `Open ${botName}'s profile`, "button");
  await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.getElementById('bot-panel'))")).result, { timeout: 10_000 }).toBe(true);
}

/** The bot's settings page now open on Settings' Bots pane ("tools", "permissions", "identity"...), or null. */
export const BOT_PAGE = "document.querySelector('[data-settings-sheet] .settings-wipe-layer:not([data-wipe-out]) [data-bot-page]')?.dataset.botPage ?? null";

/** Panel > Advanced > a row of the bot's settings ("tools", "permissions", "identity", "slack"...): Settings' Bots pane
 * on this bot, open at that row's page. A row's name carries its value, so the row is found by its page. */
export async function openBotSheet(ui: Ui, botName: string, page: string): Promise<void> {
  await openBotPanel(ui, botName);
  await clickByName(ui, "Advanced", "tab");
  const row = `document.querySelector('#bot-panel [data-panel-page=${JSON.stringify(page)}]')`;
  await expect.poll(async () => (await ui("eval", "--js", `Boolean(${row})`)).result, { timeout: 10_000, message: `${page} row` }).toBe(true);
  await settled(ui);
  await ui("eval", "--js", `${row}.click(); true`);
  await expect.poll(async () => (await ui("eval", "--js", BOT_PAGE)).result, { timeout: 10_000 }).toBe(page);
}

/** Settings closed, and the bot's panel with it. */
export async function closeBotPanel(ui: Ui): Promise<void> {
  if ((await ui("eval", "--js", "Boolean(document.querySelector('[data-settings-sheet]'))")).result === true) {
    await ui("eval", "--js", "document.querySelector('[data-settings-sheet] .settings-close').click(); true");
    await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.querySelector('[data-settings-sheet]'))")).result).toBe(false);
  }
  if ((await ui("eval", "--js", "Boolean(document.getElementById('bot-panel'))")).result === true) {
    await ui("eval", "--js", "document.querySelector('#bot-panel button[aria-label=\"Close panel\"]').click(); true");
    await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.getElementById('bot-panel'))")).result, { timeout: 10_000 }).toBe(false);
  }
}

/** The panel's Share menu, which also holds this chat's copy, download, usage, Activity and Inspector. */
export async function openPanelMenu(ui: Ui, botName: string): Promise<void> {
  await openBotPanel(ui, botName);
  await clickByName(ui, "Share and more", "button");
  await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.querySelector('[data-panel-share-menu]'))")).result, { timeout: 10_000 }).toBe(true);
  await settled(ui);
}

/** Another of the bot's settings pages: back out of the one open, then that row. */
export async function sheetPage(ui: Ui, page: string): Promise<void> {
  // the page shown is the wipe's live layer; an outgoing copy may still sit under it for 200ms
  const live = "document.querySelector('[data-settings-sheet] .settings-wipe-layer:not([data-wipe-out])')";
  for (let step = 0; step < 4; step++) {
    if ((await ui("eval", "--js", `Boolean(${live}?.querySelector('[data-bot-page]'))`)).result !== true) break;
    await ui("eval", "--js", `${live}.querySelector('[data-settings-back]').click(); true`);
    await settled(ui);
  }
  // a bot's pages open from the rows of its panel's Advanced tab; backing out of the first page closes the sheet, so the
  // row is the sheet's own while it is open and the panel's once it has closed
  const row = `(${live}?.querySelector('[data-panel-page=${JSON.stringify(page)}]') ?? document.querySelector('[data-panel-page=${JSON.stringify(page)}]'))`;
  await expect.poll(async () => (await ui("eval", "--js", `Boolean(${row})`)).result, { timeout: 10_000 }).toBe(true);
  await ui("eval", "--js", `${row}.click(); true`);
  await expect.poll(async () => (await ui("eval", "--js", BOT_PAGE)).result, { timeout: 10_000 }).toBe(page);
}
