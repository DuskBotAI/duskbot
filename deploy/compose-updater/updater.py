#!/usr/bin/env python3
"""Host service for one operator-selected Compose project. Requires Docker Compose v2 and Python 3.9+."""
import contextlib
import fcntl
import json
import os
import re
import socketserver
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

OFFICIAL = "ghcr.io/duskbotai/duskbot"
STATE = Path(".dusk-updater").absolute()


def docker(*args, stdin=None, timeout=25):
    result = subprocess.run(["docker", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Compose diagnostics may contain interpolated settings. Only the host journal gets them.
        print(result.stderr.strip(), file=sys.stderr, flush=True)
        raise RuntimeError("Docker failed. Check the host updater log and run docker compose ps.")
    return result.stdout.strip()


def compose(*args, **kwargs):
    return docker("compose", *args, **kwargs)


def container_id(service):
    cid = compose("ps", "-q", service)
    if not re.fullmatch(r"[0-9a-f]{12,64}", cid):
        raise RuntimeError(f"Start one healthy {service} service in the updater's Compose project.")
    return cid


def inspect(ref, fmt):
    return docker("inspect", "--format", fmt, ref)


def deployment():
    image = compose("config", "--images", "dusk")
    if image not in (OFFICIAL, OFFICIAL + ":latest"):
        raise RuntimeError("The Compose image is pinned or customized. Update it manually on the host.")
    dusk, caddy = container_id("dusk"), container_id("caddy")
    records = json.loads(docker("inspect", dusk, caddy))
    config = json.loads(compose("config", "--format", "json"))
    for name, service in config["services"].items():
        if name not in ("dusk", "caddy") and any(service.get(key) in ("service:dusk", "service:caddy") for key in ("network_mode", "pid", "ipc")):
            raise RuntimeError("Another service shares the server namespace. Update the project manually.")
    if config["services"]["dusk"].get("environment", {}).get("DUSK_PORT", "8799") != "8799":
        raise RuntimeError("The updater requires the official internal server port 8799.")
    if config["services"]["caddy"].get("network_mode") != "service:dusk":
        raise RuntimeError("Caddy must share the dusk service's network namespace.")
    # Compose v2 hashes a shared network namespace after resolving service:dusk to the live container ID.
    config["services"]["caddy"]["network_mode"] = "container:" + dusk
    resolved = compose("-f", "-", "config", "--hash=*", stdin=json.dumps(config))
    hashes = dict(line.split() for line in resolved.splitlines())
    for svc, record in zip(("dusk", "caddy"), records):
        if record["Config"]["Labels"]["com.docker.compose.config-hash"] != hashes.get(svc):
            raise RuntimeError("Compose settings differ from the running stack. Apply them manually before updating.")
    if records[0]["Config"]["Image"] != image or records[1]["HostConfig"]["NetworkMode"] != "container:" + dusk:
        raise RuntimeError("Use the official dusk and Caddy Compose layout or update manually.")
    if records[1]["Image"] != inspect(config["services"]["caddy"]["image"], "{{.Id}}"):
        raise RuntimeError("The Caddy image has changed on the host. Reconcile it with a manual Compose upgrade first.")
    digests = json.loads(inspect(records[0]["Image"], "{{json .RepoDigests}}")) or []
    if not any(d.startswith(OFFICIAL + "@sha256:") for d in digests):
        raise RuntimeError("The running image is a local build. Use the manual Compose upgrade.")
    return dusk


def api(cid, path, body=None):
    args = ["exec", "-i", cid, "curl", "--noproxy", "*", "-fsS", "--max-time", "8"]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    return json.loads(docker(*args, "http://127.0.0.1:8799" + path, stdin=json.dumps(body) if body else None))


def redeem(cid, step, token):
    return api(cid, "/api/updates/compose/host", {"step": step, "token": token})


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value):
        raise ValueError("The server did not provide a stable release version.")
    return tuple(map(int, value.split(".")))


class Updater:
    def __init__(self):
        self.db = STATE / "host.sqlite"
        with self.connection() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS updater (id INTEGER PRIMARY KEY, automatic INTEGER, phase TEXT, message TEXT)")
            conn.execute("INSERT OR IGNORE INTO updater VALUES (1, 0, 'idle', '')")
            conn.execute("UPDATE updater SET phase='failed', message='Updater restarted during an upgrade. Check docker compose ps and the running version.' WHERE phase='updating'")
        self.checked = 0
        self.problem = None

    @contextlib.contextmanager
    def connection(self):
        with contextlib.closing(sqlite3.connect(self.db)) as conn, conn:
            yield conn

    def report(self, phase, message):
        with self.connection() as conn:
            conn.execute("UPDATE updater SET phase=?, message=? WHERE id=1", (phase, message))
        print(message, flush=True)

    def status(self):
        with self.connection() as conn:
            auto, phase, message = conn.execute("SELECT automatic, phase, message FROM updater WHERE id=1").fetchone()
        if phase != "updating" and time.monotonic() >= self.checked:
            try:
                deployment()
                self.problem = None
            except (ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                self.problem = str(error) if isinstance(error, RuntimeError) else "Check the Docker Compose project on the host."
            self.checked = time.monotonic() + 30
        return {"automatic": bool(auto), "supported": self.problem is None, "phase": phase,
                "message": " ".join(filter(None, (message, self.problem)))}

    def accept(self, token):
        state = self.status()
        if state["phase"] == "updating":
            raise ValueError("An update is already running.")
        cid = deployment()
        offer = redeem(cid, "claim", token)
        action = offer["action"]
        if action in ("enable", "disable"):
            with self.connection() as conn:
                conn.execute("UPDATE updater SET automatic=? WHERE id=1", (action == "enable",))
        else:
            if action not in ("apply", "auto") or (action == "auto" and not state["automatic"]):
                raise ValueError("Automatic updates are off.")
            if version(offer["latest"]) <= version(offer["current"]):
                raise ValueError("The requested release is not newer.")
            self.report("updating", f"Pulling server {offer['latest']}.")
            threading.Thread(target=self.install, args=(cid, offer), daemon=False).start()
        return self.status()

    def install(self, cid, offer):
        target, permit = offer["latest"], offer["permit"]
        stage = "pull the release image"
        replaced = False
        try:
            tag = OFFICIAL + ":v" + target
            docker("pull", tag, timeout=600)
            docker("pull", OFFICIAL + ":latest", timeout=600)
            expected = inspect(tag, "{{.Id}}")
            if inspect(OFFICIAL + ":latest", "{{.Id}}") != expected:
                raise RuntimeError("The latest image does not match the release tag. Retry after image publication.")
            if deployment() != cid:
                raise RuntimeError("The Compose deployment changed during the pull. Check its current version.")
            stage = "reserve the idle server"
            lease = redeem(cid, "reserve", permit)
            if lease.get("busy"):
                self.report("waiting", "Work began during the pull. Try again when idle.")
                return
            if lease.get("ready") is not True:
                raise RuntimeError("The server could not reserve an idle window.")
            stage = "replace dusk and reconnect Caddy"
            compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "90",
                    "dusk", "caddy", timeout=120)
            replaced = True
            stage = "verify the running server"
            new = deployment()
            if (new == cid or inspect(new, "{{.Image}}") != expected
                    or api(new, "/.well-known/duskbot/environment").get("version") != target
                    or api(new, "/api/health").get("app") != "duskbot"):
                raise RuntimeError("The replacement failed its image, version or health check.")
            self.report("updated", f"Verified server {target} and its Caddy container.")
        except (ValueError, KeyError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            detail = str(error) if isinstance(error, RuntimeError) else "Check the host updater log."
            self.report("failed", f"Could not {stage}. {detail} Inspect docker compose ps before retrying.")
        finally:
            if not replaced:
                with contextlib.suppress(RuntimeError, ValueError, subprocess.TimeoutExpired):
                    redeem(cid, "release", permit)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(4)

    def respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/status":
            self.respond(200, self.server.updater.status())
        else:
            self.respond(404, {})

    def do_POST(self):
        if self.path != "/request" or self.headers.get("Content-Length") != "64":
            return self.respond(400, {"error": "Invalid updater request."})
        token = self.rfile.read(64)
        if not re.fullmatch(b"[0-9a-f]{64}", token):
            return self.respond(400, {"error": "Invalid request token."})
        try:
            state = self.server.updater.accept(token.decode())
        except (ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired) as error:
            return self.respond(409, {"error": str(error) if isinstance(error, (ValueError, RuntimeError)) else "Check the host updater service."})
        self.respond(200, state)


def serve():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    directory = STATE / "socket"
    directory.mkdir(exist_ok=True)
    directory.chmod(0o755)
    with (STATE / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "control.sock"
        path.unlink(missing_ok=True)
        with socketserver.UnixStreamServer(str(path), Handler) as server:
            server.updater = Updater()
            # Container UIDs vary. Every mutation redeems a one-use intent minted by the server's owner route.
            path.chmod(0o666)
            server.serve_forever()


if __name__ == "__main__":
    serve()
