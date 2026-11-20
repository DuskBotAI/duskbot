// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachToComposer, setNativeAttach } from "@/lib/native-attach";
import { useComposerFilePickers } from "./ComposerFilePickers";

function mount(onPick: (files: ArrayLike<File> | null) => void) {
  let pickers!: ReturnType<typeof useComposerFilePickers>;
  const Probe = () => { pickers = useComposerFilePickers(onPick); return pickers.inputs; };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(Probe)));
  return { pickers: () => pickers, container, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

describe("the composer's pickers on the phone app", () => {
  afterEach(() => { setNativeAttach(null); vi.unstubAllGlobals(); });

  it("opens the photo library and Files on the app's own pickers, never the web input that asks which one first", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
    const photo = new File(["x"], "image-1.jpg", { type: "image/jpeg" });
    const doc = new File(["y"], "notes.pdf", { type: "application/pdf" });
    const native = { photos: vi.fn(async () => [photo]), files: vi.fn(async () => [doc]) };
    setNativeAttach(native);
    const picked: File[][] = [];
    const app = mount((files) => picked.push(Array.from(files ?? [])));
    const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");
    app.pickers().choices!.photos();
    app.pickers().files();
    await vi.waitFor(() => expect(picked).toEqual([[photo], [doc]]));
    expect(inputClick).not.toHaveBeenCalled();
    app.unmount();
  });

  it("takes images handed over from outside the field, as one pasted into the native composer", () => {
    const picked: File[][] = [];
    const app = mount((files) => picked.push(Array.from(files ?? [])));
    const pasted = new File(["z"], "pasted-1.png", { type: "image/png" });
    attachToComposer([pasted]);
    expect(picked).toEqual([[pasted]]);
    app.unmount();
    attachToComposer([pasted]);
    expect(picked).toHaveLength(1);
  });
});
