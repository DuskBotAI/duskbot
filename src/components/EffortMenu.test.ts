import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { EffortMenu } from "./EffortMenu";

// The translate on its wrapper makes a stacking context, so without a z-index of its own the open list paints and
// hit-tests under the model rows that follow it: a click on High picked the model below it instead.
it("lifts the whole thinking menu above the model rows after it, not only its list", () => {
  const html = renderToStaticMarkup(createElement(EffortMenu, { levels: ["low", "high"], onPick: () => {}, onReset: () => {} }));
  const wrapper = /<span[^>]*data-simple-thinking[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
  expect(wrapper).toContain("-translate-y-1/2");
  expect(wrapper.split(" ")).toContain("z-10");
});
