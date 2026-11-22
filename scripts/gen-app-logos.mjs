// writes the Connect Apps tiles in src/assets/app-logos as <id>.tile.svg: the brand's simple-icons mark (CC0) in its
// brand colour on a light tile. an app simple-icons has no mark for keeps Composio's own mark as a bare <id>.svg instead;
// a lettered tile would hide the real logo the catalog has, so none is written.
// run: npm i --prefix <dir> simple-icons && node scripts/gen-app-logos.mjs <dir>/node_modules/simple-icons
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const simpleIcons = process.argv[2];
if (!simpleIcons) throw new Error("pass the simple-icons package folder");
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/app-logos");

/** id -> simple-icons slug */
const MARKS = {
  "1password": "1password", atlassian: "atlassian", brevo: "brevo", cloudflare: "cloudflare", datadog: "datadog",
  figma: "figma", github: "github", gmail: "gmail", "google-calendar": "googlecalendar", "google-docs": "googledocs",
  "google-drive": "googledrive", "google-slides": "googleslides", hubspot: "hubspot", "hugging-face": "huggingface",
  intercom: "intercom", linear: "linear", notion: "notion", posthog: "posthog", postman: "postman", semrush: "semrush",
  sentry: "sentry", "shopify-merchant": "shopify", stripe: "stripe", supabase: "supabase", vercel: "vercel", x: "x",
};

const LIGHT_TILE = "#fdfdfc";
const DARK_TILE = "#1b1b1f";

const data = JSON.parse(readFileSync(join(simpleIcons, "data/simple-icons.json"), "utf8"));
const icons = Array.isArray(data) ? data : data.icons;
const version = JSON.parse(readFileSync(join(simpleIcons, "package.json"), "utf8")).version;

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>\n`;
const sources = [];

for (const [id, slug] of Object.entries(MARKS)) {
  const icon = icons.find((entry) => (entry.slug ?? "") === slug)
    ?? icons.find((entry) => entry.title.toLowerCase().replace(/[^a-z0-9]/g, "") === slug);
  if (!icon) throw new Error(`simple-icons has no ${slug}`);
  const path = readFileSync(join(simpleIcons, "icons", `${slug}.svg`), "utf8").match(/<path d="([^"]+)"/)?.[1];
  if (!path) throw new Error(`no path in ${slug}.svg`);
  // a mark too pale to read on the light tile sits on a dark one instead
  const tile = contrast(luminance(icon.hex), luminance(LIGHT_TILE.slice(1))) < 1.8 ? DARK_TILE : LIGHT_TILE;
  writeFileSync(join(out, `${id}.tile.svg`), svg(
    `<rect width="64" height="64" fill="${tile}"/><path transform="translate(14 14) scale(1.5)" fill="#${icon.hex}" d="${path}"/>`,
  ));
  sources.push(`- \`${id}.tile.svg\`: simple-icons ${version} \`${slug}\` (${icon.title}), #${icon.hex}`);
}

writeFileSync(join(out, "README.md"), `App logos for the Connect Apps window. Every mark belongs to its owner and is shown only to name the app a
person connects.

- \`*.tile.svg\` are written by \`scripts/gen-app-logos.mjs\`: the brand's mark from
  [simple-icons](https://simpleicons.org) (CC0-1.0, see its DISCLAIMER about trademarks) in its brand colour on a
  light tile.
- The other \`*.svg\` are bare marks from Composio's logo service (logos.composio.dev), for apps simple-icons has no
  mark for.

${sources.join("\n")}
`);
