import { describe, expect, it } from "vitest";

import { appLogo } from "./logos";

describe("app logos", () => {
  it("draws GitHub's black mark on its own light tile, so it shows on a dark window as Notion's and X's do", () => {
    for (const id of ["github", "notion", "x"]) {
      const logo = appLogo(id);
      expect(logo?.src, id).toBeTruthy();
      expect(logo?.padded, `${id} fills its tile`).toBeUndefined();
    }
  });
});
