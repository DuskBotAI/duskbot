import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { ComposerReplyStrip, ReplyQuote } from "./ReplyQuote";

setLocale("en");
const target = { id: "m1", role: "bot", kind: "text", at: 1, text: "The user answered your questions.\nSecond line", from: { botId: "w", name: "Willow", color: "green" } } as Message;

describe("composer reply strip", () => {
  const html = renderToStaticMarkup(createElement(ComposerReplyStrip, { message: target, onClear: () => {} }));

  it("is one soft strip: arrow, one-line excerpt, x", () => {
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("bg-ink/[0.06]");
    expect(html).not.toMatch(/border-s|border-accent/);
    expect(html).toContain("truncate");
    expect(html).toContain("data-reply-excerpt");
    expect(html).toContain("-my-0.5");
    expect(html).toContain("The user answered your questions.");
    expect(html).toContain('aria-label="Cancel reply"');
  });

  it("shows the picture of a message it answers, as the sent quote does", () => {
    const picture = { ...target, attachments: [{ kind: "image", path: "/api/attachments/123e4567-e89b-42d3-a456-426614174000.png", mime: "image/png" }] } as Message;
    const strip = renderToStaticMarkup(createElement(ComposerReplyStrip, { message: picture, onClear: () => {} }));
    expect(strip).toMatch(/<img[^>]*src="\/api\/attachments\/123e4567-e89b-42d3-a456-426614174000.png"[^>]*data-reply-thumbnail|data-reply-thumbnail[^>]*src="\/api\/attachments\/123e4567/);
    expect(html).not.toContain("data-reply-thumbnail");
  });

  it("names who it answers for screen readers, not as a second visible line", () => {
    expect(html).toMatch(/role="group" aria-label="Replying to Willow"/);
    expect(html).toContain('<span class="sr-only">Replying to Willow: </span>');
  });

  it("mirrors the arrow and keeps the excerpt's own direction in RTL", () => {
    expect(html).toContain("rtl:-scale-x-100");
    expect(html).toContain('dir="auto"');
  });
});

describe("reply quote in a sent message", () => {
  it("uses the same strip family, without the accent border", () => {
    const html = renderToStaticMarkup(createElement(ReplyQuote, { message: target, compact: true, onJump: () => {} }));
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("bg-ink/[0.06]");
    expect(html).not.toMatch(/border-s|border-accent/);
    expect(html).toContain(">Willow<");
  });
});
