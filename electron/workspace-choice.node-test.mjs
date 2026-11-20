import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import environments from "./environments.cjs";
import { CHOSEN, GONE, JOINED, localPageStep, settledActive, UNUSABLE } from "./workspace-choice.mjs";
import { world, LOCAL, TEAM, ACME, connected } from "./fixtures/home-window-world.mjs";
import { CONNECT_GRACE_MS, HOME_SCREEN_PATH } from "./home-window.mjs";
import { RECONNECT_PATH } from "./workspace-reconnect.mjs";

const VPS = { id: "vps", kind: "remote", name: "Garage server", origin: "https://garage.example.test" };
const OTHER = { id: "other", kind: "remote", name: "Office", origin: "https://office.example.test" };
const saved = (activeId) => ({ environments: [VPS, OTHER], activeId });

test("only the person's choice, a confirmed join, or the chosen entry leaving moves the chosen workspace", () => {
  const onVps = saved("vps");
  for (const why of [null, undefined, "failure", "restart"]) {
    assert.equal(settledActive(onVps, environments.withActive(onVps, environments.LOCAL_ID), why).activeId, "vps", `${why}: a failure never moves it to This computer`);
    assert.equal(settledActive(onVps, environments.withActive(onVps, "other"), why).activeId, "vps", `${why}: nor to another server`);
  }
  const onLocal = saved(environments.LOCAL_ID);
  assert.equal(settledActive(onLocal, environments.withActive(onLocal, "vps")).activeId, environments.LOCAL_ID, "This computer stays too");
  for (const why of [CHOSEN, JOINED, GONE, UNUSABLE]) assert.equal(settledActive(onVps, environments.withActive(onVps, environments.LOCAL_ID), why).activeId, environments.LOCAL_ID, why);
  const forgotten = environments.withoutEnvironment(onVps, "vps");
  assert.equal(settledActive(onVps, forgotten), forgotten, "the chosen entry gone: This computer, with no reason needed");
  const same = { ...onVps, environments: [{ ...VPS, color: "blue" }, OTHER] };
  assert.equal(settledActive(onVps, same), same, "a write that keeps the choice is untouched");
});

