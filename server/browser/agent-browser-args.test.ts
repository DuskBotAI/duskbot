// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";

import { agentBrowserArguments, needsPageSelector, pageSelectorOf, pickPageSelector, PICK_ATTRIBUTE, resolveSelectorScript } from "./agent-browser-args.ts";
import { agentBrowserStep } from "./agent-browser-batch.ts";

describe("arguments as agent-browser 0.37.0 takes them", () => {
  // each of these was a JSON-RPC error from agent-browser in a real session ("selector must be a string", ...)
  it.each([
    ["agent_browser_click", { ref: "e12" }, { selector: "@e12" }],
    ["agent_browser_click", { selector: "[ref=e4]" }, { selector: "@e4" }],
    ["agent_browser_fill", { ref: "@e3", value: "Ada" }, { selector: "@e3", text: "Ada" }],
    ["agent_browser_fill", { selector: "#age", text: 42 }, { selector: "#age", text: "42" }],
    ["agent_browser_select", { selector: "#size", values: "medium" }, { selector: "#size", values: ["medium"] }],
    ["agent_browser_select", { selector: "#size", value: "m" }, { selector: "#size", values: ["m"] }],
    ["agent_browser_wait_for_load", {}, { state: "load" }],
    ["agent_browser_wait_for_load", { state: "complete", timeoutMs: 8000 }, { state: "load", waitTimeoutMs: 8000 }],
    ["agent_browser_eval", { expression: "document.title" }, { script: "document.title" }],
    ["agent_browser_wait_ms", { ms: "1500" }, { ms: 1500 }],
    ["agent_browser_wait_ms", { seconds: 2 }, { ms: 2000 }],
    ["agent_browser_tab_switch", { tab: 2 }, { tab: "t2" }],
    ["agent_browser_press", { keys: "Enter" }, { key: "Enter" }],
    ["agent_browser_tab_new", { url: "https://nodejs.org", label: "Node.js" }, { url: "https://nodejs.org", label: "Node-js" }],
    ["agent_browser_tab_new", { label: "2nd" }, { label: "nd" }],
  ])("%s %j", (name, given, wanted) => {
    expect(agentBrowserArguments(name, given)).toEqual(wanted);
  });

  it("leaves arguments agent-browser already reads alone", () => {
    expect(agentBrowserArguments("agent_browser_click", { selector: "#go" })).toEqual({ selector: "#go" });
    expect(agentBrowserArguments("agent_browser_open", { url: "https://example.com" })).toEqual({ url: "https://example.com" });
  });

  it("checks a batch step after the same rewrite, ignoring fields the tool does not take", () => {
    const tools = { tools: [
      { name: "agent_browser_click", inputSchema: { type: "object", additionalProperties: false, required: ["selector"], properties: { selector: { type: "string" }, newTab: { type: "boolean" } } } },
      { name: "agent_browser_wait_for_load", inputSchema: { type: "object", additionalProperties: false, required: ["state"], properties: { state: { type: "string" }, waitTimeoutMs: { type: "integer" } } } },
    ] };
    expect(agentBrowserStep({ do: "click", ref: "e5", timeoutMs: 3000 }, tools)).toEqual({ ok: true, call: { name: "agent_browser_click", arguments: { selector: "@e5" } } });
    expect(agentBrowserStep({ do: "wait_for_load" }, tools)).toEqual({ ok: true, call: { name: "agent_browser_wait_for_load", arguments: { state: "load" } } });
  });
});

describe("selectors agent-browser cannot read", () => {
  it.each(["text=Download CSV", "role=button[name=\"Save\"]", "label=Email", "[role=row]:has-text('Priya') button", "button:text-is('Save')", "a >> text=Next",
    "getByRole('button', { name: 'Save' })", "//a[@id='x']", "Download CSV", "Sign in"])("%s is found in the page", (selector) => {
    expect(needsPageSelector(selector)).toBe(true);
  });

  it.each(["#dl", "@e3", "e3", "button.primary", "[aria-label=Email]", "xpath=//a", "input[name=q]", "nav > a:nth-child(2)", "button"])("%s goes to agent-browser as it is", (selector) => {
    expect(needsPageSelector(selector)).toBe(false);
  });
});

