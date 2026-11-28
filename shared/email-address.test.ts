import { describe, expect, it } from "vitest";
import { cleanEmail as appCleanEmail } from "../electron/cloud-signin.mjs";
import { cleanEmail } from "./email-address.ts";

// each of these passed the old check and resend answered 422 validation_error on `to` (probed 2026-11-28)
const RESEND_REFUSED = ["a,b@example.com", "a..b@example.com", ".ab@example.com", "ab.@example.com", "dé@example.com", "person@example.c",
  "person@example.123", "person@-example.com", "person@exam_ple.com", "person@exämple.com", "a(b)@example.com", "a<b@example.com",
  "a;b@example.com", "a[b]@example.com", "person@example.com,", "a\\b@example.com", "a:b@example.com", "person@example,x.com"];
const TAKEN = ["person@example.com", "first.last+tag@example.co.uk", "a#b&c@example.com", "o'neil@example.ie", "x@xn--rsend-bva.dev", "me@sub-domain.example.io"];

describe("cleanEmail", () => {
  it("turns away every address shape resend refuses, before any send", () => {
    for (const address of RESEND_REFUSED) expect(cleanEmail(address), address).toBeNull();
  });
  it("takes ordinary addresses, lower-cased and trimmed", () => {
    for (const address of TAKEN) expect(cleanEmail(address), address).toBe(address);
    expect(cleanEmail("  Person@Example.COM ")).toBe("person@example.com");
  });
  it("drops what a paste or an input method adds instead of refusing the address", () => {
    expect(cleanEmail("﻿person@example.com")).toBe("person@example.com");
    expect(cleanEmail("per​son@example.com​")).toBe("person@example.com");
    expect(cleanEmail("ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｃｏｍ")).toBe("person@example.com");
  });
  it("refuses what is no address at all", () => {
    for (const bad of ["", "person", "person@", "@example.com", "person@example", "per son@example.com", "per\u0000son@example.com",
      `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`, 42, null, undefined]) expect(cleanEmail(bad), String(bad)).toBeNull();
  });
  it("is the check the desktop and phone apps run before they ask for a code", () => {
    for (const address of [...RESEND_REFUSED, ...TAKEN, "﻿person@example.com", "ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｃｏｍ", "Person@Example.COM"]) {
      expect(appCleanEmail(address), address).toBe(cleanEmail(address));
    }
  });
});
