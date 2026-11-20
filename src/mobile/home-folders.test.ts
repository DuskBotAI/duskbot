import { describe, expect, it } from "vitest";
import { homeFolders } from "./home-folders";

const entry = (id: string, at: number, folder?: string, unread = false) => ({ id, at, folder, unread });

describe("the phone home's folders", () => {
  it("groups chats by their desktop folder, folders by name, newest first inside, the rest after", () => {
    const { folders, loose } = homeFolders([
      entry("rivet", 3, "Work"), entry("quill", 9, "home"), entry("nova", 7), entry("tally", 5, "Work", true), entry("room", 8), entry("basil", 1, "home"),
    ], (one) => one.folder);
    expect(folders.map((folder) => [folder.name, folder.entries.map((one) => one.id), folder.unread])).toEqual([
      ["home", ["quill", "basil"], 0],
      ["Work", ["tally", "rivet"], 1],
    ]);
    expect(loose.map((one) => one.id)).toEqual(["room", "nova"]);
  });

  it("treats a blank folder name as no folder", () => {
    expect(homeFolders([entry("a", 1, "  ")], (one) => one.folder).loose).toHaveLength(1);
  });
});
