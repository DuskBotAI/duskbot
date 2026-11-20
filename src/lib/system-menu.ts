export interface SystemMenuItem { key: string; label: string; detail?: string; symbol?: string; checked?: boolean; disabled?: boolean; danger?: boolean; separated?: boolean }

/** Opens the device's own menu from the control at `anchor` and resolves the key picked, or null when none was. */
export type SystemMenuPresenter = (anchor: DOMRect, items: SystemMenuItem[]) => Promise<string | null>;

let presenter: SystemMenuPresenter | null = null;

/** The phone app installs its platform's menu here, so shared controls open it without knowing the phone layer. */
export function installSystemMenu(next: SystemMenuPresenter | null): void {
  presenter = next;
}

export function systemMenu(): SystemMenuPresenter | null {
  return presenter;
}
