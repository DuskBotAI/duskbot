import { useId, useRef, type ReactNode } from "react";
import { ChevronRight } from "../../icons";
import { cn } from "@/lib/cn";
import { SYSTEM_SWITCH_ROOM, useSystemControl } from "@/lib/system-control";

/** A group of rows, iOS Settings' inset group: a quiet label over white rows, a hint under it. A `card` stands on the
 * sheet's own edge; without it the group sits in a list that already insets its content (search, notifications). */
export function SettingsSection({ title, hint, card = false, children }: { title?: string; hint?: ReactNode; card?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cn(card ? "mt-7 px-4" : "mt-6 px-2", "first:mt-0")}>
      {title && <h2 id={id} className="px-4 pb-1 text-[14px] font-medium text-ink-secondary">{title}</h2>}
      <div data-settings-card="" className="flex flex-col gap-[2px] overflow-hidden rounded-[16px] [&_.mobile-row]:rounded-none">{children}</div>
      {hint && <p className="px-4 pt-2 text-[13px] leading-[18px] text-ink-secondary">{hint}</p>}
    </section>
  );
}

export function SettingsRow({ icon, label, detail, value, onClick, href, chevron = Boolean(onClick || href), danger = false }: {
  icon?: ReactNode;
  label: string;
  detail?: string;
  value?: ReactNode;
  onClick?: () => void;
  href?: string;
  chevron?: boolean;
  danger?: boolean;
}) {
  const className = cn("flex min-h-[52px] w-full items-center gap-3 rounded-2xl px-4 py-2 text-left", (onClick || href) && "mobile-row", danger ? "text-danger" : "text-ink");
  const content = <>
    {icon && <span aria-hidden className="shrink-0 text-ink-secondary [&>svg]:size-5">{icon}</span>}
    <span className="min-w-0 flex-1">
      <span className="block text-[16px] font-medium">{label}</span>
      {detail && <span className="mt-0.5 block text-[13px] leading-[18px] text-ink-secondary">{detail}</span>}
    </span>
    {value != null && <span className="max-w-[45%] shrink-0 truncate text-[15px] text-ink-secondary">{value}</span>}
    {chevron && <ChevronRight aria-hidden size={18} className="shrink-0 text-ink-tertiary" />}
  </>;
  if (href) return <a href={href} onClick={onClick} data-settings-row="" className={className}>{content}</a>;
  if (onClick) return <button type="button" onClick={onClick} data-settings-row="" className={className}>{content}</button>;
  return <div data-settings-row="" className={className}>{content}</div>;
}

export function SettingsSwitch({ icon, label, detail, checked, onChange }: { icon?: ReactNode; label: string; detail?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  const room = useRef<HTMLSpanElement>(null);
  const system = useSystemControl(room, { kind: "switch", on: checked, label }, (on) => { if (on !== checked) onChange(Boolean(on)); });
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={id} aria-describedby={detail ? `${id}-detail` : undefined} onClick={() => onChange(!checked)} className="mobile-row flex min-h-[52px] w-full items-center gap-3 rounded-2xl px-4 py-2 text-left text-ink">
      {icon && <span aria-hidden className="shrink-0 text-ink-secondary [&>svg]:size-5">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span id={id} className="block text-[16px] font-medium">{label}</span>
        {detail && <span id={`${id}-detail`} className="mt-0.5 block text-[13px] leading-[18px] text-ink-secondary">{detail}</span>}
      </span>
      {system ? <span ref={room} aria-hidden className="shrink-0" style={SYSTEM_SWITCH_ROOM} /> : <span ref={room} aria-hidden className="mobile-switch" data-on={checked ? "" : undefined}><span /></span>}
    </button>
  );
}
