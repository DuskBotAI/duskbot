import {
  asRecord,
  budgetLine,
  closedWindow,
  currencyCode,
  currencyDigits,
  extraLine,
  isoOrNull,
  naturalNumber,
  numericValue,
  openWindow,
  planLabel,
  timeMs,
  titleWords,
  type PlanExtra,
  type PlanModelUsage,
  type PlanWindow,
  type PlanWindows,
} from "./plan-usage-types.ts";

const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];
const MONTHLY_SPEND = "Monthly spend";
const EXTRA_USAGE = "Extra Usage";

const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;
const WEEK_MS = 7 * 86_400_000;

export const antigravityWeeklyResets = new Set<number>();

export function parseClaudeUsage(body: unknown, fallbackPlan: string | null = null): PlanWindows {
  const root = claudeRoot(body);
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let parsedFromLimits = false;

  if (root && Array.isArray(root.limits)) {
    for (const item of root.limits) {
      const entry = asRecord(item);
      if (!entry) continue;
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
      const percent = numericValue(entry.percent);
      if (!kind || percent == null) continue;
      const resetsAt = isoOrNull(entry.resets_at ?? entry.resetsAt);
      const window = openWindow(percent, resetsAt);
      const group = typeof entry.group === "string" ? entry.group.trim().toLowerCase() : "";
      parsedFromLimits = true;
      if (kind === "session") {
        if (!fiveHour.available) fiveHour = window;
      } else if (kind === "weekly_all") {
        if (!weekly.available) weekly = window;
      } else {
        const scope = asRecord(entry.scope);
        const model = asRecord(scope?.model);
        const displayName = planLabel(model?.display_name ?? model?.displayName);
        if (displayName) {
          const label = group === "session" ? "5-hour" : group === "daily" ? "Daily" : "Weekly";
          addModelWindow(models, displayName, extraLine(label, window));
        } else {
          extra.push(extraLine(titleWords(kind), window));
        }
      }
    }
  }

  if (root && !parsedFromLimits) {
    for (const [key, value] of Object.entries(root)) {
      if (key === "five_hour" || key === "seven_day" || key === "spend" || key === "extra_usage" || key === "limits") continue;
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
      const window = readClaudeWindow(value);
      if (!window) continue;
      const model = claudeModelWindow(key);
      if (model) addModelWindow(models, model.name, extraLine(model.window, window));
      else extra.push(extraLine(claudeExtraLabel(key), window));
    }
  }

  if (!fiveHour.available && root) fiveHour = readClaudeWindow(root.five_hour) ?? closedWindow();
  if (!weekly.available && root) weekly = readClaudeWindow(root.seven_day) ?? closedWindow();
  sortModelWindows(models);
  const budget = root && readClaudeBudget(root, fiveHour.available || weekly.available);
  if (budget) extra.unshift(budget);
  return {
    plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type) ?? fallbackPlan,
    fiveHour,
    weekly,
    extra,
    models,
  };
}

export function parseCodexUsage(body: unknown, now = Date.now()): PlanWindows {
  const root = asRecord(body);
  const assigned = assignDurationWindows(durationWindows(root?.rate_limit, now));
  const models: PlanModelUsage[] = [];
  const extra = [...assigned.extra];
  if (root) collectCodexNamedLimits(root, models, extra, now);
  sortModelWindows(models);
  return { ...assigned, extra, models, plan: planLabel(root?.plan_type ?? root?.plan) };
}

