// node apps/mobile/scripts/make-icons.mjs: the phone app's icons and launch images from the logo (build/logo.mjs), so
// the store builds never carry the template art a new Capacitor project starts with
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

import { KIT_GLYPH, KIT_ONLY, LOGO_SIZE, SCENE, glyphPath, logoTile, svg } from "../../../build/logo.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const LIGHT = "#fcfcfc";
const DARK = "#121212";

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const named = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(named));
  return Buffer.concat([head, named, crc]);
}

/** App Store Connect refuses an icon with an alpha channel, and resvg always writes one: every image here covers its
 * whole canvas, so it is written as plain 8-bit RGB. */
function png(svg, size, rounded = false) {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
  // android's own launcher shapes are cut out of their square, so those keep their transparency
  if (rounded) return image.asPng();
  const { width, height, pixels } = image;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      if (pixels[from + 3] !== 255) throw new Error("an image left part of its canvas transparent");
      rows[row + 1 + x * 3] = pixels[from];
      rows[row + 2 + x * 3] = pixels[from + 1];
      rows[row + 3 + x * 3] = pixels[from + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(path.slice(root.length));
}

/** ios masks the icon itself and refuses transparency, so the logo runs to every edge */
const iosIcon = svg(1024, 1024, logoTile());

/** the launch image is a square the storyboard fills the screen with, so the logo sits small in the middle of the app's
 * own first-paint colour and survives the crop on every screen shape */
const splash = (ground) => svg(2732, 2732, `<rect width="2732" height="2732" fill="${ground}"/>${logoTile({ size: 320, x: 1206, y: 1206, radius: 72 })}`);

const ios = join(root, "apps/mobile/ios/App/App/Assets.xcassets");
write(join(ios, "AppIcon.appiconset/AppIcon-512@2x.png"), png(iosIcon, 1024));
write(join(ios, "Splash.imageset/splash-light.png"), png(splash(LIGHT), 2732));
write(join(ios, "Splash.imageset/splash-dark.png"), png(splash(DARK), 2732));
writeFileSync(join(ios, "Splash.imageset/Contents.json"), `${JSON.stringify({
  images: [
    { idiom: "universal", filename: "splash-light.png", scale: "1x" },
    { idiom: "universal", filename: "splash-dark.png", scale: "1x", appearances: [{ appearance: "luminosity", value: "dark" }] },
  ],
  info: { version: 1, author: "xcode" },
}, null, 2)}\n`);

/** android: the legacy square and round icons, and the adaptive layers: kit in front, inside the 66% safe zone, and
 * the sunrise behind */
const android = join(root, "apps/mobile/android/app/src/main/res");
const legacy = svg(1024, 1024, logoTile({ radius: 180 }));
const round = svg(1024, 1024, logoTile({ radius: 512 }));
const kitCell = (1024 * 0.46) / 21;
const foreground = svg(1024, 1024, logoTile({ size: kitCell * LOGO_SIZE, x: 512 - kitCell * 16, y: 512 - kitCell * 16.5, grid: KIT_ONLY }));
const background = svg(1024, 1024, logoTile({ grid: SCENE }));
/** android's launch images come in each screen shape; the logo is a fifth of the short side */
const launch = (width, height) => {
  const side = Math.min(width, height) / 5;
  return svg(width, height, `<rect width="${width}" height="${height}" fill="${LIGHT}"/>${logoTile({ size: side, x: (width - side) / 2, y: (height - side) / 2, radius: side * 0.225 })}`);
};
write(join(android, "drawable/splash.png"), png(launch(480, 320), 480));
// Android masks notification small icons by alpha alone: use the white monochrome cat silhouette with cutout eyes,
// centered inside a 24dp viewport with ~2.7dp horizontal / 3.3dp vertical padding.
const notificationIcon = [
  `<vector xmlns:android="http://schemas.android.com/apk/res/android"`,
  `    android:width="24dp"`,
  `    android:height="24dp"`,
  `    android:viewportWidth="18"`,
  `    android:viewportHeight="18">`,
  `    <path`,
  `        android:fillColor="#FFFFFFFF"`,
  `        android:fillType="evenOdd"`,
  `        android:pathData="${glyphPath(KIT_GLYPH, { x: 1, y: 0.5 })}" />`,
  `</vector>`,
  "",
].join("\n");
write(join(android, "drawable/ic_stat_duskbot.xml"), notificationIcon);
for (const [density, size, short, long] of [["mdpi", 48, 320, 480], ["hdpi", 72, 480, 800], ["xhdpi", 96, 720, 1280], ["xxhdpi", 144, 960, 1600], ["xxxhdpi", 192, 1280, 1920]]) {
  write(join(android, `mipmap-${density}/ic_launcher.png`), png(legacy, size, true));
  write(join(android, `mipmap-${density}/ic_launcher_round.png`), png(round, size, true));
  write(join(android, `mipmap-${density}/ic_launcher_foreground.png`), png(foreground, Math.round(size * 2.25), true));
  write(join(android, `mipmap-${density}/ic_launcher_background.png`), png(background, Math.round(size * 2.25)));
  write(join(android, `drawable-port-${density}/splash.png`), png(launch(short, long), short));
  write(join(android, `drawable-land-${density}/splash.png`), png(launch(long, short), long));
}
