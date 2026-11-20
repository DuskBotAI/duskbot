// `dusk-notify [--tell] <text>` inside a background job: wakes the bot with the text (it decides what to tell the
// person), or with --tell posts the text in the chat as is. The text may also come on stdin. Exits 0 once dusk bot
// took it, 1 with the reason on stderr otherwise.
import { request } from "node:http";

export async function sendJobNote(text: string, tell: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; status: number; body: string }> {
  const url = env.DUSK_JOB_NOTIFY_URL, token = env.DUSK_JOB_TOKEN;
  if (!url || !token) return { ok: false, status: 0, body: "dusk-notify runs only inside a dusk bot background job." };
  const payload = JSON.stringify({ text, tell });
  return new Promise((resolve) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("dusk bot did not answer in 30 s")));
    req.on("error", (error) => resolve({ ok: false, status: 0, body: error.message }));
    req.end(payload);
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main(argv: string[]): Promise<number> {
  const tell = argv.includes("--tell");
  const words = argv.filter((arg) => arg !== "--tell");
  const text = (words.length ? words.join(" ") : await readStdin()).trim();
  if (!text) {
    process.stderr.write("usage: dusk-notify [--tell] <text>   (or the text on stdin)\n");
    return 1;
  }
  const answer = await sendJobNote(text, tell);
  if (answer.ok) return 0;
  let reason = answer.body;
  try { reason = String((JSON.parse(answer.body) as { error?: unknown }).error ?? answer.body); } catch {}
  process.stderr.write(`dusk-notify: ${reason}\n`);
  return 1;
}

if (process.argv[1] && /dusk-notify\.(?:ts|js)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
