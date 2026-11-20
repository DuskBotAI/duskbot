import { afterEach } from "vitest";

// A closed overlay's exit copy is a page-level node no test renders; one left from a test is gone before the next.
afterEach(() => {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  document.querySelectorAll("[data-exit-ghost]").forEach((ghost) => ghost.remove());
});
