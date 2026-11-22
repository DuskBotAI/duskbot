# Connected Apps OAuth recovery

Run from the repository root:

```sh
node --experimental-strip-types scripts/verify-connected-apps.ts
pnpm exec vitest run server/composio.test.ts server/composio-availability.test.ts src/lib/connector-oauth.test.ts src/components/connect-apps/connector-helpers.test.ts
pnpm exec vitest run server/index.test.ts -t 'second-account cards|retries abandoned connector OAuth'
pnpm broker:test
pnpm broker:check
```

The renderer recipe launches a disposable fake-engine workspace and mounts the
actual Apps modal and connector card. Synthetic authorization responses are
delayed; a disposable HTTPS loopback server supplies the authorization page,
never a provider. Its temporary certificate and hostname mapping apply only
to the fixture's Chromium profile (requires local `openssl`). It checks
synchronous tab reservation with the opener removed,
the blocked-popup notice with **Open page again** reusing the issued link (in
the Apps window) or the card's safe link, a fresh request once that link is
stale or the window was reopened,
failed-request cleanup/retry, cancellation after modal/card removal or card
replacement, Reconnect for an app whose only account expired, read on a later
visit (the old account is removed and the link reuses its label), and the connector card asking for a
label instead of repeating a refused request. Screenshots and `result.json` are written to
`.dusk-scratch/connected-apps-evidence` (override with `DUSK_UI_EVIDENCE_DIR`).

The real HTTP route cases start their own isolated server and loopback Composio
stub. They check abandoned-account retries from Settings and connector cards,
distinct aliases, active-account protection, wrong-thread refusal, and existing
second-account identity handling. Direct-server and broker unit checks also
refuse a label an active or unknown-state account holds, replace one held only
by an account that is not active, link a toolkit whose only account failed, and
keep the account cap. Broker tests mock upstream fetch; they are not a
deployment acceptance test.

No live OAuth, provider keys, user data, Safari/Brave compatibility, or hosted
broker deployment is claimed. The normal Electron external-browser path is
covered by the focused helper test.
