// One section of an apps catalog, drawn as Grok's: a 14px title, View all at its end, then two columns of rows.
export function AppsSection({ id, title, note, viewAll, after, hideTitle = false, children }: {
  id: string;
  title: string;
  note?: string;
  viewAll?: { label: string; onClick: () => void };
  after?: React.ReactNode;
  /** a list that needs no visible title (the whole catalog under its own window's name): it still names the section */
  hideTitle?: boolean;
  children: React.ReactNode;
}) {
  if (hideTitle && !note && !viewAll) {
    return (
      <section aria-labelledby={id} data-apps-section={id} className="flex flex-col gap-2">
        <h3 id={id} className="sr-only">{title}</h3>
        <div className="grid grid-cols-1 items-start gap-x-2 gap-y-0.5 @xl:grid-cols-2">{children}</div>
        {after}
      </section>
    );
  }
  return (
    <section aria-labelledby={id} data-apps-section={id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className="m-0 min-w-0 truncate pb-1.5 pe-2 ps-3 pt-2 text-[14px] font-medium leading-5 tracking-[0.01em] text-ink">
          {title}
          {note && <span className="ms-2 text-[12px] font-normal text-ink-secondary">{note}</span>}
        </h3>
        {viewAll && (
          <button
            type="button"
            onClick={viewAll.onClick}
            className="me-1 shrink-0 rounded-full px-2 py-0.5 text-[12px] leading-4 tracking-[0.015em] text-ink/[0.68] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          >
            {viewAll.label}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 items-start gap-x-2 gap-y-0.5 @xl:grid-cols-2">{children}</div>
      {after}
    </section>
  );
}
