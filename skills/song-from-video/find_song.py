#!/usr/bin/env python3
"""Find the song playing in a video or audio clip: a link (Instagram, TikTok, YouTube, X...) or a file.

  python3 find_song.py <link-or-file> [--cookies cookies.txt] [--separate auto|always|never] [--out DIR]

Prints one JSON object on stdout. Progress goes to stderr.
"""
import argparse
import asyncio
import hashlib
import io
import json
import math
import os
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGES = ["shazamio-core==2.0.0", "yt-dlp[default]==2026.10.26", "imageio-ffmpeg==0.6.0"]
SEPARATOR_PACKAGES = ["torch==2.15.0", "torchaudio", "demucs==4.0.1", "soundfile==0.14.0", "numpy"]
WINDOW = 10
WINDOW_STEP = 5
MAX_WINDOWS = 12
SEPARATE_SECONDS = 90
# Shazam answers 429 to a burst from one address; one request every few seconds passes.
REQUEST_GAP = 6.0
SHAZAM_URL = (
    "https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/{a}/{b}"
    "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3"
)


def log(*parts):
    print("[find_song]", *parts, file=sys.stderr, flush=True)


def cache_root():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "dusk-song-id")


UV_VERSION = "0.13.4"
UV_SHA256 = {
    "aarch64-apple-darwin": "e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1",
    "x86_64-apple-darwin": "7be2dcd316122f4b3e5a0a7889f6248266c14425374e105ff7dc9779184603a6",
    "aarch64-unknown-linux-gnu": "1ae72b4718729e2ccc4f1ae2c6d1e531ca8467800e0546e9130b3886023a60ab",
    "x86_64-unknown-linux-gnu": "2b428396f12572d4429cf210ca234dd599a33b3af0958a4d5ed569d63e3f344f",
}


def find_uv():
    found = shutil.which("uv")
    if found:
        return found
    target = os.path.join(cache_root(), "bin", "uv")
    if os.path.exists(target):
        return target
    machine = {"arm64": "aarch64", "amd64": "x86_64"}.get(platform.machine().lower(), platform.machine().lower())
    system = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu"}.get(platform.system())
    triple = f"{machine}-{system}"
    if triple not in UV_SHA256:
        fail("setup", f"no uv build for {triple}", "Install uv (https://docs.astral.sh/uv/) and run this again.")
    log("fetching uv")
    url = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{triple}.tar.gz"
    try:
        # python.org's macOS Python ships without CA certificates until "Install Certificates" runs; curl uses the system's.
        if shutil.which("curl"):
            data = subprocess.run(["curl", "-fsSL", "--max-time", "120", url], check=True, capture_output=True).stdout
        else:
            with urllib.request.urlopen(url, timeout=60, context=ssl_context()) as response:
                data = response.read()
    except (subprocess.CalledProcessError, urllib.error.URLError, OSError) as error:
        fail("setup", f"could not download uv: {error}", "Install uv (https://docs.astral.sh/uv/) and run this again.")
    if hashlib.sha256(data).hexdigest() != UV_SHA256[triple]:
        fail("setup", "the uv download did not match its checksum", "Install uv (https://docs.astral.sh/uv/) and run this again.")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        member = archive.extractfile(f"uv-{triple}/uv")
        with open(target + ".part", "wb") as out:
            out.write(member.read())
    os.chmod(target + ".part", 0o755)
    os.replace(target + ".part", target)
    return target


def ensure_packages():
    try:
        import shazamio_core  # noqa: F401
        import yt_dlp  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("DUSK_SONG_ID_BOOTSTRAPPED"):
        fail("setup", "the song tools could not be installed", "Check the internet connection and run this again.")
    uv = find_uv()
    log("installing the song tools (first run only)")
    args = [uv, "run", "--quiet", "--no-project", "--python", "3.12"]
    for package in PACKAGES:
        args += ["--with", package]
    args += ["python", os.path.abspath(__file__), *sys.argv[1:]]
    env = dict(os.environ, DUSK_SONG_ID_BOOTSTRAPPED="1")
    sys.exit(subprocess.call(args, env=env))


def ffmpeg_exe():
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        fail("setup", "ffmpeg is missing", "Install ffmpeg, or run this script through uv so it brings its own.")


