import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { SelectPopup } from "./SelectPopup";

afterEach(() => { setLocale("en"); });

const popup = () => renderToStaticMarkup(createElement(SelectPopup, {
  options: [{ label: "Eins", disabled: false }], selectedIndex: 0,
  anchor: { left: 0, top: 0, width: 100, height: 20 }, bounds: { width: 400, height: 300 },
  onChoose: () => {}, onClose: () => {},
}));

describe("a page's select list", () => {
  it("names its list in the app's language", () => {
    setLocale("es");
    expect(popup()).toContain('aria-label="Elige una opción"');
    setLocale("en");
    expect(popup()).toContain('aria-label="Choose an option"');
  });
});
