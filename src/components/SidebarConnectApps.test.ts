import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { initialState } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: initialState, dispatch: vi.fn() }) }));

import { APP_FACES, POPULAR_APPS, SidebarConnectApps, appFaces } from "./SidebarConnectApps";

const card = (slug: string) => ({ slug, label: slug, logo: `https://logos.example/${slug}.png`, domain: null });

describe("the Connect apps faces", () => {
  it("shows popular apps until something is connected", () => {
    expect(appFaces([], new Map()).map((face) => face.slug)).toEqual(POPULAR_APPS.map((app) => app.slug));
  });

  it("shows grok's featured apps not yet connected, in order, and never more than three", () => {
    const cards = new Map([["github", card("github")], ["gmail", card("gmail")]]);
    expect(appFaces(["github", "linear"], cards).map((face) => face.slug)).toEqual(["gmail", "notion", "slack"]);
    expect(appFaces(["gmail", "figma"], cards).map((face) => face.slug)).toEqual(["notion", "slack", "linear"]);
    const many = new Map(["a", "b", "c", "d"].map((slug) => [slug, card(slug)]));
    expect(appFaces(["a", "b", "c", "d"], many)).toHaveLength(APP_FACES);
  });

  it("draws a 36px hairline pill with a 13px medium label (the owner found 40/14 too big) and three 20px tiles on white, 6px over each other", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps));
    // 16px in, 12px out beside the logos, which sit 6px after the label
    expect(html).toMatch(/class="group\/apps flex h-9 min-w-0 flex-1 items-center justify-center rounded-full border border-ink\/\[0\.08\] bg-composer ps-3\.5 text-\[13px\] font-medium leading-5 [^"]*\bpe-3\b/);
    expect(html).toContain('class="ms-1.5 flex shrink-0 items-center"');
    const faces = [...html.matchAll(/data-app-face="[^"]+" class="([^"]*)"/g)].map(([, classes]) => classes!);
    expect(faces).toHaveLength(3);
    for (const face of faces) expect(face).toContain("size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-composer p-px");
    expect(faces[0]).not.toContain("-ms-");
    expect(faces[1]).toContain("-ms-[6px]");
    // at rest they sit straight; only the hovered pill fans them, as grok's does
    for (const face of faces) expect(face.split(" ").filter((name) => name.includes("rotate")).every((name) => name.includes("group-hover/apps:"))).toBe(true);
  });

  it("is a round 40px apps-grid button on the collapsed rail, named for screen readers", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps, { circle: true }));
    expect(html).toMatch(/data-tour="nav-apps"[^>]*aria-label="Connect apps" class="[^"]*\brounded-full\b[^"]*\bh-10 min-w-10\b/);
    expect(html).toContain('data-icon-name="grid-plus"');
    expect(html).not.toContain("data-app-face");
  });

  it("draws a bare mark (Slack, Notion) the same size as a whole tile's mark (Gmail)", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps));
    const sizes = [...html.matchAll(/data-app-face="([^"]+)"[\s\S]*?(?:<img[^>]*width="([\d.]+)"|data-ink-mark=""[^>]*width:([\d.]+)px)/g)].map(([, slug, img, ink]) => [slug, Number(img ?? ink)] as const);
    const mark = (slug: string, width: number) => slug === "gmail" ? width * 36 / 64 : width;
    expect(sizes.map(([slug]) => slug)).toEqual(["gmail", "notion", "slack"]);
    for (const [slug, width] of sizes) expect(mark(slug, width)).toBeCloseTo(18 * 36 / 64, 5);
  });

  it("draws Notion as a bare ink mark, never on a white plate", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps));
    const notion = html.match(/data-app-face="notion"[\s\S]*?<\/span><\/span><\/span>/)?.[0] ?? "";
    expect(notion).toContain('data-ink-mark="" class="bg-ink"');
    expect(notion).not.toContain("<img");
  });

  it("keeps a connected app it cannot draw yet out, and the popular ones in", () => {
    expect(appFaces(["linear"], new Map()).map((face) => face.slug)).toEqual(["gmail", "notion", "slack"]);
  });
});
