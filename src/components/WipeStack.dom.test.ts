// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { WipeStack } from "./ListRows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const host = document.createElement("div");
document.body.append(host);
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

it("the page slid away is a still copy: leaving it never mounts it again", async () => {
  const mounts: string[] = [];
  function Page({ name }: { name: string }) {
    useEffect(() => { mounts.push(name); }, [name]);
    return createElement("p", { id: `page-${name}` }, name);
  }
  const layer = (at: string) => createElement(Page, { name: at });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(WipeStack, { at: "list", depth: 0, group: "phone", layer })); });
  await act(async () => { root!.render(createElement(WipeStack, { at: "advanced", depth: 1, group: "phone", layer })); });
  expect(mounts).toEqual(["list", "advanced"]);
  const outgoing = host.querySelector("[data-wipe-out]")!;
  expect(outgoing.textContent).toBe("list");
  expect(outgoing.querySelector("[id]"), "the copy carries no ids").toBeNull();
  await act(async () => { root!.render(createElement(WipeStack, { at: "list", depth: 0, group: "phone", layer })); });
  expect(mounts).toEqual(["list", "advanced", "list"]);
});
