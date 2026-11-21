// the focus ring is for someone moving with the keyboard. tab or an arrow key turns it on; a click, a tap or any other
// key (enter opening a dialog, typing) turns it off, so focus a dialog or a click leaves behind draws no ring. in a text
// field an arrow, home or end moves the caret, not the focus, so it leaves the ring as it was.
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
const TEXT_FIELD = 'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="button"], [type="submit"], [type="reset"], [type="image"]), textarea, [contenteditable="true"], [role="textbox"]';

export function focusNavKey(key: string, inTextField = false): boolean | null {
  if (MODIFIERS.has(key)) return null;
  if (!NAV_KEYS.has(key)) return false;
  return inTextField && key !== "Tab" ? null : true;
}

export function watchFocusNav(root: HTMLElement = document.documentElement): () => void {
  const set = (on: boolean) => { if (on) root.setAttribute("data-focus-nav", ""); else root.removeAttribute("data-focus-nav"); };
  const onKey = (event: KeyboardEvent) => {
    const nav = focusNavKey(event.key, event.target instanceof Element && event.target.matches(TEXT_FIELD));
    if (nav !== null) set(nav);
  };
  const onPointer = () => set(false);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
  };
}
