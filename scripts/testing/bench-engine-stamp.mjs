#!/usr/bin/env node
// Runs a real engine CLI (BENCH_REAL_CLI) with this process's argv and stdio, stamping on the wall clock when it was
// spawned and when each kind of JSON line first crossed stdin or stdout (a kind seen again within 3 s is not stamped
// again), so scripts/bench-engines.ts can split a turn into the engine's own hops.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const file = process.env.BENCH_STAMP_FILE;
const real = process.env.BENCH_REAL_CLI;
const started = Date.now();
const pid = process.pid;
const last = new Map();
const stamp = (event, at = Date.now()) => {
  const seen = last.get(event);
  last.set(event, at);
  if (seen !== undefined && at - seen < 3_000) return;
  appendFileSync(file, `${JSON.stringify({ event, at, pid })}\n`);
};
stamp(`spawn ${process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? ""}`.trim(), started);

const requests = new Map();
function kind(line, dir) {
  let frame;
  try { frame = JSON.parse(line); } catch { return null; }
  if (!frame || typeof frame !== "object") return null;
  if (typeof frame.method === "string") {
    if (frame.id !== undefined && dir === "in") requests.set(`in:${frame.id}`, frame.method);
    if (frame.id !== undefined && dir === "out") requests.set(`out:${frame.id}`, frame.method);
    const update = frame.params?.update?.sessionUpdate;
    return `${dir} ${frame.method}${update ? `:${update}` : ""}`;
  }
  if (frame.id !== undefined && ("result" in frame || "error" in frame)) {
    const method = requests.get(`${dir === "out" ? "in" : "out"}:${frame.id}`) ?? "?";
    return `${dir} ${"error" in frame ? "error" : "result"} ${method}`;
  }
  if (typeof frame.type === "string") {
    if (frame.type === "stream_event") return `${dir} stream_event:${frame.event?.type ?? ""}${frame.event?.delta?.type ? `:${frame.event.delta.type}` : ""}`;
    return `${dir} ${frame.type}${frame.subtype ? `:${frame.subtype}` : ""}`;
  }
  return null;
}

function tap(stream, dir) {
  let buffer = "";
  stream.on("data", (chunk) => {
    const at = Date.now();
    buffer += chunk.toString("utf8");
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      const name = kind(line, dir);
      if (name) stamp(name, at);
    }
    if (buffer.length > 4_000_000) buffer = "";
  });
}

const argv = process.argv.slice(2);
// BENCH_ENGINE_ARGS: extra arguments for the real CLI (a debug flag), space separated
if (process.env.BENCH_ENGINE_ARGS) argv.push(...process.env.BENCH_ENGINE_ARGS.split(" ").filter(Boolean));
const child = spawn(real, argv, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
tap(process.stdin, "in");
tap(child.stdout, "out");
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stdin.on("error", () => {});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  stamp("exit");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