export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let sawMonthly = false;
  const place = (sample: GrokSample | null) => {
    if (!sample) return;
    const window = openWindow(sample.used, sample.resetsAt);
    if (sample.slot === "fiveHour") {
      if (!fiveHour.available) fiveHour = window;
    } else if (sample.slot === "weekly") {
      if (!weekly.available) weekly = window;
    } else if (sample.slot === "monthly") {
      if (!sawMonthly) {
        sawMonthly = true;
        extra.push(extraLine("Monthly", window));
      }
    } else {
      extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
    }
  };
  // Protobuf omits zero fields, so a credits reply with currentPeriod and no creditUsagePercent means 0% used.
  const creditSample = readGrokSample(credits, true);
  place(creditSample);
  const productSample = creditSample ?? { used: 0, slot: "other" as const, resetsAt: null, seconds: null };
  for (const model of readGrokProducts(credits, productSample)) addModelWindow(models, model.name, model.window);
  if (billing !== undefined) place(readGrokSample(billing, false));
  sortModelWindows(models);
  return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}

interface AntigravityBucket {
  id: "gemini-5h" | "gemini-weekly" | "3p-5h" | "3p-weekly" | "argon-weekly";
  used: number;
  remaining: number;
  resetsAt: string | null;
}

export function parseAntigravitySummary(bodies: readonly unknown[]): PlanWindows | null {
  const found = new Map<AntigravityBucket["id"], AntigravityBucket>();
  const recordBucket = (id: AntigravityBucket["id"], left: number, resetsAt: string | null) => {
    const existing = found.get(id);
    if (existing && !(existing.remaining >= 1 && left < 1)) return;
    found.set(id, { id, used: Math.round((1 - left) * 100), remaining: left, resetsAt });
  };
  for (const rawBody of bodies) {
    const body = asRecord(rawBody);
    const groups = Array.isArray(body?.groups) ? body.groups : [];
    for (const rawGroup of groups) {
      const group = asRecord(rawGroup);
      if (!group) continue;
      const isArgon = group.displayName === "Gemini 4 Argon";
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const rawBucket of buckets) {
        const bucket = asRecord(rawBucket);
        if (!bucket || bucket.disabled === true) continue;
        const rawLeft = numericValue(bucket.remainingFraction);
        if (rawLeft == null) continue;
        const left = Math.min(Math.max(rawLeft, 0), 1);
        const resetsAt = isoOrNull(bucket.resetTime);
        if (isArgon) {
          if (bucket.window === "weekly") recordBucket("argon-weekly", left, resetsAt);
        } else if (
          bucket.bucketId === "gemini-5h" ||
          bucket.bucketId === "gemini-weekly" ||
          bucket.bucketId === "3p-5h" ||
          bucket.bucketId === "3p-weekly"
        ) {
          recordBucket(bucket.bucketId, left, resetsAt);
        }
      }
    }
  }
  if (!found.size) return null;
  return antigravityWindowsFromBuckets(found, null);
}

export function parseAntigravityModels(
  modelsNode: unknown,
  now = Date.now(),
  rememberedWeekly: ReadonlySet<number> = antigravityWeeklyResets,
): PlanWindows | null {
  const modelsRecord = asRecord(modelsNode);
  if (!modelsRecord) return null;
  const found = new Map<AntigravityBucket["id"], AntigravityBucket>();
  for (const [key, rawModel] of Object.entries(modelsRecord)) {
    const model = asRecord(rawModel);
    if (!model || model.isInternal === true) continue;
    const name = typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : typeof model.label === "string" && model.label.trim() ? model.label.trim() : "";
    const quota = asRecord(model.quotaInfo);
    if (!name || !quota) continue;
    if (name.toLowerCase().includes("argon") || key.toLowerCase().includes("argon")) continue;
    // Protobuf omits zero remainingFraction, so a quotaInfo block without remainingFraction is 100% used.
    const left = Math.min(Math.max(numericValue(quota.remainingFraction) ?? 0, 0), 1);
    const resetMs = timeMs(quota.resetTime);
    const resetsAt = resetMs != null ? new Date(resetMs).toISOString() : null;
    const weekly = resetMs != null && (resetMs - now > 5 * 3600_000 + 600_000 || rememberedWeekly.has(resetMs));
    const gemini = name.toLowerCase().includes("gemini");
    const id: AntigravityBucket["id"] = gemini
      ? (weekly ? "gemini-weekly" : "gemini-5h")
      : (weekly ? "3p-weekly" : "3p-5h");
    const used = Math.round((1 - left) * 100);
    const existing = found.get(id);
    if (existing && existing.used >= used) continue;
    found.set(id, { id, used, remaining: left, resetsAt });
  }
  if (!found.size) return null;
  return antigravityWindowsFromBuckets(found, null);
}

