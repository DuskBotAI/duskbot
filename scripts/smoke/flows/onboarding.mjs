// Onboarding as a brand-new person: a fresh profile, signed out (or at the sign-in an install can require, --gate), then
// the first run end to end. It is two screens: the hello, then one AI choice (the AI already signed in here, free models
// or a plan); Dusk then speaks first in its chat with "What should we start with?" and the setup chips.
//   mac:    the hello, the AI choice (free models), Dusk's first message and card, then the first bot's first reply
//   cloud:  the same run, then the chat's Try cloud chip and the sheet it opens (buying is buy-cloud.mjs)
//   server: your own server is no longer part of the first run (add-server.mjs covers it)
// Every screen is shot at the app's normal window (1040x760) and its minimum (768x520) into <out>/steps/.
// With --root pointing at an older checkout the same script shoots that checkout's run ("before" shots); a screen the
// older run doesn't have stops with a note.
//
// --tour (the walkthrough) also opens the plan grid, an AI's card and the full list of AIs, as a curious person would.
//
//   node scripts/smoke/flows/onboarding.mjs [--path mac|cloud|server] [--out DIR] [--profile DIR] [--email ADDRESS] [--gate] [--tour]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFlow, flowArgs, runFlow, sleep } from "./lib.mjs";
import { walkthrough } from "./recorder.mjs";

const { option, flag, root, out, profile, email } = flowArgs("onb");
const path = option("--path", "mac");
if (!["mac", "cloud", "server"].includes(path)) throw new Error("--path is mac, cloud or server");
// signed out, as the installed app starts now; --gate starts at the sign-in an install can still require (DUSK_REQUIRE_ACCOUNT)
const gate = flag("--gate");
const flow = createFlow({ name: `onboarding-${path}`, title: `onboarding (${path === "mac" ? "this Mac" : path === "cloud" ? "dusk cloud" : "own server"}, ${gate ? "signed in at the gate" : "signed out"})`,
  root, out, profile, email, env: gate ? { DUSK_REQUIRE_ACCOUNT: "1" } : {} });

