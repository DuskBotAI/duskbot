// A jobs host on a real loopback server, for the tests: the bot's tool route and dusk-notify's route answer as in the
// server, runs and chat lines are recorded instead of started.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { json, readBody } from "../harness/http.ts";
import type { BoxRequest } from "../bot-box/plan.ts";
import type { WrappedSpawn } from "../bot-box/box.ts";
import { createJobsHost, JOB_NOTIFY_PATH, JOBS_PATH, type JobTurn } from "./host.ts";

export const PERSON_TURN: JobTurn = { owned: true, room: false, guest: false, depth: 0, handedOff: false, routineRun: false, outsideDriven: false, personStarted: true, asksFirst: false };

export async function jobsFixture(options: { root?: string; dataDir?: string; wrap?: (request: BoxRequest) => WrappedSpawn | null; secrets?: Record<string, string>; cloudHome?: boolean; port?: number } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "dusk-jobs-host-"));
  const dataDir = options.dataDir ?? join(root, "data");
  const workspace = join(dataDir, "workspaces", "bot-a");
  mkdirSync(workspace, { recursive: true });
  const runs: Array<{ webhookId: string; webhookName: string; prompt: string; botId: string; eventSource?: string; resultsThreadId?: string; deliveryId: string }> = [];
  const lines: Array<{ threadId: string; text: string }> = [];
  const cards: Array<{ threadId: string; id: string; card: Record<string, unknown> }> = [];
  let host: ReturnType<typeof createJobsHost> | null = null;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === JOB_NOTIFY_PATH) return void host!.notifyRoute(req, res, json, () => readBody(req));
    res.writeHead(404).end();
  });
  if (options.port) await new Promise<void>((done) => server.listen(options.port, "127.0.0.1", done));
  else await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  host = createJobsHost({
    dataDir, port, wrap: options.wrap ?? (() => null),
    secret: (label) => options.secrets?.[label] ?? null,
    store: {
      bot: (id: string) => (id === "bot-a" ? { id, name: "Scout", notifications: false } : null) as never,
      appendMessage: ((threadId: string, message: { text?: string; card?: Record<string, unknown> }) => {
        if (message.card) { const id = `card-${cards.length + 1}`; cards.push({ threadId, id, card: message.card }); return { id }; }
        lines.push({ threadId, text: message.text ?? "" });
        return { id: "m" };
      }) as never,
      patchTask: (() => {}) as never,
      messagesFor: ((threadId: string) => cards.filter((line) => line.threadId === threadId)) as never,
      patchMessage: ((_threadId: string, id: string, patch: { card: Record<string, unknown> }) => { const line = cards.find((one) => one.id === id); if (line) line.card = patch.card; return line; }) as never,
    },
    directChat: (_botId, threadId) => threadId === "t-1",
    mainThread: () => "t-main",
    threadBusy: () => false,
    wrote: () => {},
    notify: () => {},
    routines: () => ({
      enqueueWebhook: (input) => { runs.push(input); return { id: `run-${runs.length}` } as never; },
      mergeIntoQueuedRun: () => null,
    }),
    cloudHome: options.cloudHome ?? false,
    limits: { restartBaseMs: 50 },
    log: () => {},
  });
  const startedIds: string[] = [];
  const call = async (body: Record<string, unknown>, turn: JobTurn = PERSON_TURN) => {
    let status = 0, answer: Record<string, unknown> = {};
    await host!.internal({
      method: "POST", path: JOBS_PATH, botId: "bot-a", threadId: "t-1", readBody: async () => body, turn: () => turn, folders: async () => [workspace], started: (id) => startedIds.push(id),
      res: {} as never, json: ((_res: unknown, code: number, payload: Record<string, unknown>) => { status = code; answer = payload; }) as never,
    });
    return { status, body: answer };
  };
  const close = async () => {
    host!.stop();
    await new Promise<void>((done) => server.close(() => done()));
    if (!options.root) rmSync(root, { recursive: true, force: true });
  };
  return { root, dataDir, workspace, port, host: host!, runs, lines, cards, call, close, startedIds };
}
