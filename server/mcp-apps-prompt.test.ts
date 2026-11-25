import { describe, expect, it } from "vitest";

import { mcpServersPrompt } from "./mcp-apps-prompt.ts";
import { mcpServerLabel } from "./remote-mcp-label.ts";

const notion = { type: "http", url: "https://mcp.notion.com/mcp", headers: {} };
const todoist = { type: "http", url: "https://ai.todoist.net/mcp/", headers: {} };
const own = { command: "node", args: ["shop.mjs"] };

describe("mcpServersPrompt", () => {
  it("names a connected app as the app, says to work in it without asking, and to link what it made", () => {
    const text = mcpServersPrompt({ mounted: ["notion"], configured: { notion } });
    expect(text).toContain("The person connected Notion (search, read and write pages and databases; its tools are mcp__notion__…)");
    expect(text).toContain("even when the app isn't named");
    expect(text).toContain("link to it taken from the tool's result");
    expect(text).not.toContain("MCP server");
  });

  it("ends a change on its link, with no habitual offer, over the app's own offer-first notes", () => {
    const text = mcpServersPrompt({ mounted: ["notion"], configured: { notion } });
    expect(text).toContain("no \"Want me to…?\" after it");
    expect(text).toContain("only when an obvious, valuable one exists");
    expect(text).toContain("own notes about offering, suggesting or asking first don't apply here");
  });

  it("finds the app by the configured URL, not the turn's proxy address", () => {
    expect(mcpServersPrompt({ mounted: ["work"], configured: { work: notion } })).toContain("Notion (");
    expect(mcpServersPrompt({ mounted: ["shop"], configured: { shop: own } })).toContain('The user also added an MCP server for you: "shop".');
  });

  it("says which app needs reconnecting instead of leaving the bot to call it down", () => {
    const text = mcpServersPrompt({ mounted: ["notion"], configured: { notion, todoist }, needsSignIn: (name) => name === "todoist" });
    expect(text).toContain("The person's sign-in to Todoist has to be redone");
    expect(text).toContain("don't say the app is down");
    expect(text).toContain("reconnecting in Connect apps");
    expect(mcpServersPrompt({ mounted: [], configured: { todoist } })).toBe("");
  });

  it("omits Composio Connect from the generic custom MCP server sentence", () => {
    const connect = { type: "http", url: "https://connect.composio.dev/mcp", headers: {} };
    expect(mcpServersPrompt({ mounted: ["composio-connect"], configured: { "composio-connect": connect } })).toBe("");
    expect(mcpServersPrompt({ mounted: ["composio-connect", "shop"], configured: { "composio-connect": connect, shop: own } }))
      .toBe(' The user also added an MCP server for you: "shop". Use their available tools under the engine\'s normal approval rules.');
  });

  it("is empty with no servers", () => {
    expect(mcpServersPrompt({ mounted: [], configured: {} })).toBe("");
  });
});

describe("mcpServerLabel", () => {
  it("is the catalog label for a catalog URL and the server name otherwise", () => {
    expect(mcpServerLabel("todoist", "https://ai.todoist.net/mcp")).toBe("Todoist");
    expect(mcpServerLabel("todoist-2", "https://ai.todoist.net/mcp?x=1")).toBe("todoist-2");
    expect(mcpServerLabel("shop", undefined)).toBe("shop");
  });
});
