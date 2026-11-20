import { useState } from "react";
import { cn } from "@/lib/cn";
import { appLogoUrl, siteIconUrl } from "@/lib/site-icon";

/** One connectable app as the Apps catalog lists it. */
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
  categories?: string[];
}

/** An app's logo, then its site's own icon, then its initial. */
export function ServiceIcon({ card, className = "size-11" }: { card: Pick<ToolkitCard, "logo" | "domain" | "label">; className?: string }) {
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return (
      <img
        src={card.logo}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(1)}
      />
    );
  }
  const siteIcon = siteIconUrl(card.domain);
  if (stage === 1 && siteIcon) {
    return (
      <img
        src={siteIcon}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className={cn("flex items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary", className)}>
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

const TILE = "relative inline-flex shrink-0 items-center justify-center overflow-hidden border border-transparent box-border leading-none";

export interface TileArt { label: string; logo?: string | null; domain?: string | null; image?: string; padded?: boolean; background?: string; scale?: number }

/** Grok's app tile: a hairline square whose corners grow with it (11px at 40, 16px at 56). An app icon fills it; a bare
 * mark sits at 68% of it, on its own paint when it has one; with no art, the app's initial on a faint fill. */
const INITIAL_TINTS = ["#c2ecfc", "#d0cefb", "#ffc4dd", "#fff3a0", "#c9f63f"];
const initialTint = (label: string) => INITIAL_TINTS[[...label].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % INITIAL_TINTS.length];

export function ServiceTile({ card, size = 40, className }: { card: TileArt; size?: number; className?: string }) {
  const sources = [...new Set([card.image, card.logo && appLogoUrl(card.logo), card.logo, siteIconUrl(card.domain)])]
    .filter((source): source is string => Boolean(source));
  // failures count against this list of sources only: an app whose art arrives later starts over from its best source
  const sourcesKey = sources.join("\n");
  const [failure, setFailure] = useState({ key: sourcesKey, count: 0 });
  const failed = failure.key === sourcesKey ? failure.count : 0;
  const setFailed = (next: (count: number) => number) => setFailure({ key: sourcesKey, count: next(failed) });
  const source = sources[failed];
  const frame = { width: size, height: size, borderRadius: Math.round(size * 0.28), background: card.background };
  if (!source) {
    return (
      <span aria-hidden="true" className={cn(TILE, "font-semibold text-[#1b1b1f]", className)} style={{ ...frame, background: card.background ?? initialTint(card.label), fontSize: Math.round(size * 0.42) }}>
        {card.label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const padded = card.padded || source !== card.image;
  const inner = padded ? size * (card.scale ?? 0.684) : size - 2;
  return (
    <span aria-hidden="true" data-service-tile-bare={padded && !card.background ? "" : undefined} className={cn(TILE, className)} style={frame}>
      <img key={source} src={source} alt="" draggable={false} loading="lazy" decoding="async" width={inner} height={inner} style={{ width: inner, height: inner }} className="object-contain" onError={() => setFailed((count) => count + 1)} />
    </span>
  );
}