export function parseAntigravityPlan(body: unknown): string | null {
  const root = asRecord(body);
  if (!root) return null;
  const known: Record<string, string> = {
    "g1-pro-tier": "Pro",
    "g1-ultra-tier": "Ultra",
    "g1-ultra-lite-tier": "Ultra Lite",
    "free-tier": "Free",
  };
  const paid = asRecord(root.paidTier);
  const current = asRecord(root.currentTier);
  for (const tier of [paid, current]) {
    const id = typeof tier?.id === "string" ? tier.id.trim() : "";
    if (id && known[id]) return known[id];
  }
  const rawName = typeof paid?.name === "string" && paid.name.trim()
    ? paid.name.trim()
    : typeof current?.name === "string" && current.name.trim() ? current.name.trim() : "";
  if (!rawName) return null;
  return planLabel(rawName.startsWith("Google AI ") ? rawName.slice("Google AI ".length) : rawName);
}

function antigravityWindowsFromBuckets(
  buckets: ReadonlyMap<AntigravityBucket["id"], AntigravityBucket>,
  plan: string | null,
): PlanWindows {
  const asWindow = (bucket: AntigravityBucket | undefined) => bucket ? openWindow(bucket.used, bucket.resetsAt) : closedWindow();
  const hasGemini = buckets.has("gemini-5h") || buckets.has("gemini-weekly");
  const has3p = buckets.has("3p-5h") || buckets.has("3p-weekly");
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const models: PlanModelUsage[] = [];

  if (hasGemini) {
    fiveHour = asWindow(buckets.get("gemini-5h"));
    weekly = asWindow(buckets.get("gemini-weekly"));
    const thirdParty5h = buckets.get("3p-5h");
    const thirdPartyWeekly = buckets.get("3p-weekly");
    if (thirdParty5h) addModelWindow(models, "Claude & GPT", extraLine("5-hour", openWindow(thirdParty5h.used, thirdParty5h.resetsAt)));
    if (thirdPartyWeekly) addModelWindow(models, "Claude & GPT", extraLine("Weekly", openWindow(thirdPartyWeekly.used, thirdPartyWeekly.resetsAt)));
  } else if (has3p) {
    fiveHour = asWindow(buckets.get("3p-5h"));
    weekly = asWindow(buckets.get("3p-weekly"));
  } else if (buckets.has("argon-weekly")) {
    weekly = asWindow(buckets.get("argon-weekly"));
  }

  const argon = buckets.get("argon-weekly");
  if (argon && (hasGemini || has3p)) {
    addModelWindow(models, "Gemini 4 Argon", extraLine("Weekly", openWindow(argon.used, argon.resetsAt)));
  }
  sortModelWindows(models);
  return { plan, fiveHour, weekly, extra: [], models };
}

