import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminRoleContext } from "./api";
import { StagingTag } from "./DataSwitch";

const tag = (role: "owner" | "growth") => renderToStaticMarkup(createElement(AdminRoleContext.Provider, { value: role }, createElement(StagingTag, { environment: "development", live: null })));

describe("StagingTag", () => {
  it("names clouds only to the owner, who is the one who sees them", () => {
    expect(tag("owner")).toContain("people, money and clouds from this service");
    expect(tag("growth")).toContain("people and money from this service");
    expect(tag("growth")).not.toContain("clouds");
  });
});
