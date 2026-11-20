import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
/** an AnimatePresence holding the conditional sits this close before it */
const PRESENCE_REACH = 300;

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "mobile" ? [] : sources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

/** GrokDialog, FormDialog and every component whose root is one of them (through DialogPane.Provider), transitively. */
function dialogComponents(files: Array<{ text: string }>): Set<string> {
  const dialogs = new Set(["GrokDialog", "FormDialog"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { text } of files) {
      const starts = [...text.matchAll(/(?:function|const)\s+([A-Z]\w*)\s*[=(:<]/g)];
      starts.forEach((start, i) => {
        const name = start[1]!;
        if (dialogs.has(name)) return;
        const body = text.slice(start.index, starts[i + 1]?.index ?? text.length);
        const root = /return\s*\(?\s*(?:<DialogPane\.Provider[^>]*>\s*)?<(\w+)/.exec(body)?.[1];
        if (root && dialogs.has(root)) { dialogs.add(name); grew = true; }
      });
    }
  }
  return dialogs;
}

// a dialog mounted as `{open && <Dialog />}` unmounts the frame it closes, so its way out (dialogMotion) never plays
it("mounts every desktop dialog inside an AnimatePresence, so it plays its way out", () => {
  const files = sources(SRC);
  const dialogs = dialogComponents(files);
  expect(dialogs.size, "the dialog family was found").toBeGreaterThan(10);
  const bare: string[] = [];
  for (const { path, text } of files) {
    for (const mount of text.matchAll(/&&\s*\(?\s*(?:<DialogPane\.Provider[^>]*>\s*)?<(\w+)\b/g)) {
      if (!dialogs.has(mount[1]!)) continue;
      const before = text.slice(0, mount.index);
      const opened = before.lastIndexOf("<AnimatePresence");
      if (opened > before.lastIndexOf("</AnimatePresence>") && mount.index - opened < PRESENCE_REACH) continue;
      bare.push(`${relative(SRC, path)}:${before.split("\n").length} ${mount[1]}`);
    }
  }
  expect(bare, "wrap each in <AnimatePresence>{open && <Dialog key=... />}</AnimatePresence>").toEqual([]);
});
