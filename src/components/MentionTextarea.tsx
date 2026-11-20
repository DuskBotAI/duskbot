import { cn } from "@/lib/cn";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject, type TextareaHTMLAttributes } from "react";
import { openExternalLink } from "@/lib/app-links";
import { type MentionPeer } from "@/lib/mentions";
import { MentionText } from "./MentionText";

const TEXT_LAYOUT = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-feature-settings", "font-variation-settings",
  "letter-spacing", "word-spacing", "line-height", "text-indent", "tab-size", "padding-top", "padding-right", "padding-bottom", "padding-left"] as const;

export function MentionTextarea({ inputRef, peers, everyone = false, wrapperClassName, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  wrapperClassName?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  peers: readonly MentionPeer[];
  everyone?: boolean;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [hoverStart, setHoverStart] = useState<number | null>(null);
  // the link a mouse press landed on, and whether the caret was already inside it (then the click edits, not opens)
  const pressRef = useRef<{ start: number; href: string; editing: boolean } | null>(null);
  // a tap places the caret, as phones expect; only a mouse click opens a link
  const pointerRef = useRef("mouse");
  // the field sits over the mirror, so the pointer is mapped onto the mirror's link boxes rather than hitting them
  const linkAt = useCallback((x: number, y: number) => {
    for (const link of mirrorRef.current?.querySelectorAll<HTMLElement>("[data-link-start]") ?? []) {
      const reach = parseFloat(getComputedStyle(link).fontSize) * 0.2;
      for (const box of link.getClientRects()) {
        if (x >= box.left - reach && x <= box.right + reach && y >= box.top && y <= box.bottom) {
          return { start: Number(link.dataset.linkStart), end: Number(link.dataset.linkEnd), href: link.dataset.href ?? "" };
        }
      }
    }
    return null;
  }, []);
  useEffect(() => setHoverStart(null), [props.value]);
  const sync = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const style = getComputedStyle(input);
    for (const property of TEXT_LAYOUT) mirror.style.setProperty(property, style.getPropertyValue(property));
    mirror.style.width = `${input.clientWidth}px`;
    // the field can carry a margin inside the wrapper, or the wrapper a padding; the mirror sits exactly over the field,
    // or the text drifts off the caret
    mirror.style.top = `${input.offsetTop}px`;
    mirror.style.left = `${input.offsetLeft}px`;
    mirror.style.right = "auto";
    mirror.style.height = `${input.clientHeight}px`;
    mirror.style.bottom = "auto";
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [inputRef]);
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const scrollTop = input.scrollTop;
    const line = parseFloat(getComputedStyle(input).lineHeight) || 24;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, line * 6)}px`;
    input.scrollTop = scrollTop;
    sync();
  }, [inputRef, sync]);
  useLayoutEffect(resize, [props.value, props.className, resize]);
  useLayoutEffect(() => {
    let width = inputRef.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      // Observe width only, so setting the measured height cannot create a resize loop.
      const nextWidth = inputRef.current?.clientWidth;
      if (nextWidth !== width) { width = nextWidth; resize(); }
      else sync();
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => observer.disconnect();
  }, [inputRef, resize, sync]);
  return <div className={cn("mention-editor relative min-w-0 flex-1 self-center", wrapperClassName)}>
    <div ref={mirrorRef} dir={props.dir} aria-hidden="true" className="mention-editor-mirror pointer-events-none absolute inset-0 overflow-hidden">
      <MentionText text={String(props.value ?? "")} peers={peers} everyone={everyone} links="highlight" hoverStart={hoverStart} />{"\n"}
    </div>
    <textarea {...props} ref={inputRef}
      style={hoverStart === null ? props.style : { ...props.style, cursor: "pointer" }}
      onScroll={(event) => { sync(); setHoverStart(null); props.onScroll?.(event); }}
      onMouseMove={(event) => { setHoverStart(linkAt(event.clientX, event.clientY)?.start ?? null); props.onMouseMove?.(event); }}
      onMouseLeave={(event) => { setHoverStart(null); props.onMouseLeave?.(event); }}
      onPointerDown={(event) => { pointerRef.current = event.pointerType; props.onPointerDown?.(event); }}
      onMouseDown={(event) => {
        const link = pointerRef.current === "mouse" && event.button === 0 && !(event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) ? linkAt(event.clientX, event.clientY) : null;
        const input = event.currentTarget;
        pressRef.current = link && {
          start: link.start, href: link.href,
          editing: document.activeElement === input && input.selectionStart <= link.end && input.selectionEnd >= link.start,
        };
        props.onMouseDown?.(event);
      }}
      onClick={(event: MouseEvent<HTMLTextAreaElement>) => {
        const press = pressRef.current, input = event.currentTarget;
        pressRef.current = null;
        // a plain single click opens the link; a drag that selected text, a double click or a click into a link being edited stays editing
        if (press && !press.editing && event.detail === 1 && input.selectionStart === input.selectionEnd
          && linkAt(event.clientX, event.clientY)?.start === press.start) void openExternalLink(press.href);
        props.onClick?.(event);
      }} />
  </div>;
}
