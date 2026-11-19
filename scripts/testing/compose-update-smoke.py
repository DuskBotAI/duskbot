"""Run inside a disposable Linux Docker host with the built dist-server directory and upstream sources."""
import contextlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


def run(*args, data=None):
    return subprocess.check_output(args, input=data, text=True).strip()


def main():
    project = "dusk-update-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as cleanup:
        os.chdir(temp)
        os.environ["COMPOSE_PROJECT_NAME"] = project
        os.environ["DOCKER_BUILDKIT"] = "0"
        registry = run("docker", "run", "-d", "-p", "127.0.0.1::5000", "registry:2")
        cleanup.callback(run, "docker", "rm", "-fv", registry)
        repo = run("docker", "port", registry, "5000/tcp") + "/duskbot"
        base = project + "-server"
        Path("Dockerfile").write_text("""FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist-server ./dist-server
COPY fake-engine /app/fake-engine
RUN mkdir -p /data/state && chown -R node:node /data
COPY --chown=node:node config.json /data/state/
ENV DUSK_DATA_DIR=/data/state FAKE_CLAUDE_MODE=slow FAKE_CLAUDE_SLOW_FINISH_GATE=/data/finish
USER node
ENV HOME=/data
CMD ["node", "dist-server/server-launcher.js"]
""")
        shutil.copytree(ROOT / "dist-server", "dist-server")
        Path("fake-engine").mkdir()
        for file in ("fake-claude-cli.ts", "launch-note.ts", "cleanup.ts", "room-handoff-agent.ts"):
            shutil.copy2(ROOT / "server/testing" / file, Path("fake-engine") / file)
        Path("config.json").write_text(json.dumps({"features": {"smartSetupChoices": False}, "instances": {
            "claude": {"driver": "claudeAgent", "displayName": "Fixture", "config": {"cli": "/app/fake-engine/fake-claude-cli.ts"}}}}))
        run("docker", "build", "-q", "-t", base, ".")
        cleanup.callback(run, "docker", "image", "rm", base)
        Path("release.mjs").write_text("""
import {readFileSync} from "node:fs";
const release = JSON.parse(readFileSync("/app/dist-server/package.json")).version === "1.0.0" ? "1.0.1" : "1.0.2";
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 300_000 ? 2_000 : ms, ...args);
const original = globalThis.fetch;
globalThis.fetch = (url, ...args) => String(url) === "https://api.github.com/repos/DuskBotAI/duskbot/releases/latest"
  ? Promise.resolve(Response.json({tag_name:"v"+release,draft:false,prerelease:false})) : original(url, ...args);
""")
        Path("Dockerfile").write_text(f"""FROM {base}
COPY release.mjs /app/
ARG VERSION
USER root
RUN node -e "let fs=require('fs'),p='./dist-server/package.json',v=require(p);v.version=process.argv[1];fs.writeFileSync(p,JSON.stringify(v))" "$VERSION"
USER node
ENV NODE_OPTIONS=--import=/app/release.mjs
""")
        latest = repo + ":latest"
        for v in ("1.0.0", "1.0.1", "1.0.2"):
            tag = repo + ":v" + v
            run("docker", "build", "-q", "--build-arg", "VERSION=" + v, "-t", tag, ".")
            run("docker", "push", tag)
            cleanup.callback(run, "docker", "image", "rm", tag)
        run("docker", "tag", repo + ":v1.0.0", latest)
        run("docker", "push", latest)
        cleanup.callback(run, "docker", "image", "rm", latest)
        shutil.copyfile(ROOT / "deploy/Caddyfile", "Caddyfile")
        shutil.copyfile(ROOT / "deploy/docker-compose.yml", "docker-compose.yml")
        def configure(image):
            Path(".env").write_text(f"DOMAIN=:8080\nDUSK_IMAGE={image}\n")
        configure(latest)
        Path("docker-compose.override.yml").write_text((ROOT / "deploy/compose-updater/override.yml").read_text() + """
    ports: !override ["127.0.0.1::8080"]
    environment:
      DUSK_COMPOSE_IMAGE: ghcr.io/duskbotai/duskbot:latest
      OPERATOR_SETTING: fixture
    healthcheck:
      interval: 1s
      timeout: 3s
      retries: 45
""")
        Path(".dusk-updater/socket").mkdir(parents=True)
        module = importlib.util.spec_from_file_location("updater", ROOT / "deploy/compose-updater/updater.py")
        updater = importlib.util.module_from_spec(module)
        module.loader.exec_module(updater)
        updater.OFFICIAL = repo
        socket = Path(".dusk-updater/socket/control.sock")
        host = multiprocessing.get_context("fork").Process(target=updater.serve)
        host.start()
        cleanup.callback(host.join, 5)
        cleanup.callback(host.terminate)
        def host_status():
            return json.loads(run("curl", "-fsS", "--unix-socket", str(socket), "http://localhost/status"))
        cleanup.callback(run, "docker", "compose", "down", "-v")
        run("docker", "compose", "up", "-d", "--wait", "--no-build")
        first = updater.deployment()
        run("docker", "exec", first, "touch", "/data/keep-me")
        def volumes():
            return [{mount["Destination"]: mount["Name"] for mount in json.loads(run("docker", "inspect", "--format", "{{json .Mounts}}",
                    updater.container_id(service))) if mount["Type"] == "volume"} for service in ("dusk", "caddy")]
        original_volumes = volumes()
        def request(path, body=None, token=None):
            base_url = "http://" + run("docker", "compose", "port", "dusk", "8080")
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            with urlopen(Request(base_url + path, data=None if body is None else json.dumps(body).encode(), headers=headers), timeout=25) as response:
                return json.load(response)
        def pair(scopes):
            code = updater.api(first, "/api/auth/pairing", {"scopes": scopes})["code"]
            return request("/api/auth/pair", {"code": code})["token"]
        owner, guest = pair(["admin", "client"]), pair(["client"])
        def denied(token, path, body):
            try:
                request(path, body, token)
            except HTTPError as error:
                assert error.code in (401, 403), error.code
            else:
                raise AssertionError("An unauthorized caller was accepted")
        for token in (None, guest):
            denied(token, "/api/updates/apply", {})
            denied(token, "/api/updates/automatic", {"enabled": True})
        check = lambda: request("/api/updates/check", token=owner)
        assert "compose" not in request("/api/updates/check", token=guest)
        assert "compose" not in updater.api(first, "/api/updates/check")
        assert run("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", str(socket),
                   "--data-binary", "0" * 64, "http://localhost/request") == "409"
        result = check()
        assert result["current"] == "1.0.0" and result["latest"] == "1.0.1" and result["available"], result
        assert result["compose"]["supported"] and not result["compose"]["automatic"], result
        for enabled in (True, False):
            assert request("/api/updates/automatic", {"enabled": enabled}, owner)["automatic"] == enabled
        def wait_phase(phase):
            deadline = time.monotonic() + 145
            while time.monotonic() < deadline:
                if host_status()["phase"] == phase:
                    return
                time.sleep(0.3)
            raise AssertionError(host_status())
        request("/api/updates/apply", {}, owner)
        wait_phase("failed")
        assert updater.container_id("dusk") == first and "release tag" in check()["compose"]["message"]
        configure(repo + ":v1.0.0")
        try:
            request("/api/updates/apply", {}, owner)
        except HTTPError as error:
            assert error.code == 409 and "pinned" in str(json.load(error)), error
        else:
            raise AssertionError("Accepted an operator pin")
        configure(latest)
        run("docker", "tag", repo + ":v1.0.1", latest)
        run("docker", "push", latest)
        request("/api/updates/apply", {}, owner)
        wait_phase("updated")
        final = check()
        assert final["current"] == "1.0.1" and final["latest"] == "1.0.2" and final["compose"]["phase"] == "updated", final
        new = updater.deployment()
        assert new != first and volumes() == original_volumes
        run("docker", "exec", new, "test", "-f", "/data/keep-me")
        assert run("docker", "exec", new, "printenv", "OPERATOR_SETTING") == "fixture"
        bot = request("/api/bots", {"name": "Idle test", "modelSelection": {"instanceId": "claude", "model": "claude-sonnet-5"}}, owner)["bot"]
        request(f"/api/bots/{bot['id']}/messages", {"text": "finish this fixture turn"}, owner)
        assert "turn" in updater.api(new, "/api/updates/busy")["busy"]
        run("docker", "tag", repo + ":v1.0.2", latest)
        run("docker", "push", latest)
        assert request("/api/updates/automatic", {"enabled": True}, owner)["automatic"]
        time.sleep(5)
        assert updater.container_id("dusk") == new and "turn" in updater.api(new, "/api/updates/busy")["busy"]
        try:
            request("/api/updates/apply", {}, owner)
        except HTTPError as error:
            assert error.code == 409 and "busy" in str(json.load(error))
        else:
            raise AssertionError("The updater accepted a running turn.")
        run("docker", "exec", new, "touch", "/data/finish")
        deadline = time.monotonic() + 145
        while "Verified server 1.0.2" not in host_status()["message"]:
            if time.monotonic() >= deadline:
                raise AssertionError(host_status())
            time.sleep(0.5)
        final = check()
        assert final["current"] == "1.0.2" and not final["available"] and final["compose"]["automatic"], final
        assert volumes() == original_volumes
        log = request(f"/api/threads/{bot['threadId']}/messages", token=owner)
        assert any(message.get("turnSucceeded") and message.get("kind") == "text"
                   and message.get("text", "").endswith("finish this fixture turn") for message in log["messages"])
        configure(repo + ":v1.0.2")
        run("docker", "compose", "pull", "dusk")
        run("docker", "compose", "up", "-d", "--wait")
        manual = updater.container_id("dusk")
        assert updater.inspect(manual, "{{.Config.Image}}") == repo + ":v1.0.2" and volumes() == original_volumes
        assert request("/.well-known/duskbot/environment")["version"] == "1.0.2"
        print("PASS: owner and guest access, pins, mismatched tag, manual replacement, automatic update after a completed turn, Caddy, volumes, session and settings.")


if __name__ == "__main__":
    main()
