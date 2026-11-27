import { Box, Cloud, Globe, Monitor, Power, Sparkles, type GlyphProps } from "../icons";
import type { EffectivePlace } from "@/lib/place";

const ICONS = { cloud: Cloud, vm: Box, local: Monitor, browser: Globe, auto: Sparkles, off: Power } as const;

export const placeGlyph = (place: EffectivePlace) => ICONS[place];

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & GlyphProps) {
  const Icon = ICONS[place];
  return <Icon {...props} />;
}
