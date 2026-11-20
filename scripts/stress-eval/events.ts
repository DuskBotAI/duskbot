// The app's live event stream (/api/events, SSE), read the way the renderer reads it: every frame is timestamped on
// arrival so a conversation can tell when its first words showed and which tools ran.
export interface Frame { at: number; kind: string; threadId?: string; data: any }

export function listen(base: string, onFrame: (frame: Frame) => void): { close(): void } {
  const controller = new AbortController();
  let closed = false;
  const run = async () => {
    while (!closed) {
      try {
        const res = await fetch(`${base}/api/events?screens=off`, { headers: { origin: base, accept: "text/event-stream" }, signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              const threadId = parsed.threadId ?? parsed.event?.threadId;
              onFrame({ at: Date.now(), kind: parsed.kind, threadId, data: parsed });
            } catch { /* a partial or non-JSON frame */ }
          }
        }
      } catch { /* aborted or dropped: reconnect */ }
      if (!closed) await new Promise((r) => setTimeout(r, 500));
    }
  };
  void run();
  return { close() { closed = true; controller.abort(); } };
}
