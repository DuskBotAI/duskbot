import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { DURATION } from "@/lib/motion-presets";

const COLLAPSE_MS = Math.round(DURATION.base * 1000);

/** A section's rows, folding shut and open under its header; while shutting it keeps the rows it last had.
 * `animate` off leaves them unwrapped. */
export const SectionRows = memo(function SectionRows({ open, animate, children }: { open: boolean; animate: boolean; children: ReactNode }) {
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const lastChildren = useRef<ReactNode>(open ? children : null);
  if (open) lastChildren.current = children;

  useEffect(() => {
    if (!animate) {
      setRendered(open);
      setExpanded(open);
      return;
    }
    if (open) {
      setRendered(true);
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setRendered(false), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [open, animate]);

  if (!animate) return open ? <>{children}</> : null;
  if (!rendered) return null;

  return (
    <div
      data-sidebar-section-rows=""
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className={cn("flex min-h-0 min-w-0 flex-col gap-1", expanded ? "overflow-visible" : "overflow-hidden")}>
        {open ? children : lastChildren.current}
      </div>
    </div>
  );
});
