/** Scrolls the sidebar just enough to show the row of the open bot or group chat. Returns whether that row is drawn. */
export function revealSidebarRow(root: ParentNode | null | undefined, id: string | null | undefined): boolean {
  if (!root || !id) return false;
  const row = [...root.querySelectorAll<HTMLElement>("[data-sidebar-bot-row], [data-sidebar-group-row]")]
    .find((element) => element.dataset.sidebarBotRow === id || element.dataset.sidebarGroupRow === id);
  row?.scrollIntoView({ block: "nearest" });
  return row !== undefined;
}

/** Reveals an open chat's row once: again only when another chat opens, or while its row is not drawn yet. A list that
 * changes afterwards leaves the person's own scroll position alone. */
export function openRowRevealer(): (root: ParentNode | null | undefined, id: string | null | undefined) => void {
  let revealed: string | null = null;
  return (root, id) => {
    const open = id ?? null;
    if (open === revealed) return;
    if (!open || revealSidebarRow(root, open)) revealed = open;
  };
}
