import { describe, expect, it } from "vitest";

import { grokCategories, grokCategory, inCategory, matchRank, presentCategories, recommended, searchApps, type AppEntry, type Category } from "./catalog";

const app = (id: string, categories: Category[], kind: AppEntry["kind"] = "composio", description = `${id} for your bots`): AppEntry =>
  ({ id, kind, label: id[0]!.toUpperCase() + id.slice(1), description, categories, icon: {} });

describe("Grok's categories over our catalog", () => {
  it("files our catalog's categories under Grok's", () => {
    expect(grokCategory("Developer tools")).toBe("code");
    expect(grokCategory("Files")).toBe("productivity");
    expect(grokCategory("Sales and CRM")).toBe("sales");
    expect(grokCategory("Analytics")).toBe("data");
    expect(grokCategory("Social")).toBe("marketing");
    expect(grokCategory("Communication")).toBe("communication");
    expect(grokCategory("Customer support")).toBe("support");
    expect(grokCategory("Payments & billing")).toBe("finance");
    expect(grokCategory("Artificial intelligence")).toBe("ai");
    expect(grokCategory("Model context protocol")).toBe("ai");
    expect(grokCategory("Gardening")).toBeNull();
    expect(grokCategories(["Files", "Productivity", "Gardening"])).toEqual(["productivity"]);
  });

  it("lists an app no category fits under Other, last, so the whole catalog shows", () => {
    expect(grokCategories(["Gardening"])).toEqual(["other"]);
    expect(grokCategories(undefined)).toEqual(["other"]);
    expect(presentCategories([app("hackernews", ["other"]), app("linear", ["code"])])).toEqual(["code", "other"]);
  });

  it("lists the categories that hold an app in Grok's order, our own apps first inside one, then the popular ones", () => {
    const entries = [app("linear", ["code"]), app("asana", ["productivity"]), app("email", ["communication", "productivity"], "native")];
    expect(presentCategories(entries)).toEqual(["productivity", "communication", "code"]);
    expect(inCategory(entries, "productivity").map((entry) => entry.id)).toEqual(["email", "asana"]);
    const mixed = [app("granola", ["productivity"], "remote"), ...entries];
    expect(inCategory(mixed, "productivity").map((entry) => entry.id)).toEqual(["email", "asana", "granola"]);
  });
});

describe("Recommended for you", () => {
  const entries = [app("gmail", ["communication"]), app("slack", ["communication"]), app("notion", ["productivity"]),
    app("outlook", ["communication"]), app("asana", ["productivity"]), app("figma", ["design"])];

  it("is the popular apps, most popular first, until something is connected", () => {
    expect(recommended(entries, () => "disconnected").map((entry) => entry.id)).toEqual(["gmail", "slack", "notion", "outlook", "figma", "asana"]);
  });

  it("puts the popular apps first in a category, after our own", () => {
    const list = [app("borneo", ["productivity"]), app("own", ["productivity"], "native"), app("notion", ["productivity"]), app("googledrive", ["productivity"])];
    expect(inCategory(list, "productivity").map((entry) => entry.id)).toEqual(["own", "googledrive", "notion", "borneo"]);
  });

  it("offers what you lack in the categories you use most", () => {
    const connected = new Set(["gmail", "slack", "notion"]);
    expect(recommended(entries, (id) => connected.has(id) ? "connected" : "disconnected").map((entry) => entry.id)).toEqual(["outlook", "asana"]);
  });
});

describe("search", () => {
  it("ranks a name's start, then a word, then its letters, then what an app does", () => {
    expect(matchRank("Google Drive", "goo")).toBe(0);
    expect(matchRank("Google Drive", "dri")).toBe(1);
    expect(matchRank("Airtable", "rta")).toBe(2);
    expect(matchRank("Granola", "go")).toBe(3);
    expect(matchRank("Slack", "zz")).toBeNull();
    const entries = [app("figma", ["design"], "composio", "Design files for go-getters"), app("granola", ["productivity"]), app("google", ["productivity"])];
    expect(searchApps(entries, "go").map((entry) => entry.id)).toEqual(["google", "granola", "figma"]);
    expect(searchApps(entries, "   ")).toEqual([]);
  });

  it("finds an app by a whole word of what it does, never by letters scattered through it", () => {
    expect(matchRank("Store and autofill passwords with your vault", "whop", false)).toBeNull();
    expect(matchRank("Store and autofill passwords with your vault", "vault", false)).toBe(1);
    const entries = [app("whop", ["finance"]), app("_1password", ["credentials"], "composio", "Store passwords with your vault, which helps on the go")];
    expect(searchApps(entries, "whop").map((entry) => entry.id)).toEqual(["whop"]);
    expect(searchApps(entries, "vault").map((entry) => entry.id)).toEqual(["_1password"]);
  });

  it("lists at most eight apps", () => {
    const many = Array.from({ length: 12 }, (_, index) => app(`app${index}`, ["code"]));
    expect(searchApps(many, "app")).toHaveLength(8);
  });
});
