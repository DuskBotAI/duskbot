import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../apps/mobile/${path}`, import.meta.url), "utf8");

describe("the phone app's orientation", () => {
  it("is portrait only on the iPhone, as on Android", () => {
    const plist = read("ios/App/App/Info.plist");
    const orientations = /<key>UISupportedInterfaceOrientations<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
    expect([...orientations.matchAll(/<string>(\w+)<\/string>/g)].map((match) => match[1])).toEqual(["UIInterfaceOrientationPortrait"]);
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain('android:screenOrientation="portrait"');
  });
});
