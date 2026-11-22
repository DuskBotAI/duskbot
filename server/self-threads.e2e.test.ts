// Who may open a job on itself (start_thread), end to end on the scripted engine. Only a person's own request may: a
// teammate's hand-off and a job the bot opened on itself finish their own work, so a chain can't grow outside the depth,
// budget and stop of the request it serves. The tool's description says so; the server enforces it again here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { request } from "../scripts/mcp-server.ts";

const SETTLED = "Your downstream room requests have settled.";

it("opens threads on a bot only for a person's own request, never from a hand-off or a job it opened itself", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlDusk(args, { env: { DUSK_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const asker = (await cli("new-bot", "--name", "Asker")).bot;
    const books = (await cli("new-bot", "--name", "Books")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const open = (title: string, message: string, expectError: boolean, more: Record<string, unknown> = {}) => ({ tool: "start_thread", arguments: { title, message, ...more }, expectError });
    writeFileSync(planPath, JSON.stringify({
      [asker.id]: { script: [
        { key: "J1", match: ["J1-JOB"], steps: [{ arguments: { bot_ids: [books.id], message: "J1-ASK: check each ledger, one thread per ledger" } }], reply: "J1: asked Books." },
        { key: "J1-DONE", match: [SETTLED, "J1-JOB"], reply: "J1-DONE: Books checked the ledgers." },
      ] },
      [books.id]: { script: [
        { key: "J1-ASK", match: ["J1-ASK"], steps: [open("Ledger 1", "J1-SELF: check ledger 1", true)], reply: "J1-ASK: checked both ledgers here." },
        { key: "J2", match: ["J2-JOB"], steps: [open("Ledger A", "J2-SELF: check ledger A", false)], reply: "J2: opened Ledger A." },
        { key: "J2-BACK", match: [SETTLED, "J2-SELF: ledger A balances."], reply: "J2-BACK: Ledger A balances, as the job found." },
        { key: "J2-SELF", match: ["J2-SELF"], steps: [open("Sub-ledger", "J2-DEEPER: check the sub-ledger", true)], reply: "J2-SELF: ledger A balances." },
        { key: "J3", match: ["J3-JOB"], steps: [open("Ledger B", "J3-SELF: check ledger B", false, { report_back: false })], reply: "J3: opened Ledger B." },
        { key: "J3-SELF", match: ["J3-SELF"], reply: "J3-SELF: ledger B balances." },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const turn = (key: string) => evidence().find((record) => record.planKey === key);
    const told = (key: string): string => `${turn(key)?.system ?? ""}\n${JSON.stringify(turn(key)?.prompt ?? "")}`;
    const result = (key: string) => evidence().find((turn) => turn.planKey === key)?.evidence.find((entry: any) => entry.step?.tool === "start_thread")?.response.result;
    const tasksOf = async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === books.id).tasks as any[];
    const titles = async () => (await tasksOf()).map((task) => task.title);

    // A teammate's hand-off: the work is done in the hand-off's thread.
    await cli("send", "--bot", asker.id, "--task", asker.activeTaskId, "--text", "J1-JOB: have Books check the ledgers");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J1-DONE"), { timeout: 20_000 }).toBe(true);
    expect(result("J1-ASK").isError).toBe(true);
    expect(JSON.stringify(result("J1-ASK"))).toContain("Only a person's own request can open separate threads on yourself");

    // The person's own request opens a job; that job opens no more, and its result comes back to the chat it came from.
    await cli("send", "--bot", books.id, "--task", books.activeTaskId, "--text", "J2-JOB: open one thread per ledger");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J2-SELF"), { timeout: 20_000 }).toBe(true);
    expect(result("J2").isError).toBeFalsy();
    expect(JSON.stringify(result("J2"))).toContain("its result comes back to this conversation automatically and resumes you here");
    expect(result("J2-SELF").isError).toBe(true);
    expect(await titles()).toContain("Ledger A");
    expect(await titles()).not.toContain("Ledger 1");
    expect(await titles()).not.toContain("Sub-ledger");
    const job = turn("J2-SELF");
    expect(told("J2-SELF")).toContain("You opened this job yourself");
    expect(told("J2-SELF")).toContain("Brief from yourself, in your own words:");
    expect(told("J2-SELF")).not.toContain("[Thread you opened yourself");
    expect(job.threadId).not.toBe(books.activeTaskId);
    expect(job.permissionMode).toBe(turn("J2").permissionMode);
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J2-BACK"), { timeout: 20_000 }).toBe(true);
    expect(turn("J2-BACK").threadId).toBe(books.activeTaskId);
    expect(told("J2-BACK")).toContain("J2-SELF: ledger A balances.");

    // report_back false keeps the plain thread: its result stays there and nothing resumes the chat that opened it.
    await cli("send", "--bot", books.id, "--task", books.activeTaskId, "--text", "J3-JOB: open one more, I will read it there");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J3-SELF"), { timeout: 20_000 }).toBe(true);
    expect(JSON.stringify(result("J3"))).toContain("its result stays in that thread: it will not be delivered here");
    expect(told("J3-SELF")).toContain("[Thread you opened yourself");
    expect(await titles()).toContain("Ledger B");
    const ledgerB = (await tasksOf()).find((task) => task.title === "Ledger B");
    expect(ledgerB).toBeTruthy();
    await expect.poll(async () => {
      const tasks = await tasksOf();
      const parent = tasks.find((task) => task.threadId === books.activeTaskId);
      const child = tasks.find((task) => task.threadId === ledgerB.threadId);
      return Boolean(parent && !parent.busy && !parent.waitingForTeammates && child && !child.busy);
    }, { timeout: 20_000 }).toBe(true);
    expect(evidence().filter((turn) => turn.planKey === "J2-BACK")).toHaveLength(1);
    expect(evidence().some((turn) => turn.planKey === undefined)).toBe(false);
  } finally {
    await session.close();
  }
}, 90_000);
