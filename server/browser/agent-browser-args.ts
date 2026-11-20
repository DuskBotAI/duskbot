// The arguments models write for agent-browser 0.37.0 tools, in the shapes its own MCP server takes. Its server answers a
// missing or mistyped argument with a JSON-RPC error ("selector must be a string", "state must be a string") instead of a
// result, and its selectors are CSS, xpath= and @eN refs only.

type Args = Record<string, unknown>;

/** Tools whose element is named by `selector`. */
const SELECTOR_TOOLS: ReadonlySet<string> = new Set(["click", "fill", "type", "check", "uncheck", "select", "hover", "upload", "get_text",
  "wait_for_selector", "scroll", "snapshot", "screenshot"].map((name) => `agent_browser_${name}`));
const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);
const REF = /^(?:@|ref=|\[ref=)?(e\d{1,6})\]?$/u;

const text = (value: unknown): string | undefined => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
const firstText = (args: Args, keys: readonly string[]): string | undefined => {
  for (const key of keys) { const value = text(args[key]); if (value !== undefined) return value; }
  return undefined;
};
const wholeMs = (value: unknown): number | undefined => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? Math.min(60_000, Math.max(0, Math.round(number))) : undefined;
};
const tabId = (value: unknown): unknown => typeof value === "number" || (typeof value === "string" && /^\d+$/u.test(value)) ? `t${value}` : value;

/** A ref in any of the ways models write one, as agent-browser's @eN. */
export function refSelector(value: string): string {
  const ref = REF.exec(value.trim())?.[1];
  return ref ? `@${ref}` : value;
}

/** `args` with the names and types agent-browser takes for `name`; arguments it would refuse are rewritten, never dropped. */
export function agentBrowserArguments(name: string, given: Args): Args {
  const args: Args = { ...given };
  if (SELECTOR_TOOLS.has(name)) {
    if (args.selector === undefined) {
      const named = firstText(args, ["ref", "element", "target", "locator"]);
      if (named !== undefined) args.selector = named;
    }
    for (const key of ["ref", "element", "target", "locator"]) delete args[key];
    if (typeof args.selector === "string") args.selector = refSelector(args.selector);
  }
  switch (name) {
    case "agent_browser_fill":
    case "agent_browser_type": {
      if (typeof args.text !== "string") {
        const value = firstText(args, ["text", "value", "content", "input"]);
        if (value !== undefined) args.text = value;
      }
      delete args.value; delete args.content; delete args.input;
      break;
    }
    case "agent_browser_select": {
      const values = args.values ?? args.value ?? args.option ?? args.options;
      const list = Array.isArray(values) ? values.map(text).filter((value): value is string => value !== undefined) : text(values) !== undefined ? [text(values)!] : undefined;
      if (list) args.values = list;
      delete args.value; delete args.option; delete args.options;
      break;
    }
    case "agent_browser_press": {
      if (typeof args.key !== "string") { const key = firstText(args, ["key", "keys", "chord"]); if (key !== undefined) args.key = key; }
      delete args.keys; delete args.chord;
      break;
    }
    case "agent_browser_eval": {
      if (typeof args.script !== "string") { const script = firstText(args, ["expression", "code", "js", "function"]); if (script !== undefined) args.script = script; }
      delete args.expression; delete args.code; delete args.js; delete args.function;
      break;
    }
    case "agent_browser_wait_for_load": {
      const state = typeof args.state === "string" ? args.state.toLowerCase() : typeof args.load === "string" ? args.load.toLowerCase() : "";
      args.state = LOAD_STATES.has(state) ? state : "load";
      delete args.load;
      break;
    }
    case "agent_browser_wait_ms": {
      const ms = wholeMs(args.ms) ?? wholeMs(args.timeoutMs) ?? wholeMs(args.time) ?? (wholeMs(args.seconds) !== undefined ? Math.min(60_000, wholeMs(args.seconds)! * 1_000) : undefined);
      if (ms !== undefined) args.ms = ms;
      delete args.timeoutMs; delete args.time; delete args.seconds;
      break;
    }
    case "agent_browser_tab_new":
      if (typeof args.label === "string") {
        const label = args.label.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^[^A-Za-z]+/u, "").slice(0, 48);
        if (label) args.label = label; else delete args.label;
      }
      break;
    case "agent_browser_tab_switch":
    case "agent_browser_tab_close":
      if (args.tab !== undefined) args.tab = tabId(args.tab);
      break;
  }
  if (name === "agent_browser_wait_for_selector" || name === "agent_browser_wait_for_text" || name === "agent_browser_wait_for_load") {
    if (args.waitTimeoutMs === undefined) { const ms = wholeMs(args.timeoutMs) ?? wholeMs(args.timeout); if (ms !== undefined) args.waitTimeoutMs = ms; }
    else { const ms = wholeMs(args.waitTimeoutMs); if (ms !== undefined) args.waitTimeoutMs = ms; }
    delete args.timeoutMs; delete args.timeout;
  }
  return args;
}

