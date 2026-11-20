export interface IslandSize { side: number; pill: number; pillHeight: number; tile: number }
export declare const ISLAND_SIZES: Readonly<Record<"small" | "medium" | "large", Readonly<IslandSize>>>;
export declare const ISLAND_SIZE_IDS: readonly ("small" | "medium" | "large")[];
export declare const ISLAND_WINDOW: Readonly<{ width: number; height: number }>;
export declare const PILL_TOP: number;
export declare const DOCK: Readonly<{ cell: number; tile: number; column: number; open: number; pad: number; ear: number; sliver: number; margin: number; overhang: number }>;
export declare const DISPLAY_CHOICES: readonly ("active" | "built-in" | "main")[];
interface Rect { x: number; y: number; width: number; height: number }
interface DisplayLike { id?: number; bounds: Rect; workArea: Rect; internal?: boolean; label?: string }
interface Size { width: number; height: number }
export declare function notchOf(display: DisplayLike, platform: string, measured?: Size | null): { width: number; height: number; housing: Size } | null;
export declare function islandLayout(display: DisplayLike, options?: { platform?: string; size?: string; measured?: Size | null }): {
  window: Rect; collapsed: { kind: "notch" | "pill"; width: number; height: number; top: number; notch: number; notchHeight: number }; tile: number; size: "small" | "medium" | "large";
};
export declare function dockEdge(display: DisplayLike): number;
export declare function dockLayout(display: DisplayLike): { window: Rect; body: number; top: number };
export declare function pickDisplay<T extends DisplayLike>(displays: T[], choice: string, options?: { primary?: T | null; cursor?: { x: number; y: number } | null }): T | null;
