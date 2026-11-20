// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { useSidebarSections } from "./SidebarSections";

describe("useSidebarSections", () => {
  it("counts both clicks of a fast double click on a section heading", () => {
    let sections: ReturnType<typeof useSidebarSections> | null = null;
    const Probe = () => {
      sections = useSidebarSections({ simple: false, rail: false, density: "comfortable", query: "", label: (id) => id, sidebarRef: { current: null } });
      return null;
    };
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(createElement(Probe)));
    act(() => { sections!.toggle("user:Test bots"); sections!.toggle("user:Test bots"); });
    expect(sections!.collapsed("user:Test bots")).toBe(false);
    act(() => root.unmount());
  });
});
