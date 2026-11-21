import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "../Icon";

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="ca-group-title">{title}</h3>
      {children}
    </section>
  );
}

export function ResultGroup({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <div role="group" aria-label={label}>
      <div className="ca-results-label" aria-hidden="true">{label}</div>
      {children}
    </div>
  );
}

export function Option({ index, active, onHover, onPick, icon, label }: {
  index: number;
  active: number;
  onHover: (index: number) => void;
  onPick: () => void;
  icon?: ReactNode;
  label: string;
}) {
  return (
    <button type="button" role="option" id={`ca-option-${index}`} tabIndex={-1} aria-selected={index === active} className="ca-option"
      onMouseMove={() => { if (index !== active) onHover(index); }} onClick={onPick}>
      {icon}
      <span>{label}</span>
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

/** The thin thumb, in a component of its own: it moves on every scroll frame and the window around it never renders for it. */
export function ScrollThumb({ scroller, page }: { scroller: React.RefObject<HTMLDivElement | null>; page: string }) {
  const thumb = useScrollThumb(scroller, page);
  if (!thumb) return null;
  return (
    <div role="presentation" className="ca-scrollbar" data-scrolling={thumb.scrolling ? "" : undefined}>
      <div style={{ top: thumb.top, height: thumb.height }} />
    </div>
  );
}

function useScrollThumb(scroller: React.RefObject<HTMLDivElement | null>, key: string) {
  const [thumb, setThumb] = useState<{ top: number; height: number; scrolling: boolean } | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (scrolling: boolean) => {
      const { scrollHeight, clientHeight, scrollTop } = element;
      if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
      const track = clientHeight - 6;
      const height = Math.max(20, (clientHeight / scrollHeight) * track);
      setThumb({ top: (scrollTop / (scrollHeight - clientHeight)) * (track - height), height, scrolling });
    };
    const onScroll = () => {
      measure(true);
      clearTimeout(timer);
      timer = setTimeout(() => measure(false), 800);
    };
    measure(false);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure(false));
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scroller, key]);
  return thumb;
}