// the server's tsconfig has no DOM types; happy-dom provides the document at run time
const document = (globalThis as unknown as { document: { body: { innerHTML: string }; querySelector(selector: string): { id: string } | null; querySelectorAll(selector: string): ArrayLike<unknown> } }).document;
const run = (selector: string) => pageSelectorOf({ content: [{ type: "text", text: JSON.stringify(new Function(`return ${resolveSelectorScript(selector)}`)()) }] });
const picked = (selector: string) => {
  const answer = run(selector);
  return answer && "pick" in answer ? document.querySelector(answer.pick) : null;
};

describe("the page side of a selector", () => {
  beforeAll(() => { document.body.innerHTML = `<main>
    <div role="row"><b>Priya Raman</b><button aria-label="Like">Like</button></div>
    <div role="row"><b>Sam Lee</b><button aria-label="Like" id="sam">Like</button></div>
    <a href="#csv" id="dl">Download <span>CSV</span></a>
    <button id="save">Save changes</button><button id="saveall">Save all changes</button>
    <label for="em">Email</label><input id="em"><input id="q" placeholder="Search">
    <nav><button id="p3">3</button><button id="p13">13</button></nav></main>`; });

  it("finds text, roles, labels, placeholders and Playwright's pseudo-classes", () => {
    expect(picked("text=Download CSV")?.id).toBe("dl");
    expect(picked("Download CSV")?.id).toBe("dl");
    expect(picked("a >> text=Download CSV")?.id).toBe("dl");
    expect(picked("role=button[name=\"Save changes\"]")?.id).toBe("save");
    expect(picked("getByRole('button', { name: 'Save changes' })")?.id).toBe("save");
    expect(picked("text=\"Save changes\"")?.id).toBe("save");
    expect(picked("label=Email")?.id).toBe("em");
    expect(picked("placeholder=Search")?.id).toBe("q");
    expect(picked("[role=row]:has-text('Sam Lee') button")?.id).toBe("sam");
    expect(picked("[role='row']:has(b:text-is('Sam Lee')) button")?.id).toBe("sam");
    expect(picked("nav button:text-is(\"3\")")?.id).toBe("p3");
  });

  it("marks one element only, and says when nothing matches", () => {
    picked("text=Download CSV");
    picked("label=Email");
    expect(document.querySelectorAll(`[${PICK_ATTRIBUTE}]`)).toHaveLength(1);
    expect(run("text=Nothing like this")).toEqual({ found: 0 });
  });
});

describe("a call with a selector agent-browser cannot read", () => {
  const click = (selector: string) => ({ name: "agent_browser_click", arguments: { selector } });
  const found = (answer: unknown) => async () => ({ content: [{ type: "text", text: JSON.stringify(JSON.stringify(answer)) }] });

  it("goes to agent-browser with the element the page found", async () => {
    await expect(pickPageSelector(click("text=Save"), found({ found: 1, pick: `[${PICK_ATTRIBUTE}="a1"]` }), () => 60_000))
      .resolves.toEqual({ params: click(`[${PICK_ATTRIBUTE}="a1"]`) });
  });

  it("says when several elements matched", async () => {
    const answer = await pickPageSelector(click("text=Like"), found({ found: 2, pick: `[${PICK_ATTRIBUTE}="b2"]` }), () => 60_000);
    expect(answer).toMatchObject({ note: expect.stringMatching(/^2 elements match text=Like/) });
  });

  it("waits a few seconds for the element, then answers what to do instead of failing in agent-browser", async () => {
    let asked = 0;
    const answer = await pickPageSelector(click("text=Later"), async () => {
      asked++;
      return { content: [{ type: "text", text: JSON.stringify(asked < 3 ? { found: 0 } : { found: 1, pick: "[x]" }) }] };
    }, () => 60_000, async () => undefined);
    expect(answer).toEqual({ params: click("[x]") });
    const never = await pickPageSelector(click("text=Never"), found({ found: 0 }), () => 60_000, async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(never).toEqual({ refusal: expect.stringMatching(/No element on the page matches text=Never/) });
  });

  it("passes CSS and refs straight through, and prefixes a bare xpath", async () => {
    const untouched = async () => { throw new Error("no page read for CSS"); };
    await expect(pickPageSelector(click("#go"), untouched, () => 60_000)).resolves.toEqual({ params: click("#go") });
    await expect(pickPageSelector(click("//a"), untouched, () => 60_000)).resolves.toEqual({ params: click("xpath=//a") });
  });
});
