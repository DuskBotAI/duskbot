import { afterEach, describe, expect, it } from "vitest";

import { refusedSignInNote, refusesAutomatedSignIn } from "./browser/agent-browser-args.ts";
import { withDialogTool } from "./browser-relayed-tools.ts";
import { BrowserRuntime, type BrowserSpawnSpec } from "./browser-runtime.ts";

// agent-browser 0.37.0 as seen against real sites: tab_new answers before the tab has left about:blank, an open the site
// answers 4xx/5xx fails with net::ERR_HTTP_RESPONSE_CODE_FAILURE and one whose page never fires load times out, although
// the page is showing in both, and a snapshot narrowed to a missing element is an error.
const FAKE = `
const lines = require('node:readline').createInterface({ input: process.stdin });
let url = 'about:blank';
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const text = (value, isError) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  if (m.method === 'tools/list') return send(m.id, { tools: [] });
  const { name, arguments: args } = m.params;
  if (name === 'agent_browser_tab_new') { setTimeout(() => { url = args.url; }, 400); return send(m.id, text(args.url)); }
  if (name === 'agent_browser_get_url') return send(m.id, text(url));
  if (name === 'agent_browser_open' && args.url === 'https://walled.test/') { url = args.url; return send(m.id, text('Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE', true)); }
  if (name === 'agent_browser_open' && args.url === 'https://heavy.test/') { url = args.url; return send(m.id, text('Operation timed out. The page may still be loading or the element may not exist.', true)); }
  if (name === 'agent_browser_open') { url = args.url; return send(m.id, text('Opened')); }
  if (name === 'agent_browser_snapshot' && args.selector) return send(m.id, text("Selector '" + args.selector + "' did not match any element", true));
  if (name === 'agent_browser_snapshot') return send(m.id, text(url === 'about:blank' ? '' : '- heading "' + url + '" [ref=e1]'));
  if (name === 'agent_browser_eval') return send(m.id, text('eval unavailable', true));
  send(m.id, text(JSON.stringify(m.params)));
});
`;
const spec = (): BrowserSpawnSpec => ({ command: process.execPath, args: ["-e", FAKE], env: { PATH: process.env.PATH } });
const runtimes: BrowserRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.closeAll())); });
const said = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "").join("\n");

describe("a page a bot opens", () => {
  it("in a new tab answers once the tab shows it, so the next read is not of a blank tab", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    const engine = spec();
    const opened = await runtime.agentRpc("tabs", engine, "tools/call", { name: "agent_browser_tab_new", arguments: { url: "https://second.test/" } });
    expect((opened as { isError?: boolean }).isError).not.toBe(true);
    expect(said(opened)).toContain('heading "https://second.test/"');
    expect(said(await runtime.agentRpc("tabs", engine, "tools/call", { name: "agent_browser_get_url", arguments: {} }))).toBe("https://second.test/");
  });

  it("that answered with an error status shows the bot what the site sent instead of a failed navigation", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    const opened = await runtime.agentRpc("walled", spec(), "tools/call", { name: "agent_browser_open", arguments: { url: "https://walled.test/" } });
    expect((opened as { isError?: boolean }).isError).not.toBe(true);
    expect(said(opened)).toMatch(/answered with an error status/);
    expect(said(opened)).toContain('heading "https://walled.test/"');
    expect(said(opened)).not.toMatch(/ERR_HTTP_RESPONSE_CODE_FAILURE/);
  });

  it("whose load never ends shows what is there instead of a timeout", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    const opened = await runtime.agentRpc("heavy", spec(), "tools/call", { name: "agent_browser_open", arguments: { url: "https://heavy.test/" } });
    expect((opened as { isError?: boolean }).isError).not.toBe(true);
    expect(said(opened)).toMatch(/still loading when the wait ran out/);
    expect(said(opened)).toContain('heading "https://heavy.test/"');
  });
});

describe("a snapshot narrowed to an element the page does not have", () => {
  it("answers with the whole page and says so", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    const engine = spec();
    await runtime.agentRpc("narrow", engine, "tools/call", { name: "agent_browser_open", arguments: { url: "https://shop.test/" } });
    const page = await runtime.agentRpc("narrow", engine, "tools/call", { name: "agent_browser_snapshot", arguments: { selector: "main", depth: 3 } });
    expect((page as { isError?: boolean }).isError).not.toBe(true);
    expect(said(page)).toMatch(/^Nothing on the page matches main, so this is the whole page's snapshot\./);
    expect(said(page)).toContain('heading "https://shop.test/"');
  });
});

describe("a dialog the page opened", () => {
  it("is answered with agent_browser_dialog, which the bot is offered and agent-browser's own advice names", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    const listed = await runtime.agentRpc("dialog", spec(), "tools/list", {}) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toContain("agent_browser_dialog");
    expect(withDialogTool('A JavaScript confirm dialog is blocking the page: "Sure?". Resolve it with `dialog accept` or `dialog dismiss`, then retry `press`.'))
      .toBe('A JavaScript confirm dialog is blocking the page: "Sure?". Answer it with agent_browser_dialog (accept true or false), then call agent_browser_press again.');
    expect(withDialogTool('A JavaScript prompt dialog is blocking the page: "Name?" — use `dialog accept` or `dialog dismiss` to resolve it'))
      .toBe('A JavaScript prompt dialog is blocking the page: "Name?" — answer it with agent_browser_dialog (accept true or false)');
  });
});

describe("a site that refuses sign-in in an automated browser", () => {
  it("tells the bot once, after the page it landed on, to take the sign-in to the person's own Chrome", async () => {
    const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000 });
    runtimes.push(runtime);
    runtime.refusedSignIn = () => refusedSignInNote(true);
    const engine = spec();
    const fine = await runtime.agentRpc("google", engine, "tools/call", { name: "agent_browser_open", arguments: { url: "https://accounts.google.com/signin" } });
    expect(said(fine)).not.toMatch(/Google refuses/);
    const refused = await runtime.agentRpc("google", engine, "tools/call", { name: "agent_browser_open", arguments: { url: "https://accounts.google.com/v3/signin/rejected?continue=x" } });
    expect(said(refused)).toMatch(/Google refuses every sign-in inside this automated browser.*My Chrome/s);
    expect(refused).toMatchObject({ signInRefused: true });
    expect(fine).not.toHaveProperty("signInRefused");
    expect(refusedSignInNote(false)).toMatch(/connected Google app/);
    expect(refusesAutomatedSignIn("https://accounts.google.com/signin/rejected")).toBe(true);
    expect(refusesAutomatedSignIn("https://accounts.google.com/v3/signin/identifier")).toBe(false);
  });
});

