---
name: song-from-video
description: "Finding the song in a reel, TikTok, Short or video file: download it, match several windows, and remove the voice when someone talks over the music."
---

# The song in a video

Someone sends a reel, TikTok, Short or a video file and asks what song it is. Do it in one go with the script beside this
file; don't guess from the vibe, and don't match only one part of the clip.

```
python3 <this skill's folder>/find_song.py "<link or file>" --out <a folder in your workspace>
```

It downloads the clip, matches up to 12 ten-second windows across it with Shazam's free matcher, then the music with the
centred voice taken out, and, only when nothing matched, separates the music from the voice (Demucs) and matches that.
Run it as it is: the first run installs what it needs by itself (into `~/.cache/dusk-song-id`; set `XDG_CACHE_HOME` to
a writable folder if that one is not), and the voice remover is a one-time install of about 700 MB that takes 1 to 3
minutes; each separation then takes about two seconds per second of clip. A full run is 1 to 6 minutes, so tell the
person you're on it before you start. Never run two at once: the matcher refuses bursts.

It prints one JSON line:

- `found: true`: answer with `song.artist` and `song.title`, and the `shazam_url` or `apple_music_url`. Two or more
  `matched_windows` is certain. One is likely: say so in plain words, and mention it matched only part of the clip.
- `found: false`: say you couldn't match it, never invent a title. If the person describes the music ("chill with
  beats", "a girl singing in Spanish"), run again with `--separate always`, and with `--start`/`--end` (seconds) around
  the part where the music is loudest or the voice is quiet. If it still finds nothing, it is likely a track the
  creator made or an unreleased one: say that, and offer what the post itself names (`platform.platform_label`, or the
  audio label shown on the post page) as a lead, not as the answer.
- `ok: false` with `stage: "setup"`: follow its `hint`, then run it again.
- `ok: false` with `stage: "download"`: the site wants a browser. Open the link in your browser, then either save the
  video from the page (or its media request) into your workspace and pass the file, or export the browser's cookies for
  that site to a Netscape `cookies.txt` and run again with `--cookies cookies.txt`. Instagram and TikTok usually work
  without this; YouTube often asks for it from servers. If the person shares a file instead, pass the file.

The post's own audio label ("Artist • Song", or "Original audio") is a hint: it is often right, but "Original audio"
can still be a well-known song, and a label can name a different song than the one playing. Check it with the script;
a label that names the song the script found settles it.

Reply like a friend who knows music: the song and artist, one link, and nothing about windows, passes or tools.
