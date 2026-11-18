import { describe, expect, it } from "vitest";

import { LocalVisionRunner } from "./local-vision-runner.ts";

describe("CUA Local Vision Runner & Coordinate Grounding", () => {
  it("normalizes 0-1000 coordinates to viewport pixel resolution", () => {
    const runner = new LocalVisionRunner({
      endpoint: "http://localhost:11434/v1",
      modelId: "ui-tars-7b",
      coordinateMode: "normalized-1000",
      viewport: { width: 1920, height: 1080 },
    });

    const origin = runner.normalizeCoordinates(0, 0);
    expect(origin).toEqual({ pixelX: 0, pixelY: 0 });

    const center = runner.normalizeCoordinates(500, 500);
    expect(center).toEqual({ pixelX: 960, pixelY: 540 });

    const max = runner.normalizeCoordinates(1000, 1000);
    expect(max).toEqual({ pixelX: 1920, pixelY: 1080 });
  });

  it("parses UI-TARS action syntax into concrete CUA actions", () => {
    const runner = new LocalVisionRunner({
      endpoint: "http://localhost:11434/v1",
      modelId: "ui-tars-7b",
      coordinateMode: "normalized-1000",
      viewport: { width: 1280, height: 800 },
    });

    const modelResponse = `
    Thought: I need to click the search bar, enter "receipt", and press Enter.
    Action: click(point=[250, 500])
    Action: type(content="receipt")
    Action: press_key(key="Enter")
    Action: scroll(direction="down")
    `;

    const actions = runner.parseModelOutput(modelResponse);
    expect(actions).toHaveLength(4);

    expect(actions[0]).toEqual({
      type: "click",
      x: 320, // 250/1000 * 1280
      y: 400, // 500/1000 * 800
    });

    expect(actions[1]).toEqual({
      type: "type",
      text: "receipt",
    });

    expect(actions[2]).toEqual({
      type: "press_key",
      key: "Enter",
    });

    expect(actions[3]).toEqual({
      type: "scroll",
      scrollDelta: 300,
    });
  });

  it("constructs proper grounding prompt with resolution and scale", () => {
    const runner = new LocalVisionRunner({
      endpoint: "http://localhost:11434/v1",
      modelId: "ui-tars-7b",
      coordinateMode: "normalized-1000",
      viewport: { width: 1920, height: 1080 },
    });

    const prompt = runner.buildGroundingPrompt("Open Google Sheets and create a blank sheet");
    expect(prompt).toContain("1920x1080");
    expect(prompt).toContain("normalized 0 to 1000 scale");
    expect(prompt).toContain("click(point=[x, y])");
    expect(prompt).toContain("Open Google Sheets");
  });
});
