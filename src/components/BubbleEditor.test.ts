import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { userBubbleStyle } from "@/lib/user-bubble-tone";
import { BubbleEditor } from "./BubbleEditor";

const send = (markup: string) => /<button[^>]*>Send<\/button>/.exec(markup)?.[0] ?? "";

describe("editing a sent message", () => {
  it("writes Send in the bubble's own colour on a coloured bubble, whose ink is the pill's fill", () => {
    const markup = renderToStaticMarkup(createElement(BubbleEditor, { initial: "hi", onCancel: () => {}, onSubmit: () => {}, bubbleStyle: userBubbleStyle("green", { flat: true }) }));
    expect(send(markup)).toContain("bg-ink");
    expect(send(markup)).not.toContain("text-app");
    expect(send(markup)).toContain("color:var(--grok-bubble, var(--color-bubble-user))");
  });

  it("keeps the plain ink pill on an uncoloured bubble", () => {
    const markup = renderToStaticMarkup(createElement(BubbleEditor, { initial: "hi", onCancel: () => {}, onSubmit: () => {} }));
    expect(send(markup)).toContain("text-app");
    expect(send(markup)).not.toContain("style=");
  });
});
