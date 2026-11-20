import { describe, expect, it } from "vitest";
import { COMPOSER_ACK_MS, composerHandoff } from "./native-composer-ack";

const clock = () => {
  let at = 0;
  return { now: () => at, pass: (ms: number) => { at += ms; } };
};

describe("who draws the chat's composer", () => {
  it("the page hides its own only once the native side says its composer is on screen", () => {
    const time = clock();
    const handoff = composerHandoff(time.now);
    handoff.want(true);
    expect(handoff.native()).toBe(true);
    expect(handoff.pageHidden()).toBe(false);
    time.pass(80);
    handoff.ack({ shown: true });
    expect(handoff.native()).toBe(true);
    expect(handoff.pageHidden()).toBe(true);
    time.pass(COMPOSER_ACK_MS * 10);
    expect(handoff.pageHidden()).toBe(true);
  });

  it("no answer in time: the page keeps its composer and the native one is told to hide", () => {
    const time = clock();
    const handoff = composerHandoff(time.now);
    handoff.want(true);
    time.pass(COMPOSER_ACK_MS + 1);
    expect(handoff.native()).toBe(false);
    expect(handoff.pageHidden()).toBe(false);
    expect(handoff.refusal()).toBe("no answer");
    handoff.ack({ shown: true });
    expect(handoff.pageHidden()).toBe(false);
  });

  it("the native side could not draw it (no host): the page keeps its composer, also after it had one", () => {
    const time = clock();
    const handoff = composerHandoff(time.now);
    handoff.want(true);
    handoff.ack({ shown: false, reason: "no host" });
    expect(handoff.native()).toBe(false);
    expect(handoff.pageHidden()).toBe(false);
    expect(handoff.refusal()).toBe("no host");

    const later = composerHandoff(time.now);
    later.want(true);
    later.ack({ shown: true });
    expect(later.pageHidden()).toBe(true);
    // the watchdog's resend finds it lost
    later.ack({ shown: false, reason: "not drawn" });
    expect(later.pageHidden()).toBe(false);
    expect(later.native()).toBe(false);
  });

  it("coming back to the front, or the composer coming back, asks again", () => {
    const time = clock();
    const handoff = composerHandoff(time.now);
    handoff.want(true);
    handoff.ack({ shown: false, reason: "no host" });
    handoff.recheck();
    expect(handoff.native()).toBe(true);
    expect(handoff.pageHidden()).toBe(false);
    handoff.ack({ shown: true });
    expect(handoff.pageHidden()).toBe(true);

    handoff.want(false);
    expect(handoff.native()).toBe(false);
    expect(handoff.pageHidden()).toBe(false);
    handoff.ack({ shown: true });
    expect(handoff.pageHidden()).toBe(false);
    handoff.want(true);
    expect(handoff.pending()).toBe(true);
    expect(handoff.native()).toBe(true);
  });
});
