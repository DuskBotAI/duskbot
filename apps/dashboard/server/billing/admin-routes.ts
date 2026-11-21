import type { IncomingMessage, ServerResponse } from "node:http";
import type { Cart } from "../../../../shared/billing-api.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { CloudError, paidCloud } from "../clouds/service.ts";
import type { AccountRef } from "./types.ts";
import type { BillingContext } from "./index.ts";
import { BillingError } from "./service.ts";
import { body, cloudName, color, invalid, json, object, optionalText, rawBody, survey, text } from "./http.ts";
import { AI_STASH_TTL_MS, parseAiSignIns } from "../clouds/ai-stash.ts";

/** what a wake request may name to wake a sleeping desktop; anything else (open, view) leaves it asleep */
export const WAKE_INTENTS = ["type", "click", "send", "connector", "routine"];

export function createAdminRoutes(ctx: BillingContext) {
  const { service, clouds, config, now } = ctx;
  const confirmations = new Map<string, { accountId: string; plan: string; subscriptionId: string; expiresAt: number }>();
  function available() { if (!(ctx.appRoutes ?? ctx.enabled)) throw new BillingError(503, "unavailable"); }
  function bundleCart(plan: unknown, interval: unknown): Cart {
    const bundle = config.bundles.find(b => b.id === plan && b.id !== "free");
    if (!bundle || (interval !== "month" && interval !== "year")) invalid();
    const cart: Cart = structuredClone({ ...bundle.cart, interval });
    if (cart.desktop.kind !== "none") cart.desktop.region = config.defaultRegion;
    return cart;
  }
  /** the plans the app sells; `trialDays` on each while a first plan starts free (the app reads it per plan) */
  function publicConfig(trialDays: number | null = service.trialDays(null)) {
    const catalog = service.catalog();
    return { cloudContractVersion: 1, plans: catalog.bundles.filter(b => b.id !== "free").map(bundle => {
      const kind = bundle.cart.desktop.kind;
      if (kind === "none") throw new Error("Bundle desktop missing.");
      const desktop = config.desktops[kind], spec = bundle.cart.desktop.spec ?? desktop.machine;
      const license = bundle.cart.license.kind === "team" ? config.licenses.team : null;
      return { tier: bundle.id, label: bundle.label, price: { currency: "USD", interval: "month", amount: bundle.monthlyCents }, ...(trialDays ? { trialDays } : {}),
        allowances: { cpus: spec.vcpu, memoryMb: spec.ramGb * 1024, diskGb: spec.diskGb, maxDiskGb: kind === "dedicated" ? config.dedicated.diskGb.max : spec.diskGb,
          computers: desktop.botComputers ?? 0, ...config.appAllowances[kind], ...(desktop.priority ? {} : { sleeps: true as const }),
          ...(license ? { seats: license.maxMembers, includedSeats: license.includedMembers, ...(license.extraMemberCents ? { extraSeatCents: license.extraMemberCents } : {}) } : {}) } };
    }) };
  }
  function openCheckout(account: AccountRef) { return ctx.store.state.checkouts.find(c => c.accountId === account.id && c.kind === "cart" && c.status === "open" && c.openUntil > now()); }
  /** the account's clouds, less the ones a checkout reserved: unpaid they are never shown, paid they show as setting up */
  const listed = (account: AccountRef) => clouds.list(account.id).filter(paidCloud);
  function primary(account: AccountRef) {
    const list = listed(account), id = service.appState(account).primary?.cloudId;
    return list.find(c => c.id === id) ?? list.find(c => c.primary) ?? null;
  }
  function requireCloud(account: AccountRef, id?: string): StoredCloud {
    const cloud = id === undefined ? primary(account) : clouds.owned(account.id, id);
    if (!cloud) throw new BillingError(404, "not_found"); return cloud;
  }
  function subscription(account: AccountRef) {
    const sub = service.subscriptions(account.id).find(s => s.status !== "ended" && s.status !== "pending");
    if (!sub) throw new BillingError(409, "not_subscribed"); return sub;
  }
  /** a managed cloud desktop sleeps when idle: Ready, with the power the app wakes it through (contract v1, `cloud.power`) */
  /** the app shows a managed cloud desktop only with a token that verifies offline for it (electron/entitlement.mjs) */
  function entitlementOf(c: StoredCloud): { entitlement?: string } {
    const token = clouds.entitlement?.(c) ?? null;
    return token ? { entitlement: token } : {};
  }
  function managedPower(c: StoredCloud) {
    if (!c.backend || !c.origin || !["running", "sleeping"].includes(c.status) || c.ended) return null;
    const state = c.status === "running" ? "awake" : c.wantPower === "on" ? "waking" : "asleep";
    return { state, since: c.powerSince, sleeps: true as const };
  }
  function cloudEntry(account: AccountRef, c: StoredCloud) {
    const view = clouds.view(c), sub = service.subscriptions(account.id).find(s => s.id === c.subscriptionId);
    const isPrimary = primary(account)?.id === c.id, power = managedPower(c);
    const ended = ["destroyed", "destroying", "error"].includes(view.status) || sub?.status === "ended" && !c.review;
    // a failed charge stops it: the app shows why, and its one way back, instead of opening it
    const owing = sub?.status === "payment_problem" && sub.fixBy !== undefined && !c.review;
    const status = ended ? "ended" : owing ? "payment_problem" : power ? "ready" : view.status === "provisioning" ? "setting_up" : view.status === "running" ? "ready" : ["sleeping", "suspended"].includes(view.status) ? "stopped" : view.status;
    const tier = sub?.bundle ?? config.bundles.find(b => b.cart.desktop.kind === c.kind)?.id ?? "custom";
    const runs = sub && sub.status !== "ended" && sub.status !== "pending" && sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now();
    return { id: c.id, name: c.name, color: c.color, role: "owner", tier, runsOn: "cloud", status, origin: c.origin, teamId: null, primary: isPrimary, managed: true,
      ...(c.backend ? { provider: "managed" } : {}), ...(power ? { power } : {}), ...entitlementOf(c),
      ...(status === "setting_up" ? { setup: { step: c.setupStep ?? "reserving", progress: ({ reserving: 0.15, storage: 0.4, starting: 0.65, checking: 0.9 })[c.setupStep ?? "reserving"] } } : {}),
      ...(view.lastReportAt === null ? {} : { lastSeenAt: view.lastReportAt }),
      ...(["stopped", "ended"].includes(status) && c.destroyAt !== null ? { deleteAfter: c.destroyAt } : {}),
      removable: status === "ended" || status === "checkout",
      ...(isPrimary && runs ? { renewal: { trial: sub.trialEndsAt !== undefined, endsAt: sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null, keptDays: config.graceDays } } : {}),
      ...(owing ? { payment: { fixBy: sub!.fixBy!, ...(sub!.trialUnpaid ? { trial: true } : {}) } } : {}),
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false, renewsAt: sub?.currentPeriodEnd ?? null };
  }
  /** `moves`: the app may move this computer's (or a server's) bots into this ready Cloud by itself; only its owner's */
  function machineSummary(c: StoredCloud, own: boolean) {
    const view = clouds.view(c), sub = service.subscriptions(c.accountId).find(s => s.id === c.subscriptionId);
    const owing = sub?.status === "payment_problem" && sub.fixBy !== undefined && !c.review, power = owing ? null : managedPower(c);
    const state = owing ? "payment_problem" : power ? "ready" : view.status === "provisioning" ? "setting_up" : view.status === "running" ? "ready" : view.status === "payment_problem" ? "payment_problem" : view.status === "error" ? "failed" : "stopped";
    return { state, ...(state === "ready" ? { origin: c.origin, ...(own ? { moves: true } : {}) } : {}), ...(power ? { power } : {}), ...(state === "setting_up" ? { setup: { step: c.setupStep ?? "reserving" } } : {}),
      disk: { gb: c.spec.diskGb, maxGb: c.placement === "dedicated" ? config.dedicated.diskGb.max : c.spec.diskGb } };
  }
  function sessionFields(account: AccountRef): Record<string, unknown> {
    available();
    const state = service.appState(account), c = primary(account), list = listed(account);
    const active = state.entitlement.status === "active";
    // an unpaid checkout never blocks: a new one replaces it (and frees the cloud it held)
    const open = openCheckout(account), blocked = open && !open.url ? "checkout_open" : clouds.list(account.id, true).filter(c => c.status !== "destroyed" && c.id !== open?.cloudId).length >= config.maxCloudsPerAccount ? "cap" : null;
    const summary = c && c.status !== "checkout" ? machineSummary(c, true) : undefined;
    const team = ctx.teams.membership(account), teams = team && team.role === "member" ? [{ id: team.cloud.id, name: team.team, role: "member", machine: machineSummary(team.cloud, false) }] : [];
    const openPlan = open?.cart ? service.quote(open.cart).bundle : null;
    return { entitlement: active ? state.entitlement : { plan: "free", status: "inactive", expiresAt: null, version: state.entitlement.version },
      ...(summary ? { cloud: summary } : {}), teams, clouds: list.map(c => cloudEntry(account, c)).sort((a, b) => Number(b.primary) - Number(a.primary)), canAdd: !blocked, ...(blocked ? { addBlocked: blocked } : {}),
      ...(!active ? { offer: { plans: publicConfig(service.trialDays(account)).plans, recommended: "pro", ...(open && openPlan ? { checkout: { plan: openPlan, openUntil: open.openUntil } } : {}) } } : {}), license: service.licenseCheck(account) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname, method = req.method ?? "GET";
    if (path === "/api/public/config" && method === "GET") { json(res, 200, publicConfig()); return true; }
    if (!path.startsWith("/api/cloud/desktop/")) return false;
    const route = path.slice("/api/cloud/desktop/".length);
    // identity, devices and the session belong to the accounts service
    if (!/^(?:license|checkout|clouds|clouds\/[^/]+(?:\/(?:hide|cancel|keep|ai-signins))?|feedback|upgrade|upgrade\/preview|pairing|teams\/[^/]+\/pairing|wake|resize-now|moved-to|backup)$/.test(route)) return false;
    try {
      const match = /^Bearer (omc_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
      const account = match ? await ctx.accounts.fromBearer(req) : null;
      if (!account) { json(res, 401, { error: "invalid_token" }); return true; }
      available();
      const send = (value: object) => { json(res, 200, { ...value, cloudContractVersion: 1 }); return true; };
      if (route === "license" && method === "GET") return send(service.licenseCheck(account));
      const held = /^clouds\/([^/]+)\/ai-signins$/.exec(route);
      if (held) {
        // the request carries sign-ins: never log it, its body or its answer
        const cloud = requireCloud(account, held[1]);
        if (!clouds.holdSignIns || !clouds.dropSignIns) throw new BillingError(503, "unavailable");
        if (method === "DELETE") { await clouds.dropSignIns(account.id, cloud.id); return send({ ok: true }); }
        if (method !== "POST") throw new BillingError(404, "not_found");
        const raw = (await rawBody(req, 96 * 1024)).toString("utf8");
        let parsed: unknown;
        try { parsed = JSON.parse(raw || "{}"); } catch { invalid(); }
        const items = parseAiSignIns(object(parsed).items);
        if (!items) invalid();
        await clouds.holdSignIns(account.id, cloud.id, items);
        return send({ ok: true, expiresInMs: AI_STASH_TTL_MS });
      }
      const cloudRoute = /^clouds\/([^/]+)(?:\/(hide|cancel|keep))?$/.exec(route);
      if (cloudRoute && (method === "POST" || method === "PATCH")) {
        const cloud = requireCloud(account, cloudRoute[1]), data = await body(req);
        if (!cloudRoute[2] && method === "PATCH") { clouds.rename(account.id, cloud.id, { color: color(data.color) }); return send({ ok: true }); }
        if (method === "POST" && cloudRoute[2] === "hide") {
          if (!cloudEntry(account, cloud).removable) throw new CloudError(409, "not_removable");
          clouds.hide(account.id, cloud.id); return send({ ok: true });
        }
        if (method === "POST" && ["cancel", "keep"].includes(cloudRoute[2])) {
          const sub = service.subscriptions(account.id).find(s => s.cloudId === cloud.id);
          if (!sub) throw new BillingError(409, "not_subscribed");
          if (cloudRoute[2] === "cancel") { await service.cancel(account, sub.id); return send({ cloud: cloudEntry(account, cloud) }); }
          await service.keep(account, sub.id); return send({ ok: true });
        }
        throw new BillingError(404, "not_found");
      }
      if (method !== "POST") throw new BillingError(404, "not_found");
      const data = await body(req);
      if (!ctx.checkoutOpen && ["checkout", "clouds", "upgrade", "upgrade/preview"].includes(route)) throw new BillingError(503, "checkout_soon");
      if (route === "checkout" || route === "clouds") {
        const add = route === "clouds", cart = bundleCart(add ? data.tier : data.plan, add ? data.interval : "month");
        const source = add ? optionalText(data.source) : text(data.source);
        if (add && service.licenseCheck(account).license?.status === "active") cart.license = { kind: "none" };
        if (!add && service.subscriptions(account.id).some(s => s.status !== "ended")) throw new BillingError(409, "already_subscribed");
        const name = add ? cloudName(data.name) : undefined;
        const swatch = !add || data.color === undefined ? null : color(data.color);
        const answer = await service.checkout(account, { kind: "cart", cart, ...(name ? { name } : {}), ...(swatch ? { color: swatch } : {}) }, { source });
        return send(add ? { cloudId: answer.cloudId, checkoutUrl: answer.checkoutUrl } : { url: answer.checkoutUrl });
      }
      if (route === "feedback") {
        service.feedback(account, { cloudId: text(data.cloudId), survey: survey(data) }); return send({ ok: true });
      }
      if (route === "upgrade/preview" || route === "upgrade") {
        if (data.plan === "personal" || data.plan === "max") throw new BillingError(409, "plan_change_unavailable");
        if (data.plan !== "starter" && data.plan !== "pro") invalid();
        text(data.source);
        const sub = subscription(account), cart = bundleCart(data.plan, sub.cart.interval);
        if (route === "upgrade/preview") {
          const preview = await service.previewChange(account, sub.id, cart);
          // the app sells upgrades; a smaller plan is switched on the plans page, where its date is shown
          if (preview.timing === "scheduled" || preview.timing === "undo") throw new BillingError(409, "plan_change_unavailable");
          for (const [key, value] of confirmations) if (value.expiresAt <= now() || value.accountId === account.id) confirmations.delete(key);
          confirmations.set(preview.confirmation, { accountId: account.id, plan: data.plan, subscriptionId: sub.id, expiresAt: preview.expiresAt });
          return send({ tier: data.plan, from: sub.bundle ?? "custom", price: preview.quote.totalCents, chargeNow: preview.chargeNowCents, tax: preview.taxCents, currency: "USD", trial: preview.timing === "trial",
            confirmation: preview.confirmation, expiresAt: preview.expiresAt, nextBillingAt: preview.nextChargeAt });
        }
        const token = text(data.confirmation), confirmation = confirmations.get(token);
        if (!confirmation || confirmation.accountId !== account.id || confirmation.subscriptionId !== sub.id || confirmation.plan !== data.plan || confirmation.expiresAt <= now()) throw new BillingError(409, "confirmation_required");
        confirmations.delete(token);
        const changed = (await service.change(account, sub.id, token)).subscription;
        return send({ status: changed.bundle === data.plan ? "upgraded" : "pending", tier: changed.bundle ?? "custom" });
      }
      if (route === "pairing") {
        const cloud = requireCloud(account, optionalText(data.cloudId));
        if (cloud.status !== "running" || !cloud.origin || cloud.suspended !== null) throw new CloudError(409, "not_running");
        return send(await clouds.pair(account.id, cloud.id, account.email));
      }
      const teamPairing = /^teams\/([^/]+)\/pairing$/.exec(route);
      if (teamPairing) {
        // security: signed only for a current member; the app reads 404 as "no longer in this team"
        const team = ctx.teams.membership(account);
        if (!team || team.cloud.id !== teamPairing[1]) throw new BillingError(404, "not_found");
        if (team.cloud.status !== "running" || !team.cloud.origin || team.cloud.suspended !== null) throw new CloudError(409, "not_running");
        return send(await clouds.pairMember(team.cloud.id, { email: account.email.trim().toLowerCase(), role: team.role }));
      }
      if (route === "wake" || route === "resize-now") {
        const cloud = requireCloud(account);
        if (route === "wake") {
          // only real intent wakes (a key press or click in a bot, a send, a connector event, a routine); opening the app or
          // viewing chats does not, and the app shows its cached chats meanwhile. An app that names no intent is an older one.
          const intent = optionalText(data.intent);
          if (intent !== undefined && !WAKE_INTENTS.includes(intent) && cloud.status !== "running") return send({ state: "asleep", wakesOn: "intent" });
          if (["stopped", "sleeping"].includes(cloud.status)) await clouds.power(account.id, cloud.id, "on");
          return send({ state: cloud.status === "running" ? "awake" : "waking" });
        }
        if (cloud.backend && clouds.managed) { clouds.managed.resizeNow(cloud); await clouds.reconcile(); return send({ state: clouds.managed.resizing(cloud) ? "restarting" : "current" }); }
        await clouds.reconcile();
        return send({ state: Object.keys(cloud.spec).every(k => cloud.spec[k as keyof typeof cloud.spec] === cloud.desiredSpec[k as keyof typeof cloud.spec]) ? "current" : "restarting" });
      }
      if (route === "backup") {
        // the owner's app, once its move into this cloud was checked: one backup now, beside the schedule's
        const origin = text(data.origin);
        const cloud = listed(account).find(c => c.origin === origin);
        if (!cloud) throw new BillingError(404, "not_found");
        if (!cloud.backend || !clouds.managed?.backupNow || cloud.status !== "running") return send({ state: "not_managed" });
        void clouds.managed.backupNow(cloud).catch((error: unknown) => console.warn(`clouds: a backup after a move failed for ${cloud.id}: ${error instanceof Error ? error.message : "error"}`));
        return send({ state: "started" });
      }
      if (route === "moved-to") {
        const origin = text(data.origin);
        try { const url = new URL(origin); if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password) invalid(); } catch { invalid(); }
        const cloud = clouds.list(account.id).find(c => c.origin === origin || c.destroyedOrigin === origin);
        return send({ state: !cloud ? "unknown" : cloud.status === "destroyed" ? "deleted" : ["destroying", "stopped", "error"].includes(cloud.status) ? "ended" : "live" });
      }
      throw new BillingError(404, "not_found");
    } catch (error) {
      const known = error instanceof BillingError || error instanceof CloudError, code = known ? error.code : "failed";
      const blocked = route === "clouds" ? code === "rate_limited" ? "rate" : ["checkout_open", "cap"].includes(code) ? code : null : null;
      json(res, known ? error.status : 500, { error: code, ...(blocked ? { addBlocked: blocked } : {}), ...(error instanceof BillingError && error.url ? { checkoutUrl: error.url } : {}) });
      return true;
    }
  }
  return { handle, sessionFields };
}
