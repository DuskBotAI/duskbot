export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface CuaAction {
  type: "click" | "double_click" | "type" | "press_key" | "scroll" | "wait";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  scrollDelta?: number;
}

export interface LocalVisionConfig {
  endpoint: string; // e.g. "http://localhost:11434/v1"
  modelId: string; // e.g. "ui-tars-7b", "qwen2.5-vl-7b"
  coordinateMode: "normalized-1000" | "pixels";
  viewport: ViewportDimensions;
  temperature?: number;
}

export class LocalVisionRunner {
  readonly config: LocalVisionConfig;

  constructor(config: LocalVisionConfig) {
    this.config = config;
  }

  normalizeCoordinates(rawX: number, rawY: number): { pixelX: number; pixelY: number } {
    if (this.config.coordinateMode === "pixels") {
      return {
        pixelX: Math.round(Math.max(0, Math.min(this.config.viewport.width, rawX))),
        pixelY: Math.round(Math.max(0, Math.min(this.config.viewport.height, rawY))),
      };
    }

    // 0 - 1000 normalized coordinate system (standard in UI-TARS, ShowUI, and OpenBot CUA)
    const pixelX = Math.round((Math.max(0, Math.min(1000, rawX)) / 1000) * this.config.viewport.width);
    const pixelY = Math.round((Math.max(0, Math.min(1000, rawY)) / 1000) * this.config.viewport.height);

    return { pixelX, pixelY };
  }

  parseModelOutput(output: string): CuaAction[] {
    const actions: CuaAction[] = [];
    const lines = output.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // UI-TARS / ShowUI Action: click(point=[x, y]) or click(x, y)
      const clickMatch = line.match(/\bclick\s*\(\s*(?:point\s*=\s*)?\[?(\d+)\s*,\s*(\d+)\]?\s*\)/i);
      if (clickMatch) {
        const rawX = parseInt(clickMatch[1], 10);
        const rawY = parseInt(clickMatch[2], 10);
        const { pixelX, pixelY } = this.normalizeCoordinates(rawX, rawY);
        actions.push({ type: "click", x: pixelX, y: pixelY });
        continue;
      }

      // Action: double_click(point=[x, y])
      const doubleClickMatch = line.match(/\bdouble_click\s*\(\s*(?:point\s*=\s*)?\[?(\d+)\s*,\s*(\d+)\]?\s*\)/i);
      if (doubleClickMatch) {
        const rawX = parseInt(doubleClickMatch[1], 10);
        const rawY = parseInt(doubleClickMatch[2], 10);
        const { pixelX, pixelY } = this.normalizeCoordinates(rawX, rawY);
        actions.push({ type: "double_click", x: pixelX, y: pixelY });
        continue;
      }

      // Action: type(content="...") or type(text="...")
      const typeMatch = line.match(/\btype\s*\(\s*(?:content|text)\s*=\s*["']([^"']+)["']\s*\)/i);
      if (typeMatch) {
        actions.push({ type: "type", text: typeMatch[1] });
        continue;
      }

      // Action: press_key(key="Enter")
      const keyMatch = line.match(/\bpress_key\s*\(\s*(?:key\s*=\s*)?["']([^"']+)["']\s*\)/i);
      if (keyMatch) {
        actions.push({ type: "press_key", key: keyMatch[1] });
        continue;
      }

      // Action: scroll(direction="down")
      const scrollMatch = line.match(/\bscroll\s*\(\s*(?:direction\s*=\s*)?["'](down|up)["']\s*\)/i);
      if (scrollMatch) {
        actions.push({ type: "scroll", scrollDelta: scrollMatch[1].toLowerCase() === "down" ? 300 : -300 });
        continue;
      }
    }

    return actions;
  }

  buildGroundingPrompt(userGoal: string): string {
    return [
      `You are an autonomous computer-use agent. Current screen resolution: ${this.config.viewport.width}x${this.config.viewport.height}.`,
      `Coordinates must be specified on a normalized 0 to 1000 scale: [0, 0] is top-left, [1000, 1000] is bottom-right.`,
      `Supported action syntax:`,
      `- click(point=[x, y])`,
      `- double_click(point=[x, y])`,
      `- type(content="text")`,
      `- press_key(key="Enter|Escape|Backspace|Tab")`,
      `- scroll(direction="down|up")`,
      `User Goal: ${userGoal}`,
      `Analyze the screen image and output the next concrete Action:`,
    ].join("\n");
  }
}
