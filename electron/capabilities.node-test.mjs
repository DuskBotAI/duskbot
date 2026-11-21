import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { desktopCapabilities } = require("./capabilities.cjs");

test("a remote server's page is told this computer offers no screen, voice or local control", () => {
  const local = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true } });
  const remote = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true });
  assert.equal(local.remote, false);
  assert.equal(local.screenPreview.available, true);
  assert.equal(remote.remote, true);
  assert.deepEqual(remote.screenPreview, { available: false, interaction: "none", reasonCode: "remote-server" });
  assert.equal(remote.dictation.available, false);
  assert.equal(remote.dictation.reasonCode, "remote-server");
  assert.equal(remote.localComputer.available, false);
  assert.equal(remote.localComputer.enabled, false);
  assert.equal(remote.localComputer.reasonCode, "remote-server");
  assert.equal(remote.host.platform, "darwin");
  assert.equal(remote.host.homeDir, "");
  assert.notEqual(local.host.homeDir, "");
});

test("the home page (My Cloud or the person's own server) still listens through this computer, nothing else", () => {
  const home = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true, homeSpeech: true });
  assert.equal(home.remote, true);
  assert.deepEqual(home.dictation, { available: true, engine: "apple-speech", onDevice: true });
  assert.equal(home.screenPreview.available, false);
  assert.equal(home.localComputer.available, false);
  assert.equal(home.host.homeDir, "");
  const linux = desktopCapabilities({ platform: "freebsd", env: {}, remote: true, homeSpeech: true });
  assert.equal(linux.dictation.available, false);
});

test("another place the person chose listens through this computer's own recognizer, nothing else", () => {
  for (const platform of ["darwin", "win32"]) {
    const place = desktopCapabilities({ platform, env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true, placeSpeech: true });
    assert.equal(place.dictation.available, true, platform);
    assert.equal(place.dictation.onDevice, true, platform);
    assert.equal(place.screenPreview.available, false);
    assert.equal(place.localComputer.available, false);
    assert.equal(place.host.homeDir, "");
  }
  const linux = desktopCapabilities({ platform: "linux", env: { DISPLAY: ":0" }, remote: true, placeSpeech: true });
  assert.deepEqual(linux.dictation, { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" });
  const unknown = desktopCapabilities({ platform: "darwin", env: {}, remote: true });
  assert.equal(unknown.dictation.reasonCode, "remote-server");
});