export function parseCursorUsage(
  usageBody: unknown,
  planInfoBody?: unknown,
  options: { planHint?: string | null; rememberedNow?: number | null } = {},
): PlanWindows {
  const usage = asRecord(usageBody);
  const planInfo = asRecord(asRecord(planInfoBody)?.planInfo) ?? asRecord(planInfoBody);
  const plan = planLabel(planInfo?.planName) ?? options.planHint ?? null;
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  if (!usage) return { plan, fiveHour: closedWindow(), weekly, extra, models };

  const cycleEnd = isoOrNull(usage.billingCycleEnd);
  const isWeekly = planInfo?.includedUsagePeriod === "INCLUDED_USAGE_PERIOD_WEEKLY";
  let includedReset = cycleEnd;
  if (isWeekly) {
    let resetMs = timeMs(planInfo?.includedUsageResetsAt);
    if (options.rememberedNow != null && resetMs != null && resetMs <= options.rememberedNow) {
      const elapsedWeeks = Math.floor((options.rememberedNow - resetMs) / WEEK_MS) + 1;
      resetMs += elapsedWeeks * WEEK_MS;
    }
    includedReset = resetMs != null ? new Date(resetMs).toISOString() : null;
  }

  const planUsage = asRecord(usage.planUsage);
  if (planUsage) {
    const limit = numericValue(planUsage.limit);
    const remaining = numericValue(planUsage.remaining);
    const spent = numericValue(planUsage.totalSpend) ?? (limit != null && remaining != null ? limit - remaining : null);
    const percent = numericValue(planUsage.totalPercentUsed) ?? (spent != null && limit != null && limit > 0 ? (spent / limit) * 100 : null);
    if (percent != null) {
      const includedWindow = openWindow(percent, includedReset);
      if (isWeekly) weekly = includedWindow;
      else extra.push(extraLine("Monthly", includedWindow));
    }
    const auto = numericValue(planUsage.autoPercentUsed);
    const api = numericValue(planUsage.apiPercentUsed);
    if (auto != null && api != null && auto + api > 0) {
      const label = isWeekly ? "Weekly" : "Monthly";
      addModelWindow(models, "Cursor models", extraLine(label, openWindow(auto, includedReset)));
      addModelWindow(models, "Other models", extraLine(label, openWindow(api, includedReset)));
    }
  }

  const onDemand = asRecord(usage.spendLimitUsage);
  if (onDemand) {
    const individualLimit = numericValue(onDemand.individualLimit);
    const pooledLimit = numericValue(onDemand.pooledLimit);
    const individualUsed = numericValue(onDemand.individualUsed);
    const pooledUsed = numericValue(onDemand.pooledUsed);
    const totalSpend = numericValue(onDemand.totalSpend);
    const scope = individualLimit != null && individualLimit > 0
      ? { limit: individualLimit, used: individualUsed ?? totalSpend ?? 0 }
      : pooledLimit != null && pooledLimit > 0
        ? { limit: pooledLimit, used: pooledUsed ?? totalSpend ?? 0 }
        : null;
    if (scope) {
      const line = budgetLine("On-demand", {
        usedMinor: Math.max(0, Math.round(scope.used)),
        limitMinor: Math.round(scope.limit),
        currency: "USD",
        exponent: 2,
      });
      if (line) extra.push({ ...line, resetsAt: cycleEnd });
    }
  }

  return { plan, fiveHour: closedWindow(), weekly, extra, models };
}

