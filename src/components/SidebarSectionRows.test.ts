// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { SectionRows } from "./SidebarSectionRows";

describe("SectionRows", () => {
  it("constrains its grid column and inner wrapper width so truncated rows cannot overflow the sidebar", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => {
      root.render(createElement(SectionRows, { open: true, animate: true, children: createElement("div", null, "row") }));
    });

    const outer = host.querySelector<HTMLElement>("[data-sidebar-section-rows]");
    const inner = outer?.firstElementChild as HTMLElement | null;
    expect(outer?.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(inner?.className).toContain("min-w-0");

    act(() => root.unmount());
    host.remove();
  });
});