/** the app's main window sizes (electron/window-state.cjs): the default and the smallest it can be */
const SIZES = walkthrough.enabled ? [["normal", 1040, 760]] : [["normal", 1040, 760], ["min", 768, 520]];
const stepsDir = join(out, "steps");
mkdirSync(stepsDir, { recursive: true });
let shotCount = 0;
/** the screen at both window sizes, as steps/NN-<label>-<size>.png; back at the normal size after */
async function shots(label) {
  const n = String(++shotCount).padStart(2, "0"), files = [];
  // the app's own "connecting to your bots" cover fades out after a sign-in; the screen under it is the one to shoot
  await flow.waitFor(`!/connecting to your bots/i.test(document.body.innerText)`, "the connecting cover to go", 20_000).catch(() => {});
  await sleep(400);
  for (const [size, width, height] of SIZES) {
    await flow.viewport(width, height);
    await sleep(450);
    const file = join(stepsDir, `${n}-${label}-${size}.png`);
    try { await flow.app.screenshot(file); files.push(file); } catch {}
    const overflow = await flow.evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`).catch(() => false);
    if (overflow) flow.friction("broken", label, `the page scrolls sideways at ${width}x${height}`);
  }
  await flow.viewport(SIZES[0][1], SIZES[0][2]);
  flow.facts.shots = [...(flow.facts.shots ?? []), ...files.map((file) => file.split("/").pop())];
  return files;
}
const at = () => flow.evaluate(`document.querySelector("[data-welcome]")?.dataset.welcome ?? null`);
const funnelText = () => flow.evaluate(`(() => { const all = [...document.querySelectorAll("h1,h2")].filter((h) => h.getClientRects().length).map((h) => h.innerText.trim()); return all.join(" / "); })()`);

/** sends a line in the open chat and waits for a bot's "ok" after it: the first useful reply */
async function firstReply(where) {
  const marker = `smoke ${Date.now().toString(36)}`;
  await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat box", 60_000);
  await flow.evaluate(`document.querySelector('textarea[aria-label^="Message"]').focus(); true`);
  await flow.type(`Reply with just the word ok. (${marker})`);
  await flow.press("Enter", "Enter", 13);
  const started = Date.now();
  const outcome = await flow.waitFor(`(() => {
    const rows = document.querySelector("[data-simple-rows]")?.innerText ?? document.body.innerText;
    const at = rows.lastIndexOf(${JSON.stringify(marker)});
    if (at < 0) return false;
    const after = rows.slice(at + ${JSON.stringify(marker).length - 1}).replace(/\\b\\d{1,2}:\\d{2}\\b/g, "").trim();
    // no AI connected: the Connect your AI card is the answer, within ~30 s
    if (/connect your ai to keep chatting/i.test(document.body.innerText)) return "card:connect your AI";
    if (/failed|went wrong|couldn.t/i.test(after)) return "error:" + after.slice(0, 160);
    return /\\bok\\b/i.test(after) ? "reply:" + after.slice(0, 80) : false;
  })()`, "the bot's reply", 180_000);
  flow.facts.replySeconds = Math.round((Date.now() - started) / 1000);
  if (outcome.startsWith("error:")) throw new Error(`the bot answered with an error on ${where}: ${outcome.slice(6)}`);
  if (outcome.startsWith("card:")) {
    if (flow.facts.replySeconds > 30) throw new Error(`the Connect your AI card took ${flow.facts.replySeconds}s on ${where} (expected within ~30 s)`);
    return `no AI connected: the Connect your AI card in ${flow.facts.replySeconds}s`;
  }
  return `replied "${outcome.slice(6).replace(/\s+/g, " ")}" in ${flow.facts.replySeconds}s`;
}

await runFlow(flow, async () => {
  const funnelStarted = { at: 0 };
  const screens = [];
  await flow.step("launch", gate ? "a fresh app starts at the account gate" : "a fresh app starts on the hello, with no account", async () => {
    await flow.launch();
    await flow.viewport(SIZES[0][1], SIZES[0][2]);
    if (!gate) {
      await flow.waitText(/meet dusk bot|sign in to dusk bot/i, "the first screen", { timeout: 120_000 });
      if (/sign in to dusk bot/i.test(await flow.text())) throw new Error("the app asked for an account before anything else");
      return `account: ${(await flow.accountState().catch(() => null))?.status ?? "none"}`;
    }
    await flow.waitText(/sign in to dusk bot/i, "the account gate", { timeout: 120_000 });
    await shots("account-gate");
    const providers = await flow.evaluate(`[...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /^continue with/i.test(t))`);
    flow.facts.gateProviders = providers;
    return providers.join(", ");
  }, { critical: true });

  if (gate) await flow.step("sign-in", "signs in with an emailed code (sink address)", () => flow.signInAtGate(), { critical: true });

  await flow.step("hello", "the hello, with Get started", async () => {
    await flow.waitText(/meet dusk bot/i, "the hello", { timeout: 60_000 });
    funnelStarted.at = Date.now();
    screens.push(await at());
    await shots("welcome");
    await flow.click("get started");
    return await funnelText();
  }, { critical: true });

  await flow.step("ai-choice", "one AI choice: the AI signed in here, free models, or a plan", async () => {
    await flow.waitFor(`document.querySelector("[data-welcome]")?.dataset.welcome === "ai"`, "the AI choice", 30_000);
    screens.push(await at());
    // the AI signed in here is offered once its test message answered
    await flow.waitFor(`!document.querySelector("[data-funnel-own][disabled]")`, "the AI here to be checked", 30_000).catch(() => {});
    await shots("ai");
    const own = await flow.evaluate(`document.querySelector("[data-funnel-own]")?.innerText.replace(/\\s+/g, " ") ?? null`);
    flow.facts.ownOffered = own;
    const tiles = await flow.evaluate(`["own", "free", "plan"].filter((k) => document.querySelector("[data-funnel-" + k + "]"))`);
    if (!tiles.includes("free") || !tiles.includes("plan")) throw new Error(`the choice is missing a way on: ${JSON.stringify(tiles)}`);
    return `${await funnelText()} | ${tiles.join(", ")}${own ? ` | ${own}` : ""}`;
  }, { critical: true });

  if (flag("--tour")) await flow.step("ai-plans", "opens Use my plan, an AI's card and the full list, then goes back to the choice", async () => {
    await flow.clickSelector("[data-funnel-plan]");
    await flow.waitText(/connect an AI/i, "the plan grid");
    await walkthrough.capture("app");
    await shots("ai-plan");
    const card = await flow.evaluate(`(() => { const b = [...document.querySelectorAll("button[data-funnel-ai]")].find((e) => e.getClientRects().length); if (!b) return null; b.click(); return b.getAttribute("data-funnel-ai"); })()`);
    if (card) {
      walkthrough.did(`clicks the ${card} card`);
      await sleep(2000);
      await walkthrough.capture("app");
      await flow.evaluate(`document.querySelector('button[data-funnel-ai][aria-pressed="true"]')?.click(); true`);
      await sleep(800);
    }
    const more = await flow.clickSelector("[data-ai-more]", 5_000).then(() => true, () => false);
    if (more) {
      await flow.waitFor(`Boolean(document.querySelector("[data-connect-ai]"))`, "the list of AIs", 10_000).catch(() => {});
      await sleep(1500);
      await walkthrough.capture("app");
      await flow.escape();
      await sleep(1000);
    }
    await flow.clickSelector("[data-funnel-choices]");
    await flow.waitFor(`Boolean(document.querySelector("[data-funnel-free]"))`, "back on the choice", 10_000);
    return `opened the plan grid${card ? `, ${card}` : ""}${more ? " and the full list" : ""}`;
  });

  await flow.step("ai-free", "free models go on to the chat at once", async () => {
    await flow.clickSelector("[data-funnel-free]");
    await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]')) || Boolean(document.querySelector("[data-welcome]:not([data-welcome=ai])"))`, "the chat", 60_000);
    const extra = await at();
    if (extra) {
      screens.push(extra);
      flow.friction("extra-click", extra, `a ${extra} screen after the AI choice; the run should end in the chat`);
      throw new Error(`the run went on to ${extra} instead of the chat`);
    }
    flow.facts.screens = screens;
    flow.facts.funnelSeconds = Math.round((Date.now() - funnelStarted.at) / 1000);
    return `${screens.length} screens (${screens.join(", ")}) in ${flow.facts.funnelSeconds}s`;
  }, { critical: true });

  await flow.step("first-message", "Dusk speaks first: one message, What should we start with?, three first jobs and the chips", async () => {
    await flow.waitText(/what should we start with/i, "Dusk's starter card", { timeout: 30_000 });
    await sleep(1200);
    await shots("chat");
    const starters = await flow.evaluate(`[...document.querySelectorAll("[data-helper-start] [data-helper-ask], [data-helper-start] button")].filter((b) => b.getClientRects().length).map((b) => b.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 8)`);
    flow.facts.starters = starters;
    const preview = await flow.evaluate(`[...document.querySelectorAll("nav, aside")].map((e) => e.innerText).join(" ").replace(/\\s+/g, " ")`);
    if (/I'm new here/i.test(preview)) flow.friction("confusing", "sidebar", "the sidebar quotes an older intro than the chat shows");
    return starters.join(" | ");
  });

  if (path === "server") {
    await flow.step("server", "your own server", async () => { throw flow.skip("your own server is no longer in the first run; add-server.mjs covers it"); });
    return;
  }

  if (path === "cloud") {
    await flow.step("try-cloud", "the chat's Try cloud chip opens dusk cloud", async () => {
      await flow.clickSelector("[data-helper-step=cloud]");
      await sleep(2500);
      await shots("try-cloud");
      const opened = await flow.evaluate(`[...document.querySelectorAll("[role=dialog] h2, [data-add-cloud-flow]")].filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-add-cloud-flow") ?? e.innerText.trim()).join(" / ")`);
      if (!opened) throw new Error("Try cloud opened nothing");
      flow.facts.cloudOpened = opened;
      return `${opened} (buying it is buy-cloud.mjs)`;
    });
    return;
  }

  await flow.step("first-reply", "the first bot answers on this Mac", () => firstReply("this Mac"));

  await flow.step("account-menu", gate ? "the account menu knows who is signed in" : "nothing asked for an account on this Mac", async () => {
    const state = await flow.accountState();
    flow.facts.account = { status: state?.status, email: state?.account?.email, plan: state?.entitlement?.plan };
    if (gate && state?.status !== "connected") throw new Error(`the app's account is ${state?.status}`);
    if (!gate && state?.status === "connected") throw new Error("the app signed in although nothing needed an account");
    return gate ? `${state.account.email}, ${state.entitlement?.plan ?? "no"} plan` : `account: ${state?.status ?? "none"}; the bots worked without one`;
  });
});
