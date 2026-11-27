// the dusk logo: kit, the white pixel cat, in front of a sunrise, one cell per pixel of a 33 by 33 grid

export const LOGO_SIZE = 33;
export const KIT = "#ffffff";
export const EYE = "#212121";

const PALETTE = ["#06bafd", "#212121", "#3cd0fd", "#43d1fd", "#87e2fc", "#90e4fc", "#c2ecfc", "#c6f43a", "#c9f63f", "#ccf746", "#d0cefb", "#ffffff"];
const ROWS = [
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "222222222222222222222222222222222",
  "222222222222222222222222222222222",
  "22222222b22222222222222b222222222",
  "22222222bb222222222222bb222222222",
  "2222222bbbb2222222222bbbb22222222",
  "2222222bbbbb22222222bbbbb22222222",
  "2222222bbbbbb222222bbbbbb22222222",
  "2222222bbbbbbbbbbbbbbbbbb22222222",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "444444bbbbbbbbbbbbbbbbbbbb4444444",
  "444444bbbb111bbbbbb111bbbb4444444",
  "555555bbbb111bbbbbb111bbbb5555555",
  "666666bbbb111bbbbbb111bbbb6666666",
  "666666bbbb111bbbbbb111bbbb6666666",
  "666666bbbb111bbbbbb111bbbb6666666",
  "aaaaaabbbb111bbbbbb111bbbb6888888",
  "8aaa88bbbbbbbbbbbbbbbbbbbb8888888",
  "877788bbbbbbbbbbbbbbbbbbbb8888887",
  "8777888bbbbbbbbbbbbbbbbbb88888887",
  "88888887bbbbbbbbbbbbbbbb888887888",
  "7888778888bbbbbbbbbbbb77787887888",
  "788877888888888888888888888888888",
  "788877778888888888788888888888887",
  "888888888888888888788778877888778",
  "888888778888887888888887787888888",
  "888888778888887888888888787888888",
  "788788888888888888899888887887888",
];

/** the logo as rows of hex colours */
export const LOGO = ROWS.map((row) => [...row].map((c) => PALETTE[parseInt(c, 16)]));

const isKit = (c) => c === KIT || c === EYE;

/** the sunrise alone: each kit cell takes the scene colour beside it on its row */
export const SCENE = LOGO.map((row) => row.map((c, x) => {
  if (!isKit(c)) return c;
  for (let d = 1; d < row.length; d++) {
    if (x - d >= 0 && !isKit(row[x - d])) return row[x - d];
    if (x + d < row.length && !isKit(row[x + d])) return row[x + d];
  }
  return c;
}));

const DUSK = {
  "#06bafd": "#192830", "#3cd0fd": "#1b2d35", "#43d1fd": "#1b2e36", "#87e2fc": "#1e343d", "#90e4fc": "#1e353e",
  "#c2ecfc": "#203742", "#c6f43a": "#2b311f", "#c9f63f": "#2b311f", "#ccf746": "#2c3220", "#d0cefb": "#232342",
};

/** the sunrise after dark, for the macOS dark icon appearance */
export const SCENE_DARK = SCENE.map((row) => row.map((c) => DUSK[c]));

/** kit alone, the scene left empty */
export const KIT_ONLY = LOGO.map((row) => row.map((c) => (isKit(c) ? c : null)));

/** svg rects for a grid of colours (null is empty), each run of one colour on a row merged into one rect */
export function cells(grid, { x = 0, y = 0, cell = 1 } = {}) {
  let out = "";
  grid.forEach((row, j) => {
    for (let i = 0; i < row.length; ) {
      const c = row[i];
      let k = i + 1;
      while (k < row.length && row[k] === c) k++;
      if (c) out += `<rect x="${+(x + i * cell).toFixed(3)}" y="${+(y + j * cell).toFixed(3)}" width="${+((k - i) * cell).toFixed(3)}" height="${+cell.toFixed(3)}" fill="${c}"/>`;
      i = k;
    }
  });
  return `<g shape-rendering="crispEdges">${out}</g>`;
}

/** the whole logo filling a box of `size` at (x, y), its corners rounded by `radius` */
export function logoTile({ size = 1024, x = 0, y = 0, radius = 0, grid = LOGO, id = "logo-tile" } = {}) {
  const cell = size / LOGO_SIZE;
  if (!radius) return cells(grid, { x, y, cell });
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}"/></clipPath><g clip-path="url(#${id})">${cells(grid, { x, y, cell })}</g>`;
}

export const svg = (w, h, inner, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>${inner}</svg>`;

/** kit simplified to read in a 16 px menu bar: # is body, . is empty (the eyes are holes) */
export const KIT_GLYPH = [
  "................",
  "................",
  "..#..........#..",
  "..##........##..",
  "..###......###..",
  "..############..",
  ".##############.",
  ".###..####..###.",
  ".###..####..###.",
  ".###..####..###.",
  ".###..####..###.",
  ".##############.",
  ".##############.",
  "..############..",
  "...##########...",
  "................",
];

/** Closed seam-free SVG / Android VectorDrawable contour path for a `#`/`.` glyph grid (outer loops clockwise, holes
 * counter-clockwise, so both non-zero and even-odd fills cut out the eyes cleanly). */
export function glyphPath(glyph, { x = 0, y = 0, scale = 1 } = {}) {
  const filled = (cx, cy) => cy >= 0 && cy < glyph.length && cx >= 0 && cx < glyph[cy].length && glyph[cy][cx] === "#";
  const next = new Map();
  const add = (x1, y1, x2, y2) => {
    const key = `${x1},${y1}`;
    const list = next.get(key) ?? [];
    list.push([x2, y2]);
    next.set(key, list);
  };
  for (let cy = 0; cy < glyph.length; cy++) {
    for (let cx = 0; cx < glyph[cy].length; cx++) {
      if (!filled(cx, cy)) continue;
      if (!filled(cx, cy - 1)) add(cx, cy, cx + 1, cy);
      if (!filled(cx + 1, cy)) add(cx + 1, cy, cx + 1, cy + 1);
      if (!filled(cx, cy + 1)) add(cx + 1, cy + 1, cx, cy + 1);
      if (!filled(cx - 1, cy)) add(cx, cy + 1, cx, cy);
    }
  }
  const n = (v) => String(+(v).toFixed(3));
  const loops = [];
  for (const [startKey, edges] of next) {
    while (edges.length) {
      const [sx, sy] = startKey.split(",").map(Number);
      const pts = [[sx, sy]];
      let [cx, cy] = edges.pop();
      let dx = cx - sx, dy = cy - sy;
      while (cx !== sx || cy !== sy) {
        pts.push([cx, cy]);
        const list = next.get(`${cx},${cy}`);
        // At a corner touching diagonally, turn right first so loops stay disjoint.
        const pick = list.length === 1 ? 0 : list.findIndex(([nx, ny]) => (nx - cx) === -dy && (ny - cy) === dx);
        const [nx, ny] = list.splice(pick >= 0 ? pick : 0, 1)[0];
        dx = nx - cx;
        dy = ny - cy;
        cx = nx;
        cy = ny;
      }
      const corners = pts.filter((p, i) => {
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[(i + 1) % pts.length];
        return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
      });
      let d = `M${n(x + corners[0][0] * scale)},${n(y + corners[0][1] * scale)}`;
      for (let i = 1; i < corners.length; i++) {
        const [, py] = corners[i - 1], [qx, qy] = corners[i];
        d += qy === py ? `H${n(x + qx * scale)}` : `V${n(y + qy * scale)}`;
      }
      loops.push(`${d}Z`);
    }
  }
  return loops.join(" ");
}
