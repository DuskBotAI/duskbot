import type { ControlCover } from "@/lib/system-control";

const OVERLAY_SEL = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-modal="true"]',
  '[data-panel-scrim]',
  '[data-modal-scrim]',
  '[data-phone-modal-layer]',
  '[data-phone-pushed-page]',
  '[data-phone-bot-page]',
  '.popover-surface',
  '.menu-surface',
  '.dusk-mobile-overlay',
  '.ui-toast',
].join(", ");

const ACTIVE_SLIDE_SEL = [
  "[data-phone-pushed-page][data-leaving]",
  "[data-phone-pushed-page][data-moving]",
  ".mobile-page[data-leaving]",
  ".mobile-page[data-moving]",
].join(", ");

const ROW_SEL = "[data-panel-row], [data-panel-routine], [data-select-row], [data-simple-app], [data-settings-row], .mobile-row, [role='switch'], [role='group'], label";

function coveredByForeignLayer(el: HTMLElement, hit: Element | null): boolean {
  if (!hit) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  if (overlay && !overlay.contains(el)) return true;
  const page = hit.closest(".mobile-page");
  if (page && !page.contains(el)) return true;
  return false;
}

function ownHit(el: HTMLElement, hit: Element | null): boolean {
  if (el.closest(".mobile-nav > [inert]")) {
    return !coveredByForeignLayer(el, hit);
  }
  if (!hit) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  if (overlay && !overlay.contains(el)) return false;
  if (el.contains(hit) || hit.contains(el)) return true;
  const row = el.parentElement?.closest(ROW_SEL);
  return Boolean(row && row.contains(hit));
}

function areaUncovered(area: HTMLElement, hit: Element | null): boolean {
  if (area.closest(".mobile-nav > [inert]")) {
    return !coveredByForeignLayer(area, hit);
  }
  if (!hit || !area.contains(hit)) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  return !overlay || overlay.contains(area);
}

function coveringLeft(el: HTMLElement): number | null {
  const modal = document.querySelector("[data-phone-modal-layer]:not([data-leaving])");
  if (modal && !modal.contains(el)) return -Infinity;
  const inModal = Boolean(el.closest("[data-phone-modal-layer]"));
  let left = Infinity;
  if (!inModal) {
    const ownPushed = el.closest<HTMLElement>("[data-phone-pushed-page], [data-phone-bot-page]");
    const ownZ = ownPushed ? Number.parseInt(getComputedStyle(ownPushed).zIndex, 10) || 0 : -Infinity;
    for (const pushed of document.querySelectorAll<HTMLElement>("[data-phone-pushed-page]:not([data-preparing]), [data-phone-bot-page]:not([data-preparing])")) {
      if (pushed === ownPushed || pushed.contains(el)) continue;
      if (ownPushed) {
        const z = Number.parseInt(getComputedStyle(pushed).zIndex, 10) || 0;
        if (z < ownZ) continue;
        if (z === ownZ && (ownPushed.compareDocumentPosition(pushed) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) continue;
      }
      left = Math.min(left, pushed.getBoundingClientRect().left);
    }
  }
  const nav = el.closest(".mobile-nav");
  if (nav) {
    for (const page of nav.querySelectorAll<HTMLElement>(":scope > .mobile-page")) {
      if (page.contains(el)) continue;
      left = Math.min(left, page.getBoundingClientRect().left);
    }
  }
  return Number.isFinite(left) ? left : null;
}

/** The phone shell's layers as a system control meets them: its sheets, pushed pages, stacked pages, dialogs and menus. */
export const phoneControlCover: ControlCover = {
  coveringLeft,
  ownHit,
  areaUncovered,
  sliding: () => document.querySelector(ACTIVE_SLIDE_SEL) !== null,
};