export function parseCursorDashboardUsage(summaryBody: unknown, requestsBody: unknown): PlanWindows {
  const summary = asRecord(summaryBody);
  const requests = asRecord(requestsBody);
  const end = isoOrNull(summary?.billingCycleEnd);
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];

  const individual = asRecord(summary?.individualUsage);
  const plan = asRecord(individual?.plan);
  let hasMonthly = false;
  if (plan) {
    const total = numericValue(plan.totalPercentUsed);
    if (total != null) {
      hasMonthly = true;
      extra.push(extraLine("Monthly", openWindow(total, end)));
    }
    const auto = numericValue(plan.autoPercentUsed);
    const api = numericValue(plan.apiPercentUsed);
    if (auto != null && api != null && auto + api > 0) {
      addModelWindow(models, "Cursor models", extraLine("Monthly", openWindow(auto, end)));
      addModelWindow(models, "Other models", extraLine("Monthly", openWindow(api, end)));
    }
  }

  const gpt4 = asRecord(requests?.["gpt-4"]);
  const allowance = numericValue(gpt4?.maxRequestUsage);
  if (allowance != null && allowance > 0) {
    const used = Math.max(numericValue(gpt4?.numRequests) ?? 0, numericValue(gpt4?.numRequestsTotal) ?? 0);
    const monthStart = timeMs(requests?.startOfMonth);
    let requestReset = end;
    if (monthStart != null) {
      const date = new Date(monthStart);
      date.setUTCMonth(date.getUTCMonth() + 1);
      requestReset = date.toISOString();
    }
    extra.push(extraLine(hasMonthly ? "Requests" : "Monthly", openWindow((used / allowance) * 100, requestReset)));
  }

  const team = asRecord(summary?.teamUsage);
  for (const candidate of [asRecord(individual?.onDemand), asRecord(team?.onDemand)]) {
    if (!candidate || candidate.enabled === false) continue;
    const limit = numericValue(candidate.limit);
    if (limit == null || limit <= 0) continue;
    const usedRaw = numericValue(candidate.used);
    const remaining = numericValue(candidate.remaining);
    const used = usedRaw != null && usedRaw > 0 ? usedRaw : Math.max(0, limit - (remaining ?? limit));
    const line = budgetLine("On-demand", {
      usedMinor: Math.max(0, Math.round(used)),
      limitMinor: Math.round(limit),
      currency: "USD",
      exponent: 2,
    });
    if (line) extra.push({ ...line, resetsAt: end });
    break;
  }

  return { plan: null, fiveHour: closedWindow(), weekly: closedWindow(), extra, models };
}

export function parseOpenCodeUsage(body: unknown, now = Date.now()): PlanWindows {
  const usage = asRecord(asRecord(body)?.usage);
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  if (!usage) return { plan: "Go", fiveHour, weekly, extra, models: [] };

  const rolling = asRecord(usage.rolling);
  const rollingPercent = numericValue(rolling?.percent);
  if (rollingPercent != null) {
    const resetMs = timeMs(rolling?.resetsAt);
    // An idle OpenCode Go session reports a placeholder reset 5 hours ahead.
    const isIdlePlaceholder = rollingPercent === 0 && resetMs != null && Math.abs(resetMs - (now + 5 * 3600_000)) < 60_000;
    fiveHour = openWindow(rollingPercent, isIdlePlaceholder || resetMs == null ? null : new Date(resetMs).toISOString());
  }

  const weeklyNode = asRecord(usage.weekly);
  const weeklyPercent = numericValue(weeklyNode?.percent);
  if (weeklyPercent != null) weekly = openWindow(weeklyPercent, isoOrNull(weeklyNode?.resetsAt));

  const monthlyNode = asRecord(usage.monthly);
  const monthlyPercent = numericValue(monthlyNode?.percent);
  if (monthlyPercent != null) extra.push(extraLine("Monthly", openWindow(monthlyPercent, isoOrNull(monthlyNode?.resetsAt))));

  return { plan: "Go", fiveHour, weekly, extra, models: [] };
}

function claudeRoot(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  if ("five_hour" in root || "seven_day" in root || "limits" in root) return root;
  const nested = asRecord(root.usage) ?? asRecord(root.windows);
  if (nested && ("five_hour" in nested || "seven_day" in nested || "limits" in nested)) return nested;
  return root;
}

function readClaudeWindow(value: unknown): PlanWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = numericValue(record.utilization);
  if (utilization == null) return null;
  return openWindow(utilization, isoOrNull(record.resets_at ?? record.resetsAt));
}

function readSpendBudget(value: unknown): PlanExtra | null {
  const spend = asRecord(value);
  if (spend?.enabled !== true) return null;
  const used = asRecord(spend.used), limit = asRecord(spend.limit);
  const currency = currencyCode(used?.currency);
  const exponent = naturalNumber(used?.exponent), usedMinor = naturalNumber(used?.amount_minor), limitMinor = naturalNumber(limit?.amount_minor);
  if (!currency || currency !== currencyCode(limit?.currency) || exponent === null || exponent !== limit?.exponent || usedMinor === null || limitMinor === null) return null;
  return budgetLine(MONTHLY_SPEND, { usedMinor, limitMinor, currency, exponent });
}

