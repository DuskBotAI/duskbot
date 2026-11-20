import { describe, expect, it } from "vitest";
import { createG2p, soundedOut, spelled } from "./g2p.ts";
import { cardinal, ordinal, wordsForNumbers } from "./numbers.ts";

const g2p = createG2p({
  gold: {
    hello: "həlˈO",
    world: "wˈɜɹld",
    check: "ʧˈɛk",
    meeting: "mˈiɾɪŋ",
    calendar: "kˈæləndəɹ",
    wait: "wˈAt",
    read: { DEFAULT: "ɹˈid", VBD: "ɹˈɛd" },
    sun: "sˈʌn",
    flower: "flˈWəɹ",
    two: "tˈu",
    hundred: "hˈʌndɹəd",
    dollars: "dˈɑləɹz",
    and: "ænd",
    fifty: "fˈɪfti",
    cents: "sˈɛnts",
    apple: "ˈæpᵊl",
    pear: "pˈɛɹ",
  },
  silver: { box: "bˈɑks" },
});

describe("createG2p", () => {
  it("reads words from the lexicon and keeps sentence punctuation", () => {
    expect(g2p("Hello, world!")).toBe("həlˈO, wˈɜɹld!");
  });

  it("takes a word's common reading when it has several", () => {
    expect(g2p("read")).toBe("ɹˈid");
  });

  it("builds plurals, past tenses and -ing forms from a known stem", () => {
    expect(g2p("checks")).toBe("ʧˈɛks");
    expect(g2p("boxes")).toBe("bˈɑksᵻz");
    expect(g2p("checked")).toBe("ʧˈɛkt");
    expect(g2p("waited")).toBe("wˈAɾᵻd");
    expect(g2p("checking")).toBe("ʧˈɛkɪŋ");
  });

  it("says 'the' and 'a' the way they sound before the next word", () => {
    expect(g2p("the apple")).toBe("ði ˈæpᵊl");
    expect(g2p("the pear")).toBe("ðə pˈɛɹ");
    expect(g2p("a pear")).toBe("ɐ pˈɛɹ");
  });

  it("spells short capital acronyms letter by letter", () => {
    expect(g2p("API")).toBe(spelled("API"));
    expect(spelled("API")).toBe("ˌApˌiˈI");
  });

  it("joins known parts of a compound word", () => {
    expect(g2p("sunflower")).toBe("sˈʌnflˌWəɹ");
  });

  it("sounds out a word no dictionary knows instead of spelling it", () => {
    expect(soundedOut("blorb")).toBe("blˈɔɹb");
    expect(soundedOut("Priya")).toBe("pɹˈɪjæ");
    expect(g2p("blorb")).toBe("blˈɔɹb");
  });

  it("writes out money and splits a letter from its number", () => {
    expect(g2p("$200.50")).toBe("tˈu hˈʌndɹəd dˈɑləɹz ænd fˈɪfti sˈɛnts");
    expect(g2p("Q3")).toBe(`${spelled("Q")} θɹˈi`.replace("θɹˈi", g2p("three")));
  });

  it("drops markdown symbols rather than reading them", () => {
    expect(g2p("**hello** _world_")).toBe("həlˈO wˈɜɹld");
  });
});

describe("wordsForNumbers", () => {
  it("writes cardinals, ordinals, years, times, money and percentages", () => {
    expect(cardinal(0)).toBe("zero");
    expect(cardinal(42)).toBe("forty-two");
    expect(cardinal(1_204_000)).toBe("one million two hundred four thousand");
    expect(ordinal(21)).toBe("twenty-first");
    expect(ordinal(12)).toBe("twelfth");
    expect(ordinal(40)).toBe("fortieth");
    expect(wordsForNumbers("in 2026")).toBe("in twenty twenty-six");
    expect(wordsForNumbers("in 2005")).toBe("in two thousand five");
    expect(wordsForNumbers("at 10:30")).toBe("at ten thirty");
    expect(wordsForNumbers("at 9:05")).toBe("at nine oh five");
    expect(wordsForNumbers("at 3:00")).toBe("at three o'clock");
    expect(wordsForNumbers("$12,400")).toBe("twelve thousand four hundred dollars");
    expect(wordsForNumbers("$1.01")).toBe("one dollar and one cent");
    expect(wordsForNumbers("up 18%")).toBe("up eighteen percent");
    expect(wordsForNumbers("the 3rd")).toBe("the third");
    expect(wordsForNumbers("3.14")).toBe("three point one four");
    expect(wordsForNumbers("1,200 people")).toBe("one thousand two hundred people");
  });
});
