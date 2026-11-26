import { describe, expect, it } from "vitest";
import { isDirectPassText, isPassStreamPrefix, PassStreamGate, stripTrailingPass } from "./silent-reply.ts";

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

  it("strips trailing standalone (pass) lines without touching inline text or code blocks", () => {
    expect(stripTrailingPass("All done.\n\n(pass)")).toBe("All done.");
    expect(stripTrailingPass("All done.\n(Pass).")).toBe("All done.");
    expect(stripTrailingPass("All done.\n\n(pass)\n\n(pass)\n")).toBe("All done.");
    expect(stripTrailingPass("I'll (pass)")).toBe("I'll (pass)");
    expect(stripTrailingPass("```text\n(pass)\n```")).toBe("```text\n(pass)\n```");
    expect(stripTrailingPass("(pass)")).toBe("(pass)");
  });

  it("gets through a long run of blank lines at once, whether or not a (pass) ends it", () => {
    const blanks = "\n".repeat(20_000);
    expect(stripTrailingPass(`Done.${blanks}x`)).toBe(`Done.${blanks}x`);
    expect(stripTrailingPass(`Done.${blanks}(pass)`)).toBe("Done.");
    expect(stripTrailingPass("Done.\r\n(pass)")).toBe("Done.");
    const gate = new PassStreamGate();
    expect(gate.delta("t1", "Done.")).toBe("Done.");
    expect(gate.delta("t1", blanks)).toBeNull();
    expect(gate.delta("t1", "x")).toBe(`${blanks}x`);
  });

  it("withholds a trailing newline-prefixed (pass) during streaming and flushes normal paragraphs", () => {
    const gate = new PassStreamGate();
    expect(gate.delta("t1", "All done.\n\n")).toBe("All done.");
    expect(gate.delta("t1", "(")).toBeNull();
    expect(gate.delta("t1", "pass)")).toBeNull();
    gate.reset("t1");

    expect(gate.delta("t1", "Para 1.\n\n")).toBe("Para 1.");
    expect(gate.delta("t1", "Para 2.")).toBe("\n\nPara 2.");
    expect(gate.delta("t1", "\n(note)")).toBe("\n(note)");
  });
});
