import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "../icons";
import { fileGone, requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { t } from "@/lib/i18n";

/** A preview limit, not a download limit. */
export const PDF_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
/** Pages drawn at first; the rest follow a page at a time as they scroll near. */
const FIRST_PAGES = 2;

type PdfDocument = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> };
type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }): { promise: Promise<void>; cancel(): void };
};

async function openPdf(data: ArrayBuffer): Promise<PdfDocument> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?worker")]);
  // a bundled .js worker: the app's own file server (Capacitor 8) types each file by its extension
  pdfjs.GlobalWorkerOptions.workerPort ??= new worker.default();
  return await pdfjs.getDocument({ data }).promise as unknown as PdfDocument;
}

function PdfPageCanvas({ doc, number, width, eager }: { doc: PdfDocument; number: number; width: number; eager: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [ratio, setRatio] = useState(1.294);
  useEffect(() => {
    const el = canvas.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return setNear(true);
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { setNear(true); observer.disconnect(); } }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near || !width) return;
    let task: { cancel(): void } | null = null;
    let alive = true;
    void doc.getPage(number).then((page) => {
      const el = canvas.current;
      if (!alive || !el) return;
      const base = page.getViewport({ scale: 1 });
      const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      setRatio(base.height / base.width);
      const run = page.render({ canvas: el, viewport });
      task = run;
      return run.promise;
    }).catch(() => {});
    return () => { alive = false; task?.cancel(); };
  }, [doc, number, width, near]);
  return <canvas ref={canvas} aria-label={t("pdf.page", { number, count: doc.numPages })} role="img"
    className="block w-full rounded-[6px] bg-white shadow-[0_1px_4px_rgb(0_0_0/0.12)]" style={{ aspectRatio: String(1 / ratio) }} />;
}

/** A PDF a bot sent, its pages drawn one under another at the width of the preview. */
export function PdfFileContent({ path, message }: { path: string; message: MessageAttachmentContext }) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<"gone" | "size" | "load" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let opened: PdfDocument | null = null;
    setError(null);
    setDoc(null);
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        if (Number(response.headers.get("content-length")) > PDF_PREVIEW_MAX_BYTES) { await response.body?.cancel(); throw new Error("size"); }
        const data = await response.arrayBuffer();
        if (data.byteLength > PDF_PREVIEW_MAX_BYTES) throw new Error("size");
        opened = await openPdf(data);
        if (controller.signal.aborted) return void opened.destroy();
        setDoc(opened);
      } catch (reason) {
        if (!controller.signal.aborted) setError(fileGone(reason) ? "gone" : (reason as Error)?.message === "size" ? "size" : "load");
      }
    })();
    return () => { controller.abort(); void opened?.destroy(); };
  }, [path, message.threadId, message.messageId, attempt]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  return (
    <div ref={box} data-pdf-preview="" className="flex flex-col gap-3 pb-4">
      {error ? (
        <div className="p-8 text-center text-sm">
          <p role="alert" className="mb-3 text-ink-secondary">{t(error === "gone" ? "attach.gone" : error === "size" ? "pdf.tooLarge" : "pdf.loadFailed")}</p>
          {error === "load" && <button type="button" className="rounded-lg border border-transparent px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button>}
        </div>
      ) : !doc ? (
        <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("filePreview.loading")}</div>
      ) : (
        Array.from({ length: doc.numPages }, (_, index) => <PdfPageCanvas key={index} doc={doc} number={index + 1} width={width} eager={index < FIRST_PAGES} />)
      )}
    </div>
  );
}
