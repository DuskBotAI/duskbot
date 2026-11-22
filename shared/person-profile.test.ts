import { expect, it } from "vitest";
import { isProfileEmail, PROFILE_EMAIL_MAX } from "./person-profile.ts";

it("takes an empty email or one address with a dotted domain", () => {
  for (const ok of ["", "  ", "ada@example.com", "a.b+c@mail.example.co.uk", " ada@example.com "]) expect(isProfileEmail(ok), ok).toBe(true);
  for (const bad of ["not-an-email", "ada@", "@example.com", "ada@example", "ada@@example.com", "ada @example.com", "ada@example.com, bob@example.com", "ada@.com", `${"a".repeat(PROFILE_EMAIL_MAX)}@example.com`]) {
    expect(isProfileEmail(bad), bad).toBe(false);
  }
});