def fail(stage, reason, hint, **extra):
    print(json.dumps({"ok": False, "stage": stage, "reason": reason, "hint": hint, **extra}, ensure_ascii=False))
    sys.exit(3)


def download(url, workdir, cookies):
    import yt_dlp

    opts = {
        "format": "ba/b",
        "outtmpl": os.path.join(workdir, "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "max_filesize": 300 * 1024 * 1024,
        "socket_timeout": 30,
    }
    if shutil.which("node"):
        # yt-dlp needs a JavaScript runtime for YouTube and enables only deno by default.
        opts["js_runtimes"] = {"node": {}}
    if cookies:
        opts["cookiefile"] = cookies
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = ydl.prepare_filename(info)
    except Exception as error:  # yt-dlp raises many types; all mean the same thing here
        text = str(error)
        login = any(word in text.lower() for word in ("login", "log in", "sign in", "cookies", "private", "not a bot", "rate-limit"))
        fail(
            "download",
            text.replace("ERROR: ", "")[:300],
            "The site wants a signed-in browser: open the link in your browser, save its cookies to a Netscape cookies.txt, "
            "and run again with --cookies; or save the video file from the page and pass the file instead."
            if login else
            "Open the link in your browser, save the video file from the page, and pass the file instead.",
        )
    if not os.path.exists(path):
        candidates = [os.path.join(workdir, name) for name in os.listdir(workdir) if name.startswith("source.")]
        if not candidates:
            fail("download", "the download finished without a file", "Save the video from the page in your browser and pass the file.")
        path = candidates[0]
    label = {key: info.get(key) for key in ("track", "artist", "album") if info.get(key)} or instagram_label(url)
    meta = {"title": (info.get("title") or "")[:200], "uploader": info.get("uploader"), "duration": info.get("duration"), "platform_label": label or None}
    return path, meta


def ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def unescape(text):
    while "\\" in text:
        decoded = json.loads(f'"{text}"')
        if decoded == text:
            break
        text = decoded
    return text


def instagram_label(url):
    code = re.search(r"instagram\.com/(?:[\w.]+/)?(?:reels?|p)/([\w-]+)", url)
    if not code:
        return None
    request = urllib.request.Request(
        f"https://www.instagram.com/reel/{code.group(1)}/embed/captioned/",
        # A browser user agent gets the script-rendered page without the post's data; a plain client gets the data.
        headers={"User-Agent": "curl/8.7.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20, context=ssl_context()) as response:
            page = response.read().decode("utf-8", "replace").replace('\\"', '"')
    except (urllib.error.URLError, OSError):
        return None
    found = re.search(r'"clips_music_attribution_info":\{"artist_name":"([^"]*)","song_name":"([^"]*)","uses_original_audio":(true|false)', page)
    if not found:
        return None
    artist, song = (unescape(part) for part in found.groups()[:2])
    return {"artist": artist, "track": song, "original_audio": found.group(3) == "true"}


def run_ffmpeg(args):
    result = subprocess.run([ffmpeg_exe(), "-v", "error", "-y", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[-300:] or "ffmpeg failed")


def decode(source, workdir):
    out = os.path.join(workdir, "full.wav")
    try:
        run_ffmpeg(["-i", source, "-vn", "-ac", "2", "-ar", "44100", "-sample_fmt", "s16", out])
    except RuntimeError as error:
        fail("decode", f"the file has no audio ffmpeg can read: {error}", "Check the file is a video or audio file.")
    with wave.open(out) as handle:
        seconds = handle.getnframes() / handle.getframerate()
    if seconds < 3:
        fail("decode", "the clip is shorter than 3 seconds", "Ask for a longer clip.")
    return out, seconds


def window_starts(seconds, start, end):
    start = max(0.0, start)
    end = min(seconds, end) if end else seconds
    span = end - start
    if span <= WINDOW:
        return [start]
    count = min(MAX_WINDOWS, math.ceil((span - WINDOW) / WINDOW_STEP) + 1)
    step = (span - WINDOW) / (count - 1)
    return [round(start + i * step, 2) for i in range(count)]


class Shazam:
    def __init__(self):
        from shazamio_core import Recognizer

        self.recognizer = Recognizer(segment_duration_seconds=WINDOW)
        self.last = 0.0
        self.requests = 0

    def _post(self, signature):
        body = json.dumps({
            "timezone": signature.timezone,
            "signature": {"uri": signature.signature.uri, "samplems": signature.signature.samples},
            "timestamp": signature.timestamp,
            "context": {},
            "geolocation": {},
        }).encode()
        request = urllib.request.Request(
            SHAZAM_URL.format(a=str(uuid.uuid4()).upper(), b=str(uuid.uuid4()).upper()),
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Shazam-Platform": "IPHONE",
                "X-Shazam-AppVersion": "14.1.0",
                "Accept": "*/*",
                "Accept-Language": "en-US",
                "User-Agent": "Shazam/3685 CFNetwork/1197 Darwin/20.0.0",
            },
        )
        with urllib.request.urlopen(request, timeout=30, context=ssl_context()) as response:
            return json.loads(response.read())

    def recognize(self, wav_path):
        async def sign():
            return await self.recognizer.recognize_path(wav_path)

        signature = asyncio.run(sign())
        for attempt in range(5):
            wait = self.last + REQUEST_GAP - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.requests += 1
            try:
                return self._post(signature)
            except urllib.error.HTTPError as error:
                if error.code != 429:
                    raise
                log("song service busy, waiting")
                time.sleep(10 * (attempt + 1))
        raise RuntimeError("the song service kept answering 'too many requests'")


def describe(answer):
    track = answer.get("track") or {}
    if not track.get("title"):
        return None
    album = released = None
    for section in track.get("sections") or []:
        for item in section.get("metadata") or []:
            if item.get("title") == "Album":
                album = item.get("text")
            if item.get("title") == "Released":
                released = item.get("text")
    apple = None
    for option in (track.get("hub") or {}).get("options") or []:
        for action in option.get("actions") or []:
            if (action.get("uri") or "").startswith("https://music.apple.com"):
                apple = action["uri"].split("&mttn")[0]
    skew = None
    matches = answer.get("matches") or []
    if matches:
        skew = matches[0].get("timeskew")
    return {
        "title": track.get("title"),
        "artist": track.get("subtitle"),
        "album": album,
        "released": released,
        "isrc": track.get("isrc"),
        "shazam_url": track.get("url"),
        "apple_music_url": apple,
        "key": track.get("key"),
        "skew": skew,
    }


def scan(shazam, full, starts, filter_graph, label, workdir):
    hits = {}
    tried = []
    for start in starts:
        window = os.path.join(workdir, "window.wav")
        args = ["-ss", str(start), "-t", str(WINDOW), "-i", full]
        if filter_graph:
            args += ["-af", filter_graph]
        run_ffmpeg([*args, "-ac", "1", "-ar", "16000", window])
        try:
            found = describe(shazam.recognize(window))
        except RuntimeError as error:
            return hits, tried, str(error)
        except (urllib.error.URLError, OSError) as error:
            return hits, tried, f"could not reach the song service: {error}"
        tried.append({"at": start, "match": f"{found['artist']} - {found['title']}" if found else None})
        log(label, f"{start:.0f}s", tried[-1]["match"] or "no match")
        if found:
            entry = hits.setdefault(found["key"] or found["title"], {**found, "windows": []})
            entry["windows"].append(start)
            if len(entry["windows"]) >= 2:
                break
    return hits, tried, None


def best(hits):
    if not hits:
        return None
    return max(hits.values(), key=lambda entry: (len(entry["windows"]), -abs(entry.get("skew") or 0)))


def side_has_music(full, workdir):
    probe = os.path.join(workdir, "side-probe.wav")
    run_ffmpeg(["-i", full, "-af", "pan=mono|c0=0.5*c0-0.5*c1", "-t", "120", probe])
    mid = os.path.join(workdir, "mid-probe.wav")
    run_ffmpeg(["-i", full, "-ac", "1", "-t", "120", mid])
    return rms_db(probe) - rms_db(mid) > -30


def rms_db(path):
    import array

    with wave.open(path) as handle:
        frames = handle.readframes(handle.getnframes())
    samples = array.array("h", frames)
    if not samples:
        return -120.0
    total = 0
    for i in range(0, len(samples), 7):
        total += samples[i] * samples[i]
    mean = total / max(1, len(samples[::7]))
    return 10 * math.log10(mean / (32768.0 ** 2)) if mean > 0 else -120.0


def separator_python():
    venv = os.path.join(cache_root(), "separator")
    python = os.path.join(venv, "bin", "python")
    if os.path.exists(os.path.join(venv, ".ready")):
        return python
    uv = find_uv()
    log("installing the voice remover (first time only, about 700 MB, 1-3 minutes)")
    subprocess.run([uv, "venv", "--quiet", "--allow-existing", "--python", "3.12", venv], check=True)
    install = [uv, "pip", "install", "--quiet", "--python", python]
    if platform.system() == "Linux":
        # PyPI's Linux torch wheels carry CUDA (gigabytes); the CPU index has the small ones.
        install += ["--index-url", "https://download.pytorch.org/whl/cpu", "--extra-index-url", "https://pypi.org/simple", "--index-strategy", "unsafe-best-match"]
    subprocess.run([*install, *SEPARATOR_PACKAGES], check=True)
    open(os.path.join(venv, ".ready"), "w").close()
    return python


def separate(full, seconds, starts, workdir):
    python = separator_python()
    first = starts[0]
    length = min(SEPARATE_SECONDS, seconds - first)
    clip = os.path.join(workdir, "to-separate.wav")
    run_ffmpeg(["-ss", str(first), "-t", str(length), "-i", full, clip])
    music = os.path.join(workdir, "music-only.wav")
    env = dict(os.environ, TORCH_HOME=os.path.join(cache_root(), "torch"), FFMPEG=ffmpeg_exe())
    result = subprocess.run([python, os.path.join(HERE, "separate.py"), clip, music], env=env, capture_output=True, text=True)
    if result.returncode != 0:
        return None, (result.stderr.strip().splitlines() or ["the voice remover failed"])[-1][:300]
    return music, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--cookies")
    parser.add_argument("--separate", choices=["auto", "always", "never"], default="auto")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=0.0)
    parser.add_argument("--out")
    args = parser.parse_args()

    ensure_packages()
    began = time.monotonic()
    workdir = args.out or tempfile.mkdtemp(prefix="find-song-")
    os.makedirs(workdir, exist_ok=True)
    meta = None
    if os.path.exists(args.source):
        source = args.source
    elif args.source.startswith(("http://", "https://")):
        log("downloading")
        source, meta = download(args.source, workdir, args.cookies)
    else:
        fail("input", "not a link or an existing file", "Pass the video link or the path of the saved video.")
    full, seconds = decode(source, workdir)
    starts = window_starts(seconds, args.start, args.end)
    shazam = Shazam()
    passes = []

    def finish(match):
        song = None
        if match:
            song = {k: v for k, v in match.items() if k not in ("key", "skew", "windows") and v}
            song["matched_at_seconds"] = match["windows"]
        print(json.dumps({
            "ok": True,
            "found": bool(match),
            "song": song,
            "matched_windows": len(match["windows"]) if match else 0,
            "clip_seconds": round(seconds, 1),
            "passes": passes,
            "platform": meta,
            "seconds_taken": round(time.monotonic() - began, 1),
            "files": {"audio": full, **({"music_only": music_file} if music_file else {})},
        }, ensure_ascii=False))
        sys.exit(0)

    def run(label, path, window_list, filter_graph=None):
        hits, tried, error = scan(shazam, path, window_list, filter_graph, label, workdir)
        passes.append({"pass": label, "windows_tried": len(tried), "windows_matched": sum(1 for t in tried if t["match"]), **({"error": error} if error else {})})
        match = best(hits)
        if match:
            match["found_by"] = label
        return match

    music_file = None
    if args.separate != "always":
        match = run("as is", full, starts)
        if match:
            finish(match)
        if side_has_music(full, workdir):
            match = run("centre voice removed", full, starts, "pan=mono|c0=0.5*c0-0.5*c1")
            if match:
                finish(match)
    if args.separate == "never":
        finish(None)
    log("separating the music from the voice")
    music_file, error = separate(full, seconds, starts, workdir)
    if not music_file:
        passes.append({"pass": "voice removed", "error": error})
        finish(None)
    with wave.open(music_file) as handle:
        music_seconds = handle.getnframes() / handle.getframerate()
    finish(run("voice removed", music_file, window_starts(music_seconds, 0, 0)))

if __name__ == "__main__":
    main()
