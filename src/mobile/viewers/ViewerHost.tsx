import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Copy, Check } from "../../icons";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { setPhoneBridge, webFileShare, type PhoneBridge, type PhoneView } from "@/lib/phone-bridge";
import { haptic, KIND_ACTION } from "../haptics";
import { usePlatform } from "../platform";
import { RoundButton } from "../RoundButton";
import { Sheet } from "../Sheet";
import { CodeViewer } from "./CodeViewer";
import { ImageViewer } from "./ImageViewer";
import { TableViewer } from "./TableViewer";
import { ViewerNote } from "./ViewerNote";
import "./viewers.css";

/** a sheet's fall off the screen, so the view it shows stays drawn until it is gone */
const SHEET_EXIT_MS = 420;

/** A web address a tap in the app opens in the in-app browser rather than leaving the app. */
export function inAppLink(target: EventTarget | null): string | null {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  const href = anchor.getAttribute("href") ?? "";
  return /^https?:\/\//i.test(href) ? href : null;
}

/** A button on a card in the chat (an approval, a question, a connect, a retry), not one inside a reply's own words. */
function cardAction(target: EventTarget | null): boolean {
  const button = target instanceof Element ? target.closest("button:not(:disabled), [role='button']:not([aria-disabled='true'])") : null;
  return Boolean(button?.closest("[data-mobile-chat] [data-mid]") && !button.closest("[data-chat-bubble], [data-testid='message-actions']"));
}

function TextViewer({ text, open, onClose }: { text: string; open: boolean; onClose: () => void }) {
  const { state: copied, copy } = useCopyFeedback(text);
  return (
    <Sheet open={open} onClose={onClose} full title={t("mobile.select.title")}
      actions={[{ key: "copy", label: t("mobile.select.copyAll"), symbol: copied === "copied" ? "checkmark" : "doc.on.doc", onPress: () => void copy() }]}
      trailing={<RoundButton label={t("mobile.select.copyAll")} onClick={copy}>{copied === "copied" ? <Check size={18} className="text-success" /> : <Copy size={18} />}</RoundButton>}>
      <p className="px-4 pb-2 text-[13px] text-ink-tertiary">{t("mobile.select.hint")}</p>
      <div data-selectable="" className="mx-3 whitespace-pre-wrap break-words rounded-2xl bg-ink/[0.04] px-4 py-3 text-[17px] leading-[1.55] text-ink">
        {text}
      </div>
      <ViewerNote show={copied !== "idle"} text={copied === "failed" ? t("common.copyFailed") : t("mobile.viewer.copied")} failed={copied === "failed"} />
    </Sheet>
  );
}

/** Registers the phone's answers to shared chat components and draws what they open full screen: code,
 * pictures, a message's text to select, and any other page a component hands over. Web links tapped anywhere in the
 * app open in the in-app browser. */
export function ViewerHost({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const platform = usePlatform();
  const [shown, setShown] = useState<{ view: PhoneView; onClose?: () => void; key: number } | null>(null);
  const [open, setOpen] = useState(false);
  const exit = useRef(0);

  const openView = useRef<PhoneBridge["view"]>(() => {});
  openView.current = (view, onClose) => {
    window.clearTimeout(exit.current);
    setShown((before) => { before?.onClose?.(); return { view, onClose, key: (before?.key ?? 0) + 1 }; });
    setOpen(true);
  };
  const bridge = useMemo(() => bridgeFor(platform, (view, onClose) => openView.current(view, onClose)), [platform]);
  useLayoutEffect(() => setPhoneBridge(bridge), [bridge]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (cardAction(event.target)) haptic("pick");
      if (event.defaultPrevented) return;
      const url = inAppLink(event.target);
      if (!url) return;
      event.preventDefault();
      haptic("tap");
      void platform.openExternal(url).catch(() => {});
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [rootRef, platform]);

  const close = () => {
    setOpen(false);
    const done = shown;
    window.clearTimeout(exit.current);
    exit.current = window.setTimeout(() => { setShown((now) => now === done ? null : now); done?.onClose?.(); }, done?.view.kind === "images" ? 0 : SHEET_EXIT_MS);
  };
  useEffect(() => () => window.clearTimeout(exit.current), []);

  if (!shown) return null;
  const { view, key } = shown;
  if (view.kind === "images") return <ImageViewer key={key} images={view.images} initialIndex={view.index} bridge={bridge} onClose={close} />;
  if (view.kind === "code") return <CodeViewer key={key} code={view.code} lang={view.lang} open={open} onClose={close} />;
  if (view.kind === "table") return <TableViewer key={key} columns={view.columns} rows={view.rows} name={view.name} direction={view.direction} open={open} onClose={close} />;
  if (view.kind === "text") return <TextViewer key={key} text={view.text} open={open} onClose={close} />;
  return (
    <Sheet key={key} open={open} onClose={close} full title={view.title} trailing={view.actions}>
      {view.body}
    </Sheet>
  );
}

function bridgeFor(platform: ReturnType<typeof usePlatform>, view: PhoneBridge["view"]): PhoneBridge {
  return {
    haptic: (kind) => haptic(KIND_ACTION[kind]),
    openLink: (url) => void platform.openExternal(url).catch(() => {}),
    share: platform.share,
    shareFile: platform.shareFile ?? webFileShare(),
    view,
  };
}