/** Claude Code 2.1.312 documents `used_credits` and `monthly_limit` as minor units of `currency` ("cents for USD") and has
 * no field saying how many digits those are, so the currency says. `is_enabled` false: this budget cannot cover a send. */
function readExtraUsage(value: unknown, label: string): PlanExtra | null {
  const extra = asRecord(value);
  if (extra?.is_enabled !== true) return null;
  const currency = currencyCode(extra.currency);
  const usedMinor = naturalNumber(extra.used_credits), limitMinor = naturalNumber(extra.monthly_limit);
  if (currency && usedMinor !== null && limitMinor !== null) {
    const exponent = naturalNumber(extra.decimal_places) ?? currencyDigits(currency);
    const line = exponent === null ? null : budgetLine(label, { usedMinor, limitMinor, currency, exponent });
    if (line) return line;
  }
  const used = numericValue(extra.utilization);
  return used === null ? null : extraLine(label, openWindow(used, null));
}

/** A plan with no rolling windows lives on its monthly budget (Claude Enterprise); on others that budget is the extra usage
 * bought on top of them. */
function readClaudeBudget(root: Record<string, unknown>, hasWindows: boolean): PlanExtra | null {
  return readSpendBudget(root.spend) ?? readExtraUsage(root.extra_usage, hasWindows ? EXTRA_USAGE : MONTHLY_SPEND);
}

function claudeExtraLabel(key: string): string {
  const suffix = key.startsWith("seven_day_")
    ? key.slice("seven_day_".length)
    : key.replace(/^five_hour_/, "");
  return titleWords(suffix);
}

function claudeModelWindow(key: string): { name: string; window: string } | null {
  const weekly = key.startsWith("seven_day_");
  const fiveHour = key.startsWith("five_hour_");
  if (!weekly && !fiveHour) return null;
  const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
  const lower = suffix.toLowerCase();
  const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
  if (!family) return null;
  return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}

function addModelWindow(models: PlanModelUsage[], name: string, line: PlanExtra): void {
  const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
  if (found) found.windows.push(line);
  else models.push({ name, windows: [line] });
}

function sortModelWindows(models: PlanModelUsage[]): void {
  const rank = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
  for (const model of models) model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}

interface DurationWindow {
  used: number;
  seconds: number;
  resetsAt: string | null;
}

function readDurationWindow(value: unknown, now: number): DurationWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const used = numericValue(record.used_percent);
  let seconds = numericValue(record.limit_window_seconds);
  if (seconds == null) {
    const minutes = numericValue(record.window_minutes);
    if (minutes != null) seconds = minutes * 60;
  }
  if (used == null || seconds == null || seconds <= 0) return null;
  let resetsAt = isoOrNull(record.reset_at ?? record.resetAt);
  if (!resetsAt) {
    const after = numericValue(record.reset_after_seconds);
    if (after != null && after >= 0) resetsAt = new Date(now + after * 1000).toISOString();
  }
  return { used, seconds, resetsAt };
}

function durationWindows(node: unknown, now: number): DurationWindow[] {
  const record = asRecord(node);
  if (!record) return [];
  const source = asRecord(record.rate_limit) ?? record;
  const windows: DurationWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = readDurationWindow(source[key], now);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    const self = readDurationWindow(source, now);
    if (self) windows.push(self);
  }
  return windows;
}

function codexLimitName(record: Record<string, unknown>): string | null {
  return planLabel(record.limit_name) ?? planLabel(record.metered_feature) ?? planLabel(record.name);
}

