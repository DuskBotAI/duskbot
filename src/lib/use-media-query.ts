import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
      if (!media) return () => {};
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Tailwind's md breakpoint. */
export const SIDEBAR_INLINE = "(min-width: 768px)";

/** Below Tailwind's md breakpoint: the phone layout, where the sidebar is a full-screen bot list. */
export const PHONE_LAYOUT = "(max-width: 767.98px)";

/** The phone layout: a narrow window, or the phone app at any width, an iPhone on its side included. */
export function usePhoneLayout(): boolean {
  const narrow = useMediaQuery(PHONE_LAYOUT);
  return narrow || Boolean(globalThis.document?.documentElement?.dataset?.mobileApp);
}
