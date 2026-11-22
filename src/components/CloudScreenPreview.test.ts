import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CloudScreenPreview } from "./CloudScreenPreview";

const defaults = {
  src: null,
  name: "Test bot",
  error: null,
  starting: false,
  opening: false,
  disabled: false,
  onOpen: vi.fn(),
  onRetry: vi.fn(),
};

describe("cloud screen connection feedback", () => {
  it("announces connecting before the first response", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, defaults));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Connecting to the screen…");
  });

  it("does not present an undecoded image as an openable desktop", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, {
      ...defaults, src: "data:image/jpeg;base64,bm90IGFuIGltYWdl",
    }));
    expect(html).toContain("Connecting to the screen…");
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("invisible");
    expect(html).not.toContain('>Open</span>');
  });

  it("shows the picture without an Open action while the live desktop can't open", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, {
      ...defaults, src: "data:image/png;base64,AAAA", canOpen: false,
    }));
    expect(html).toContain('alt="Test bot');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("live desktop");
  });

  it("offers the way forward beside Retry preview when retrying can't help", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, {
      ...defaults, error: "VPS is not configured", fix: { label: "Open VPS settings", onClick: vi.fn() },
    }));
    expect(html).toContain(">Open VPS settings</button>");
    expect(html).toContain("Retry preview");
  });

  it("distinguishes starting the computer from waiting for a frame", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, { ...defaults, starting: true }));
    expect(html).toContain("Starting your bot&#x27;s desktop…");
    expect(html).not.toContain("Connecting to the screen…");
  });

  it("surfaces request failures with a retry action instead of a permanent loader", () => {
    const html = renderToStaticMarkup(createElement(CloudScreenPreview, {
      ...defaults, error: "The screen took too long to update. Try again.",
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("took too long");
    expect(html).toContain("Retry preview");
    expect(html).not.toContain('role="status"');
    expect(html).toContain('aria-busy="false"');
  });
});