function pushAssignedLines(assigned: PlanWindows, into: PlanExtra[]): void {
  if (assigned.fiveHour.available) into.push(extraLine("5-hour", assigned.fiveHour));
  if (assigned.weekly.available) into.push(extraLine("Weekly", assigned.weekly));
  into.push(...assigned.extra);
}

function collectCodexNamedLimits(root: Record<string, unknown>, models: PlanModelUsage[], extra: PlanExtra[], now: number): void {
  const buckets: Array<{ name: string | null; node: unknown }> = [];
  if (root.code_review_rate_limit) buckets.push({ name: "Code review", node: root.code_review_rate_limit });
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const record = asRecord(item);
      buckets.push({ name: record ? codexLimitName(record) : null, node: item });
    }
  } else {
    const named = asRecord(additional);
    if (named) {
      for (const [key, value] of Object.entries(named)) buckets.push({ name: planLabel(key), node: value });
    }
  }
  for (const bucket of buckets) {
    const assigned = assignDurationWindows(durationWindows(bucket.node, now));
    if (!bucket.name) {
      pushAssignedLines(assigned, extra);
      continue;
    }
    const lines: PlanExtra[] = [];
    pushAssignedLines(assigned, lines);
    for (const line of lines) addModelWindow(models, bucket.name, line);
  }
}

function readGrokProducts(body: unknown, sample: GrokSample): Array<{ name: string; window: PlanExtra }> {
  const root = asRecord(body);
  if (!root) return [];
  const config = asRecord(root.config) ?? root;
  if (!Array.isArray(config.productUsage)) return [];
  const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
  const rows: Array<{ name: string; window: PlanExtra }> = [];
  for (const item of config.productUsage) {
    const record = asRecord(item);
    if (!record) continue;
    const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
    const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = numericValue(record.usagePercent ?? record.usedPercent ?? record.utilization);
    if (!name || used == null) continue;
    rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
  }
  return rows;
}

function durationLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

function assignDurationWindows(windows: DurationWindow[]): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  for (const window of windows) {
    const open = openWindow(window.used, window.resetsAt);
    const fiveHourSlot = window.seconds >= FIVE_HOUR_MIN_SECONDS && window.seconds <= FIVE_HOUR_MAX_SECONDS;
    const weeklySlot = window.seconds >= WEEK_MIN_SECONDS && window.seconds <= WEEK_MAX_SECONDS;
    if (fiveHourSlot && !fiveHour.available) fiveHour = open;
    else if (weeklySlot && !weekly.available) weekly = open;
    else extra.push(extraLine(durationLabel(window.seconds), open));
  }
  return { plan: null, fiveHour, weekly, extra, models: [] };
}

type GrokSlot = "fiveHour" | "weekly" | "monthly" | "other";

interface GrokSample {
  used: number;
  slot: GrokSlot;
  resetsAt: string | null;
  seconds: number | null;
}

function classifyGrok(typeValue: unknown, seconds: number | null): GrokSlot {
  const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type)) return "fiveHour";
  if (seconds == null) return "other";
  if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
  if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS) return "weekly";
  if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS) return "monthly";
  return "other";
}

function readGrokSample(body: unknown, zeroWhenPeriodPresent: boolean): GrokSample | null {
  const root = asRecord(body);
  if (!root) return null;
  const config = asRecord(root.config) ?? root;
  const period = asRecord(config.currentPeriod);
  let used = numericValue(config.creditUsagePercent);
  if (used == null) {
    const cap = numericValue(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
    const spent = numericValue(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
    if (cap != null && spent != null && cap > 0) used = (spent / cap) * 100;
  }
  if (used == null && zeroWhenPeriodPresent && period) used = 0;
  if (used == null) return null;
  const type = period?.type ?? period?.period ?? config.period ?? config.interval;
  const start = period?.start ?? period?.periodStart;
  const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
  return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}

function grokPlan(settings: unknown): string | null {
  const root = asRecord(settings);
  if (!root) return null;
  const nested = asRecord(root.settings);
  return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}
