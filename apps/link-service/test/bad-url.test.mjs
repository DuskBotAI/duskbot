// scanners send request paths that are not URLs ("//[" and the like): 400, nothing logged
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLinkService } from "../src/app.mjs";

let service, server, port;
const log = vi.fn();
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-bad-url-"));
  const scriptPath = join(dir, "install.sh");
  writeFileSync(scriptPath, "echo install\n");
  writeFileSync(join(dir, "uninstall.sh"), "echo uninstall\n");
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  service = createLinkService({ base: `http://127.0.0.1:${port}`, scriptPath, agentPath: join(dir, "agent.mjs"), trustProxy: false, log });
});
afterAll(async () => { service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

const raw = (path) => new Promise((resolve, reject) => {
  const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: link.test\r\nConnection: close\r\n\r\n`));
  let data = "";
  socket.on("data", (chunk) => { data += chunk; }).on("end", () => resolve(data)).on("error", reject);
});

describe("a path that is not a URL", () => {
  for (const path of ["//[", "http://[bad", "//[::1"]) {
    it(`answers 400 to ${path} and logs nothing`, async () => {
      log.mockClear();
      const answer = await raw(path);
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
      expect(answer).toContain('"error":"bad request"');
      expect(log).not.toHaveBeenCalled();
    });
  }

  it("still answers a normal path", async () => {
    expect(await raw("/healthz")).toMatch(/^HTTP\/1\.1 200 /);
  });
});
