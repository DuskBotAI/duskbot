import { describe, expect, it } from "vitest";
import { editCode, formatCode, fullCode } from "./code-field";

/** types `keys` one at a time at the end, as a keyboard does */
const typeAll = (keys: string) => [...keys].reduce((value, key) => editCode(value, value + key).value, "");
/** a backspace with the caret at `at` */
const backspace = (value: string, at = value.length) => editCode(value, value.slice(0, at - 1) + value.slice(at), at - 1);

describe("the code field", () => {
  it("puts the dash in as the next group starts, upper case, letters and digits only", () => {
    expect(typeAll("abcd")).toBe("ABCD");
    expect(typeAll("abcde")).toBe("ABCD-E");
    expect(typeAll("abcdefghjklm")).toBe("ABCD-EFGH-JKLM");
    expect(typeAll("abcd efgh?jklm")).toBe("ABCD-EFGH-JKLM");
    expect(typeAll("abcdefghjklmnp")).toBe("ABCD-EFGH-JKLM");
  });

  it("keeps the caret at the end while typing, past the dash it added", () => {
    expect(editCode("ABCD", "ABCDE", 5)).toEqual({ value: "ABCD-E", caret: 6 });
  });

  it("takes a paste with or without dashes or spaces, in any case", () => {
    for (const pasted of ["abcdefghjklm", "ABCD-EFGH-JKLM", "abcd efgh jklm", " AbCd-eFgH jKlM \n"]) expect(editCode("", pasted).value).toBe("ABCD-EFGH-JKLM");
    expect(editCode("", "abcd efgh").value).toBe("ABCD-EFGH");
  });

  it("backspace at the end takes the dash with the character after it", () => {
    expect(backspace("ABCD-E")).toEqual({ value: "ABCD", caret: 4 });
    expect(backspace("ABCD")).toEqual({ value: "ABC", caret: 3 });
  });

  it("backspace right after a dash deletes the character before it, never stalls on the dash", () => {
    // caret between "-" and "E" in ABCD-|EFGH
    expect(backspace("ABCD-EFGH", 5)).toEqual({ value: "ABCE-FGH", caret: 3 });
  });

  it("an edit in the middle keeps the caret where the character went", () => {
    // X typed at ABCD|-EFGH
    expect(editCode("ABCD-EFGH", "ABCDX-EFGH", 5)).toEqual({ value: "ABCD-XEFG-H", caret: 6 });
    // B deleted in A|CD-EFGH
    expect(editCode("ABCD-EFGH", "ACD-EFGH", 1)).toEqual({ value: "ACDE-FGH", caret: 1 });
  });

  it("is full only with all 12", () => {
    expect(fullCode("ABCD-EFGH-JKL")).toBeNull();
    expect(fullCode("ABCD-EFGH-JKLM")).toBe("ABCDEFGHJKLM");
    expect(formatCode("abcdefgh")).toBe("ABCD-EFGH");
  });
});
