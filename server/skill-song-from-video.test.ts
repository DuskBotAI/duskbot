import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";

describe("song-from-video skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);
  const script = readFileSync(join(process.cwd(), "skills", "song-from-video", "find_song.py"), "utf8");
  const dockerfile = readFileSync(join(process.cwd(), "deploy", "docker", "Dockerfile"), "utf8");

  it("mounts when someone asks for the song in a clip, and stays out of other music talk", () => {
    for (const text of [
      "https://www.instagram.com/reel/Df8niqmhcAK/ can u find me this song",
      "what song is playing in this tiktok",
      "it goes like i can understand... very chill with beats, can u match beats",
      "shazam this for me",
      "ye gaana kaunsa hai",
      "what's the background music in this video",
    ]) {
      expect(ids(text), text).toContain("song-from-video");
    }
    for (const text of ["write a birthday song for my mom", "make a playlist for my run", "turn the music down on the speaker"]) {
      expect(ids(text), text).not.toContain("song-from-video");
    }
  });

  it("installs on demand exactly what the cloud image ships", () => {
    const shipped = /ARG BOT_MEDIA_PACKAGES="([^"]+)"/.exec(dockerfile)?.[1].split(/\s+/) ?? [];
    const onDemand = /^PACKAGES = \[(.+)\]$/m.exec(script)?.[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")) ?? [];
    expect(shipped.length).toBeGreaterThan(0);
    for (const pin of shipped) expect(onDemand).toContain(pin);
  });
});
