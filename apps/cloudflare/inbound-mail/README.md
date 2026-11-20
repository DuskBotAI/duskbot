# dusk bot mail edge (Cloudflare Email Routing + a Worker)

Gives each bot its own inbound address, `<handle>@in.dusk.bot`, with `+alias` routes to its automations
(`server/bot-mail.ts`). The edge only carries mail; the home decides who may send and what runs.

```
 sender MTA ──► Cloudflare Email Routing (MX of in.dusk.bot, catch-all → this worker)
                  email(): <handle>[+alias]@in.dusk.bot → KV MAILBOXES[handle] = { url, secret, keyHash }
                  POST url  (Bearer secret)  { from, to, raw: base64 of the first 200 KiB }
                                                     │
 home (desktop via its Remote access route, dusk cloud, self-hosted) ◄┘  /hooks/mail/<mb_id>
   checks the route's sender list and the receiving side's DMARC/SPF/DKIM verdict, then runs the routed automation
   with the mail as outside event data (dedupe by Message-ID, the automation's rate limit and queue cap apply)
```

- **Register.** `PUT /v1/mailboxes/<handle> {url, secret, key}`. `url` must be `https://<host>/hooks/mail/mb_…`. Before
  keeping it the edge posts `x-dusk-mail-check: <nonce>` with the bearer secret and needs `HMAC-SHA256(secret, nonce)`
  back, so only a dusk bot door holding that secret can become a destination. The first `key` takes the handle; a
  different key gets 409 (the home then picks a new handle). The home registers a fresh secret whenever its address
  moves (a desktop's Remote access route coming or going, a move to dusk cloud) and retries every 10 minutes.
- **Delete.** `DELETE /v1/mailboxes/<handle>` with `Authorization: Bearer <key>` (a bot's deletion does this).
- **Deliver.** Unknown handle: bounce "No such mailbox". Home unreachable, 5xx or 429: bounce "try again later". A
  sender the home dropped (not on the list, failed authentication, no route): accepted silently, so the address never
  answers spam. A sleeping dusk cloud wakes on the request (its proxy holds it while the home starts).
- **Limits.** 200 KiB of each message (attachments past that are cut; the home reads the text part), 30 register or
  delete calls a minute per client address, and each automation's own webhook limits (10 a minute, 3 unfinished runs).

## Owner setup (once)

1. Cloudflare dashboard → dusk.bot → Email → Email Routing → Settings → **Subdomains**: add `in.dusk.bot` (and
   `in-preview.dusk.bot` for preview). Cloudflare adds the MX and SPF records for the subdomain. The existing
   @dusk.bot catch-all to the owner's mailbox is not touched.
2. Create the KV namespaces and put their ids in `wrangler.jsonc`:
   ```
   cd apps/cloudflare/inbound-mail
   set -a && . ~/.config/duskbot/dusk.env && set +a
   npx wrangler kv namespace create dusk-mailboxes-preview
   npx wrangler kv namespace create dusk-mailboxes
   ```
3. Deploy: `npx wrangler deploy --env=""` (preview) and `npx wrangler deploy --env production`.
4. Email Routing → Routing rules for `in.dusk.bot` (and preview): **Catch-all** → action **Send to a Worker** →
   `dusk-inbound-mail` (`dusk-inbound-mail-preview`).
5. Preview homes: set `DUSK_MAIL_EDGE_URL=https://in-preview.dusk.bot` and `DUSK_MAIL_DOMAIN=in-preview.dusk.bot` in the
   preview cloud image's env. Production needs nothing (those are the defaults).
6. Test with the test-mail sink's domain as the sender, never through Brevo: add it to a route's senders, send one
   message to the bot's address, and check the routine's runs.

## Test

```
pnpm mail-edge:test
```
