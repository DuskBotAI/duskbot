import { expect, it } from "vitest";

import { backgroundJobsPrompt } from "./prompt.ts";

it("routes a watch: a checked schedule for what polls, a job only for a live source, never a refusal, and it keeps watching", () => {
  const prompt = backgroundJobsPrompt();
  expect(prompt).toContain("never a reason to say you can't monitor");
  expect(prompt).toContain("is a schedule with a check, which runs no AI until something changed");
  expect(prompt).toContain("only for a live source that pushes (a Telegram or Discord bot, a websocket, a stream) or checks under a minute apart");
  expect(prompt).toContain("ends after it reports, and after 30 days at most");
});
