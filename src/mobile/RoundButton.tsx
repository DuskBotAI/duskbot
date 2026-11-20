import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ArrowLeft, ChevronLeft } from "../icons";

/** Grok's floating round control: 44pt, a white disc with a soft shadow over content (glass on an iPhone), a quiet grey
 * disc inside sheets. Press is the .96 scale with the release overshoot, in CSS so it never waits on React. */
export const RoundButton = forwardRef<HTMLButtonElement, {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  size?: number;
  floating?: boolean;
  /** the chat header's glass instead of the white disc */
  glass?: boolean;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
  [data: `data-${string}`]: string | undefined;
}>(function RoundButton({ label, onClick, children, size = 44, floating = false, glass = false, className, pressed, disabled, ...data }, ref) {
  return (
    <button
      {...data}
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "mobile-press relative inline-flex shrink-0 items-center justify-center rounded-full text-ink disabled:opacity-40",
        glass ? "m-glass" : floating ? "mobile-float mobile-glass bg-composer" : "bg-menu",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  );
});

/** Back as each platform draws it: Material's arrow on Android, the chevron on iOS. */
export function BackGlyph({ size = 20, strokeWidth }: { size?: number; strokeWidth?: number }) {
  return document.documentElement.dataset.mobileApp === "android" ? <ArrowLeft size={size} strokeWidth={strokeWidth} /> : <ChevronLeft size={size} strokeWidth={strokeWidth} />;
}
