// Builds the privacy lab (src/testing/privacy-lab.html) into a static site with a small node server, ready
// for `deploy <out> --domain <name>`. Run: node scripts/motion-lab/privacy-lab.mjs <out dir>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const out = resolve(process.argv[2] ?? "privacy-lab-out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  configFile: false,
  root: repo,
  base: "./",
  cacheDir: join(repo, "node_modules/.vite-privacy-lab"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(repo, "src") } },
  define: { __APP_VERSION__: JSON.stringify("lab") },
  logLevel: "warn",
  build: { outDir: join(out, "public"), emptyOutDir: true, rollupOptions: { input: join(repo, "src/testing/privacy-lab.html") } },
});

const built = join(out, "public/src/testing/privacy-lab.html");
writeFileSync(join(out, "public/index.html"), readFileSync(built, "utf8").replaceAll("../../assets/", "./assets/"));
rmSync(join(out, "public/src"), { recursive: true, force: true });

writeFileSync(join(out, "package.json"), JSON.stringify({ name: "privacy-lab", private: true, type: "module", scripts: { start: "node server.mjs" } }, null, 2));
writeFileSync(join(out, "server.mjs"), `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root = join(import.meta.dirname, "public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(Number(process.env.PORT) || 4321, "0.0.0.0");
`);
console.log(`built ${out}`);
