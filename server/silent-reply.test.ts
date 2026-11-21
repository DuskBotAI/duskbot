import { describe, expect, it } from "vitest";
import { isDirectPassText, isPassStreamPrefix, PassStreamGate } from "./silent-reply.ts";

describe("direct-chat silent pass detection", () => {
  it("matches explicit parenthesized pass variants", () => {
    for (const sample of ["(pass)", " (pass) ", "(Pass)", "( pass ).", "\n(pass)\n"]) {
      expect(isDirectPassText(sample), sample).toBe(true);
    }
  });

  it("keeps bare words and real replies visible", () => {
    for (const sample of ["", "   ", "pass", "Pass.", "passing the build", "(pass) actually wait", "I'll (pass)", "(passed)"]) {
      expect(isDirectPassText(sample), sample).toBe(false);
    }
  });
});

describe("PassStreamGate", () => {
  it("recognizes partial prefixes of (pass) and rejects anything else", () => {
    for (const prefix of ["", " ", "(", "( ", "(p", "(pa", "(pas", "(pass", "(pass ", "(pass)", "(pass).", " (pass) "]) {
      expect(isPassStreamPrefix(prefix), JSON.stringify(prefix)).toBe(true);
    }
    for (const text of ["Sure", "Pass.", "(note", "(pass) hi", "(passed", "(pass).."]) {
      expect(isPassStreamPrefix(text), JSON.stringify(text)).toBe(false);
    }
  });

  it("streams normal replies immediately with zero buffering", () => {
    const gate = new PassStreamGate();
    expect(gate.delta("t1", "On it")).toBe("On it");
    expect(gate.delta("t1", ", checking.")).toBe(", checking.");
  });

  it("holds a leading parenthesis until the next chunk clarifies it, then flushes whole", () => {
    const gate = new PassStreamGate();
    expect(gate.delta("t1", "(")).toBeNull();
    expect(gate.delta("t1", "fyi")).toBe("(fyi");
    expect(gate.delta("t1", ") done")).toBe(") done");
  });

  it("withholds every chunk of a streamed (pass) and resets cleanly for the next item", () => {
    const gate = new PassStreamGate();
    expect(gate.delta("t1", " ")).toBeNull();
    expect(gate.delta("t1", "(")).toBeNull();
    expect(gate.delta("t1", "pa")).toBeNull();
    expect(gate.delta("t1", "ss")).toBeNull();
    expect(gate.delta("t1", ")")).toBeNull();
    gate.reset("t1");
    expect(gate.delta("t1", "Next reply")).toBe("Next reply");
  });
});