const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const writes = MAIN.split("\n").map((line, at) => ({ line, at: at + 1 }))
  .filter(({ line }) => /persistEnvironments\(/.test(line) && !/function persistEnvironments/.test(line));

test("main: every write that names the chosen workspace says why, and a failed load never switches", () => {
  const naming = writes.filter(({ line }) => /withActive\(|activeId: LOCAL_ID/.test(line));
  assert.ok(naming.length >= 10, "the writes are found");
  for (const { line, at } of naming) assert.match(line, new RegExp(`, "(${[CHOSEN, JOINED, GONE, UNUSABLE].join("|")})"\\)`), `main.mjs:${at} changes the chosen workspace without a reason`);
  const failLoad = MAIN.slice(MAIN.indexOf(`win.webContents.on("did-fail-load"`), MAIN.indexOf(`win.webContents.on("did-navigate"`));
  assert.ok(failLoad.includes("workspaceReconnect.lost(remote)"), "a server that doesn't load gets the reconnect page");
  assert.doesNotMatch(failLoad, /switchEnvironment|withActive|showMessageBox/, "no dialog and no switch on a failed load");
  const go = MAIN.slice(MAIN.indexOf("  go: (url, origin, place) =>"), MAIN.indexOf("  showLocal: leaving =>"));
  assert.doesNotMatch(go, /LOCAL_ID/, "this computer's screen for a place that can't be shown leaves the place chosen");
  const sendToPage = MAIN.slice(MAIN.indexOf("function sendToPage("), MAIN.indexOf("function deliverPackageInstall("));
  assert.doesNotMatch(sendToPage.slice(0, sendToPage.indexOf("function askToOpenLinkHome")), /switchEnvironment/, "a link never switches by itself");
  assert.match(sendToPage, /if \(response === 0\) return workspaceMenuAction/, "only the person's yes opens the link's workspace");
  assert.equal(HOME_SCREEN_PATH, "/home");
  assert.equal(RECONNECT_PATH, "/reconnect");
  assert.equal((MAIN.match(/rendererOrigin\(\), \["\/home", "\/reconnect"\]\)/g) ?? []).length, 2, "this app's own screens may use its controls while a place stays chosen");
});

test("the sender guard: this app's own screens count while a server is chosen, nothing else of this computer's page", () => {
  const contents = { mainFrame: { url: "" } };
  const at = (url) => { contents.mainFrame.url = url; return { sender: contents, senderFrame: contents.mainFrame }; };
  const onVps = saved("vps"), local = "http://127.0.0.1:8799", screens = ["/home", "/reconnect"];
  assert.equal(environments.workspaceSenderAllowed(at(`${VPS.origin}/`), contents, onVps, local, screens), true);
  assert.equal(environments.workspaceSenderAllowed(at(`${local}/reconnect`), contents, onVps, local, screens), true);
  assert.equal(environments.workspaceSenderAllowed(at(`${local}/home`), contents, onVps, local, screens), true);
  assert.equal(environments.workspaceSenderAllowed(at(`${local}/`), contents, onVps, local, screens), false, "this computer's app page isn't the chosen workspace");
  assert.equal(environments.workspaceSenderAllowed(at(`${local}/reconnect`), contents, onVps, local), false, "only where main says so");
  assert.equal(environments.workspaceSenderAllowed(at(`${VPS.origin}/reconnect`), contents, saved("other"), local, screens), false, "never another origin's page by its path");
  assert.equal(environments.workspaceSenderAllowed({ sender: contents, senderFrame: { url: `${local}/reconnect` } }, contents, onVps, local, screens), false, "a subframe never");
});

test("a team's Cloud that can't be reached, then the person picks another server: the screen's own retry never brings the window back", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { down: true }, url: `${LOCAL}/` });
  await w.home.show({ place: { team: "team-acme" } });
  // a switch still connecting keeps the opening loader for its grace, then says it can't reach the team
  assert.deepEqual(w.home.view(), { screen: "opening", name: "Acme" });
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  await w.later(CONNECT_GRACE_MS);
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Acme" });
  // the rail: main's switchEnvironment forgets the remembered team and loads the server's page
  w.remembered = null;
  w.url = VPS.origin;
  w.home.navigated(`${VPS.origin}/`);
  const before = { went: w.went.length, local: w.local.length };
  for (const ms of [2_000, 4_000, 8_000, 15_000, 30_000, 30_000]) await w.later(ms);
  assert.equal(w.went.length, before.went, "nothing moves the window");
  assert.deepEqual(w.local.slice(before.local).filter(Boolean), [], "never back to this computer's page");
  assert.equal(w.url, VPS.origin);
  // the screen itself, and the team's own page loading, keep the wait as it was
  const again = world({ state: { ...connected(), teams: [ACME] }, team: { down: true }, url: `${LOCAL}/` });
  await again.home.show({ place: { team: "team-acme" } });
  again.home.navigated(`${LOCAL}${HOME_SCREEN_PATH}`);
  again.team.down = false;
  await again.later(2_000);
  assert.deepEqual(again.went.at(-1), [TEAM, TEAM, "team-acme"], "it still comes back by itself while the person waits on it");
});

test("the window closed and opened again from the Dock opens the linked server it showed, never this computer's empty page", async () => {
  const w = world({ journal: null, state: { status: "signed-out" }, url: "" });
  await w.home.show();
  assert.deepEqual(w.local, [true], "a window with no page yet asks for this computer's screen");
  assert.equal(localPageStep({ leaving: w.local[0], url: "", serverChosen: true }), "open", "while a server is chosen it opens that server");
  assert.equal(localPageStep({ leaving: true, url: "", serverChosen: false }), "switch");
  assert.equal(localPageStep({ leaving: true, url: `${VPS.origin}/`, serverChosen: true }), "switch", "a window that showed a place goes back to this computer");
  assert.equal(localPageStep({ leaving: false, url: "", serverChosen: true }), "stay");
  const showLocal = MAIN.slice(MAIN.indexOf("  showLocal: leaving =>"), MAIN.indexOf("installHomeWindowIpc("));
  assert.ok(showLocal.indexOf("localPageStep(") > 0 && showLocal.indexOf("localPageStep(") < showLocal.indexOf("withActive("), "main asks before it moves the choice");
  assert.match(showLocal, /step === "open"\) return windowsWithoutPage\.has\(mainWindow\) \? navigateMainWindow\(activeOrigin\(\)\)/);
});