/**
 * A selector agent-browser cannot read but a person's words or Playwright's can: text=, role=, label=, placeholder=,
 * :has-text(), :text-is(), :text(), :visible, >> chains, or plain words with no CSS in them. CSS, xpath= and refs pass.
 */
export function needsPageSelector(selector: string): boolean {
  const value = selector.trim();
  if (!value || value.startsWith("@") || REF.test(value) || value.startsWith("xpath=")) return false;
  if (/^(?:text|role|label|placeholder|alt|title|testid|data-testid)=/iu.test(value)) return true;
  if (/:(?:has-text|text-is|text|text-matches)\(|:visible\b|\s>>\s?|^getBy/iu.test(value)) return true;
  if (/^\(?\/\//u.test(value)) return true;
  return !/[#.[\]:>~+*=()'"]/u.test(value) && /\s|[A-Z]/u.test(value);
}

/** An xpath written without its prefix. */
export function plainXpath(selector: string): string | null {
  return /^\(?\/\//u.test(selector.trim()) ? `xpath=${selector.trim()}` : null;
}

export const PICK_ATTRIBUTE = "data-dusk-pick";

/**
 * Finds the one element a selector names in the page (light DOM), marks it with PICK_ATTRIBUTE and answers
 * {"found": n, "pick": "<css>"} as JSON; {"found": 0} when nothing visible matches.
 */
const RESOLVE = String.raw`(selector, attribute) => {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = (element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return (box.width > 0 || box.height > 0) && style.visibility !== "hidden" && style.display !== "none"; };
  const textOf = (element) => norm(element.innerText !== undefined ? element.innerText : element.textContent) || norm(element.value) || norm(element.getAttribute("aria-label"));
  const unquote = (value) => { const v = value.trim(); const q = /^(["'])(.*)\1(s|i)?$/s.exec(v); return q ? { text: q[2], exact: q[3] !== "i" } : { text: v, exact: false }; };
  const matches = (have, want) => want.exact ? have === norm(want.text) : have.includes(norm(want.text));
  const smallest = (elements) => elements.filter((element) => !elements.some((other) => other !== element && element.contains(other)));
  const ROLES = { button: "button,input[type=button],input[type=submit],input[type=reset],summary", link: "a[href],area[href]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=tel],input[type=url],input[type=password],input[type=number],textarea,[contenteditable=''],[contenteditable=true]",
    searchbox: "input[type=search]", checkbox: "input[type=checkbox]", radio: "input[type=radio]", combobox: "select,input[list]", listbox: "select[multiple]", option: "option", heading: "h1,h2,h3,h4,h5,h6", img: "img[alt]", image: "img[alt]",
    listitem: "li", list: "ul,ol", row: "tr", cell: "td", columnheader: "th", table: "table", navigation: "nav", main: "main", dialog: "dialog", form: "form", slider: "input[type=range]", spinbutton: "input[type=number]", article: "article", region: "section[aria-label],section[aria-labelledby]" };
  const nameOf = (element) => {
    const label = element.getAttribute("aria-label"); if (label) return norm(label);
    const by = element.getAttribute("aria-labelledby"); if (by) return norm(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
    if (element.id) { const forLabel = document.querySelector('label[for="' + CSS.escape(element.id) + '"]'); if (forLabel) return norm(forLabel.innerText); }
    const wrap = element.closest("label"); if (wrap && wrap !== element && /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) return norm(wrap.innerText);
    if (element.tagName === "IMG") return norm(element.getAttribute("alt"));
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return norm(element.getAttribute("placeholder") || element.getAttribute("title") || (/^(button|submit|reset)$/.test(element.type) ? element.value : ""));
    return norm(element.innerText || element.getAttribute("title") || "");
  };
  const all = (scope, css) => { try { return [...scope.querySelectorAll(css)]; } catch { return null; } };
  const within = (scopes, css) => { const out = []; for (const scope of scopes) { const found = all(scope, css); if (found === null) return null; for (const element of found) if (!out.includes(element)) out.push(element); } return out; };
  const byRole = (scopes, role, name) => {
    const explicit = within(scopes, '[role="' + role + '"]') || [];
    const implicit = ROLES[role] ? (within(scopes, ROLES[role]) || []).filter((element) => !element.hasAttribute("role")) : [];
    const candidates = [...explicit, ...implicit];
    if (!name) return candidates;
    const exact = candidates.filter((element) => nameOf(element) === norm(name.text));
    return name.exact || exact.length ? exact : candidates.filter((element) => nameOf(element).includes(norm(name.text)));
  };
  const byText = (scopes, want) => {
    const everything = [...scopes.filter((scope) => scope instanceof Element), ...(within(scopes, scopes.includes(document) ? "body *" : "*") ?? [])];
    const found = smallest(everything.filter((element) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName) && matches(textOf(element), want)));
    if (want.exact || !found.length) return found;
    const exact = found.filter((element) => textOf(element) === norm(want.text));
    return exact.length ? exact : found;
  };
  const byAttribute = (scopes, attr, want) => (within(scopes, "[" + attr + "]") ?? []).filter((element) => matches(norm(element.getAttribute(attr)), want));
  const byLabel = (scopes, want) => (within(scopes, "input,textarea,select,[contenteditable],[role=textbox],[role=combobox]") ?? []).filter((element) => matches(nameOf(element), want));
  const PSEUDO = /:(has-text|text-is|text|text-matches|visible)(?:\((["'])(.*?)\2\))?/;
  const HAS = /:has\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/;
  const cssPart = (scopes, css) => {
    const has = HAS.exec(css);
    if (has && PSEUDO.test(has[1])) {
      const outer = cssPart(scopes, css.slice(0, has.index) + css.slice(has.index + has[0].length).replace(/^(\s.*)$/s, ""));
      if (outer === null) return null;
      const held = outer.filter((element) => (part([element], has[1]) || []).some((inner) => inner !== element));
      const after = css.slice(has.index + has[0].length);
      return /^\s/.test(after) && after.trim() ? cssPart(held, after.trim()) : held;
    }
    const at = PSEUDO.exec(css);
    if (!at) return within(scopes, css);
    const head = css.slice(0, at.index).trim(), rest = css.slice(at.index + at[0].length);
    const tail = /^[^\s>+~,]*/.exec(rest)[0], after = rest.slice(tail.length).trim();
    let base = within(scopes, (head || "*") + tail.replace(PSEUDO, ""));
    if (base === null) return null;
    const kind = at[1], want = { text: at[3] || "", exact: kind === "text-is" };
    if (kind === "visible") base = base.filter(visible);
    else if (kind === "text-matches") { let re; try { re = new RegExp(at[3], "i"); } catch { return null; } base = base.filter((element) => re.test(element.innerText || "")); }
    else base = base.filter((element) => matches(textOf(element), want));
    if (kind === "text" || kind === "text-is") base = smallest(base);
    if (!after) return base;
    return cssPart(base, after.replace(/^>\s*/, ":scope > "));
  };
  const part = (scopes, raw) => {
    const value = raw.trim();
    const engine = /^(text|role|label|placeholder|alt|title|testid|data-testid|css|xpath)=(.*)$/is.exec(value);
    if (engine) {
      const kind = engine[1].toLowerCase(), body = engine[2];
      if (kind === "text") return byText(scopes, unquote(body));
      if (kind === "role") { const role = /^([a-z]+)\s*(?:\[\s*name\s*\*?=\s*(.+?)\s*\])?$/is.exec(body.trim()); return role ? byRole(scopes, role[1].toLowerCase(), role[2] ? unquote(role[2]) : null) : null; }
      if (kind === "label") return byLabel(scopes, unquote(body));
      if (kind === "placeholder") return byAttribute(scopes, "placeholder", unquote(body));
      if (kind === "alt") return byAttribute(scopes, "alt", unquote(body));
      if (kind === "title") return byAttribute(scopes, "title", unquote(body));
      if (kind === "testid" || kind === "data-testid") return byAttribute(scopes, "data-testid", { ...unquote(body), exact: true });
      if (kind === "xpath") { const out = []; for (const scope of scopes) { let it; try { it = document.evaluate(body, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { return null; } for (let i = 0; i < it.snapshotLength; i++) out.push(it.snapshotItem(i)); } return out; }
      return cssPart(scopes, body);
    }
    if (/^\(?\/\//.test(value)) return part(scopes, "xpath=" + value);
    const getBy = /^getBy(Role|Text|Label|Placeholder)\(\s*(["'])(.*?)\2\s*(?:,\s*\{\s*name\s*:\s*(["'])(.*?)\4[^}]*\})?\s*\)$/s.exec(value);
    if (getBy) {
      if (getBy[1] === "Role") return byRole(scopes, getBy[3].toLowerCase(), getBy[5] !== undefined ? { text: getBy[5], exact: false } : null);
      if (getBy[1] === "Text") return byText(scopes, { text: getBy[3], exact: false });
      if (getBy[1] === "Label") return byLabel(scopes, { text: getBy[3], exact: false });
      return byAttribute(scopes, "placeholder", { text: getBy[3], exact: false });
    }
    const css = cssPart(scopes, value);
    if (css !== null && (css.length || /[#.\[\]:>~+*=()]/.test(value))) return css;
    return byText(scopes, unquote(value));
  };
  for (const old of document.querySelectorAll("[" + attribute + "]")) old.removeAttribute(attribute);
  let scopes = [document];
  for (const piece of selector.split(/\s*>>\s*/)) {
    const found = part(scopes, piece);
    if (found === null) return JSON.stringify({ found: 0, invalid: true });
    scopes = found;
    if (!scopes.length) return JSON.stringify({ found: 0 });
  }
  const shown = scopes.filter((element) => element instanceof Element && visible(element));
  const pool = shown.length ? shown : scopes.filter((element) => element instanceof Element);
  if (!pool.length) return JSON.stringify({ found: 0 });
  const pick = Math.random().toString(36).slice(2, 10);
  pool[0].setAttribute(attribute, pick);
  return JSON.stringify({ found: pool.length, pick: "[" + attribute + '="' + pick + '"]' });
}`;

export function resolveSelectorScript(selector: string): string {
  return `(${RESOLVE})(${JSON.stringify(selector)}, ${JSON.stringify(PICK_ATTRIBUTE)})`;
}

export type PageSelector = { found: 0; invalid?: boolean } | { found: number; pick: string; invalid?: never };

/** agent-browser's eval answer to resolveSelectorScript; null when it did not run. */
export function pageSelectorOf(result: unknown): PageSelector | null {
  const record = result as { isError?: unknown; content?: unknown } | null;
  if (!record || record.isError === true || !Array.isArray(record.content)) return null;
  const part = (record.content as unknown[]).find((item) => typeof (item as { text?: unknown } | null)?.text === "string") as { text: string } | undefined;
  try {
    let value: unknown = JSON.parse(part?.text ?? "");
    if (typeof value === "string") value = JSON.parse(value);
    if (value && typeof value === "object" && "data" in value) value = (value as { data?: { result?: unknown } }).data?.result;
    if (typeof value === "string") value = JSON.parse(value);
    const answer = value as { found?: unknown; pick?: unknown; invalid?: unknown } | null;
    if (!answer || typeof answer.found !== "number") return null;
    if (answer.found > 0 && typeof answer.pick === "string") return { found: answer.found, pick: answer.pick };
    return { found: 0, ...(answer.invalid === true ? { invalid: true } : {}) };
  } catch {
    return null;
  }
}

type Rpc = (name: string, args: Args, timeoutMs: number) => Promise<unknown>;
export type PickedCall = { params: unknown; note?: string } | { refusal: string };
const PICK_WAIT_MS = 5_000, PICK_POLL_MS = 250;

/**
 * A call whose selector agent-browser cannot read, with that selector swapped for the element it names in the page.
 * An action waits up to 5 s for the element to show, wait_for_selector up to its own timeout.
 */
export async function pickPageSelector(params: unknown, rpc: Rpc, remainingMs: () => number, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<PickedCall> {
  const record = params as { name?: unknown; arguments?: unknown } | null;
  const args = record?.arguments as Args | undefined;
  if (typeof record?.name !== "string" || !SELECTOR_TOOLS.has(record.name) || !args || typeof args.selector !== "string") return { params };
  const selector = args.selector;
  const xpath = plainXpath(selector);
  if (xpath) return { params: { ...record, arguments: { ...args, selector: xpath } } };
  if (!needsPageSelector(selector)) return { params };
  const waitMs = record.name === "agent_browser_wait_for_selector" ? wholeMs(args.waitTimeoutMs) ?? 15_000 : PICK_WAIT_MS;
  const until = Date.now() + Math.min(waitMs, Math.max(0, remainingMs() - 1_000));
  for (;;) {
    const answer = pageSelectorOf(await rpc("agent_browser_eval", { script: resolveSelectorScript(selector), timeoutMs: 5_000 }, Math.max(1, Math.min(5_000, remainingMs()))));
    if (answer && answer.found > 0 && "pick" in answer) {
      return { params: { ...record, arguments: { ...args, selector: answer.pick } },
        ...(answer.found > 1 ? { note: `${answer.found} elements match ${selector}; this acted on the first visible one. Use a ref from a snapshot to pick another.` } : {}) };
    }
    if (answer?.invalid || Date.now() + PICK_POLL_MS > until) {
      return { refusal: `No element on the page matches ${selector}${record.name === "agent_browser_wait_for_selector" ? " yet" : ""}. Take a snapshot and act on a ref, or name the element by its text (text=Save) or a CSS selector.` };
    }
    await sleep(PICK_POLL_MS);
  }
}

/** A call's params with its arguments as agent-browser takes them. */
export function withAgentBrowserArguments(params: unknown): unknown {
  const record = params as { name?: unknown; arguments?: unknown } | null;
  if (typeof record?.name !== "string") return params;
  const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments) ? record.arguments as Args : {};
  return { ...record, arguments: agentBrowserArguments(record.name, args) };
}

export function withNote(result: unknown, note: string | undefined): unknown {
  if (!note || !result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return result;
  return { ...result, content: [...(result as { content: unknown[] }).content, { type: "text", text: note }] };
}
export const withPickNote = (result: unknown, picked: PickedCall): unknown => withNote(result, "note" in picked ? picked.note : undefined);

/** Calls after which the page may be another one. */
export const NAVIGATING: ReadonlySet<string> = new Set(["open", "click", "press", "fill", "back", "forward", "reload", "tab_new", "batch"].map((name) => `agent_browser_${name}`));
/** Google's "This browser or app may not be secure" page: it refuses every sign-in in a browser driven by automation. */
export function refusesAutomatedSignIn(url: string): boolean {
  return /^https:\/\/accounts\.google\.com\/(?:v3\/)?signin\/rejected/u.test(url);
}

/** agent_browser_read with a url, as an open in the browser (through its egress gate) and a read of the page it opened. */
export function readAfterOpen(params: unknown): { open: { name: string; arguments: Args }; read: unknown } | null {
  const { url, ...rest } = ((params as { arguments?: Args } | null)?.arguments ?? {});
  if (typeof url !== "string" || !url.trim()) return null;
  return { open: { name: "agent_browser_open", arguments: { url } }, read: { ...params as object, arguments: rest } };
}

const resultText = (result: unknown): string => {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as Array<{ text?: unknown }>).map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
};

/**
 * What a failed agent_browser_open still left on screen, said for the bot, or null for a navigation that went nowhere:
 * Chrome 158 fails one with net::ERR_HTTP_RESPONSE_CODE_FAILURE when the site answers 4xx/5xx yet shows the page it sent,
 * and agent-browser 0.37.0 times one out when the page never fires load (ad-heavy sites), though the page is there.
 */
export function openStillShowing(result: unknown): string | null {
  if ((result as { isError?: unknown } | null)?.isError !== true) return null;
  const text = resultText(result);
  if (/net::ERR_HTTP_RESPONSE_CODE_FAILURE/u.test(text)) return "The site answered with an error status, so this may be a sign-in wall, a bot block or a missing page; read what it shows below.";
  if (text.startsWith("Operation timed out")) return "The page was still loading when the wait ran out; below is what it shows so far. Act on it, or read it again if what you need is missing.";
  return null;
}

/** A snapshot narrowed to an element that is not on the page: agent-browser's two ways of saying so. */
export function snapshotMissedSelector(name: string, args: Args | undefined, result: unknown): boolean {
  return name === "agent_browser_snapshot" && typeof args?.selector === "string" && (result as { isError?: unknown } | null)?.isError === true
    && /No accessibility node found for selector|did not match any element/u.test(resultText(result));
}
export const WHOLE_PAGE_NOTE = (selector: string) => `Nothing on the page matches ${selector}, so this is the whole page's snapshot.`;

// agent-browser 0.37.0 answers tab_new before the tab has left about:blank.
const NEW_TAB_NAVIGATION_MS = 10_000;
export async function newTabNavigated(url: () => Promise<string>, withinMs: number): Promise<void> {
  const until = Date.now() + Math.min(NEW_TAB_NAVIGATION_MS, Math.max(0, withinMs));
  while (Date.now() < until && /^(?:about:blank)?$/u.test(await url())) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** What the bot does when Google refuses sign-in in its browser: the person's own Chrome, never a workaround. */
export function refusedSignInNote(myChrome: boolean): string {
  const lead = "Google refuses every sign-in inside this automated browser, so do not retry it here.";
  return myChrome
    ? `${lead} On the person's own request dusk bot moves this sign-in to their own Chrome (My Chrome), asking them first unless they gave Full access; the line after this says what happened.`
    : `${lead} Use a connected Google app (Gmail, Calendar, Drive) if one does the job; otherwise say in one plain line that Google blocks sign-in in the bot's browser and that their own Chrome (My Chrome, on their computer) can do it.`;
}
