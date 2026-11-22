import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chatCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chat.css"), "utf8");

describe("JumpToLatestButton", () => {
  it("lifts off the page with a deeper shadow in dark skins", () => {
    expect(chatCss).toMatch(/@container style\(--code-color-scheme: dark\) \{\s*\.chat-jump \{ --tw-shadow: [^}]*rgb\(0 0 0 \/ 0\.6\)/);
  });
});
