# Kin

A tiny, private family messenger built from `c0di-org/Tauri-vibe-template`: React + Vite first, Tauri 2 ready, and deployable as a serious PWA on Cloudflare Workers.

## What works

- Family group chat plus one-to-one chats between any two members.
- Pairing by short code or QR link; no accounts or passwords.
- Client-side encrypted text and encrypted file attachments.
- Signed message envelopes so the relay cannot silently impersonate a family member.
- Cloudflare Durable Objects for realtime rooms, WebSocket hibernation, short-lived message relay, and pairing sessions.
- R2 for encrypted attachments with a seven-day lifecycle rule.
- PWA manifest, app icons, offline app shell, install flow, badges, and Web Push plumbing.
- Same frontend can still be packaged by Tauri for Android, iOS, macOS, Windows, and Linux later.

## Architecture

The Worker knows routing metadata: room IDs/titles, member display names/avatar seeds, public device keys, encrypted envelope sizes/timestamps, and push endpoints. It never receives conversation keys, message text, filenames, MIME types, or file encryption keys in plaintext. Files are AES-GCM encrypted in the browser before R2 upload. Group conversation keys are wrapped to a new member using ECDH during pairing. Direct chats derive a pairwise key from the two members' device keys.

Relay retention is deliberately temporary: message ciphertext expires after 7 days in each Durable Object; encrypted R2 objects should use the matching 7-day bucket lifecycle. Local devices keep their own history.

See `SECURITY.md` for the important v1 limitation: this is end-to-end encrypted, but not yet a Signal/MLS ratcheting protocol with forward secrecy.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev:relay
# another terminal
npm run dev
```

The Vite app runs on `http://localhost:1420` and proxies API/WebSocket traffic to Wrangler on `http://127.0.0.1:8787`.

## Cloudflare setup

Create the private attachment bucket once:

```bash
npx wrangler login
npx wrangler r2 bucket create kin-attachments
npx wrangler r2 bucket lifecycle add kin-attachments kin-expire --expire-days 7
```

Generate Web Push VAPID keys:

```bash
npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

Then deploy the PWA + relay together:

```bash
npm run deploy
```

Production deploys are **Wrangler-only** (`npm run deploy` / `npx wrangler deploy`). GitHub Actions runs CI (install, build, test) and does not deploy, so it cannot race Cloudflare Git integration or a local Wrangler deploy.

Cloudflare Workers Static Assets serves `dist/` and the same Worker handles `/api/*`, so there is no CORS setup in production.

## PWA install

On Android/Chromium, use the in-app **Install app** action when the browser exposes the install prompt. On iPhone/iPad, open Kin in Safari and use **Share → Add to Home Screen**. Web Push on iOS requires the Home Screen app.

## Native later

Tauri remains in `src-tauri/` with bundle ID `org.c0di.kin`. For native builds, set `VITE_RELAY_URL` to the deployed HTTPS Worker origin before building so the packaged webview talks to the Cloudflare relay.

```bash
VITE_RELAY_URL=https://YOUR-KIN-WORKER.workers.dev npm run tauri build
```

The upstream template has additional Android inset/scaffold tooling that should be retained when this is generated as a real GitHub template repository. The product frontend already keeps the template's platform-geometry bridge.

## Suggested next security milestone

Before treating Kin as a high-risk secure messenger, replace the static conversation-key protocol with audited Signal/MLS-style ratcheting, add device revocation/key rotation, and security-review the pairing ceremony. The UI/backend boundary is designed so that upgrade can happen without changing the family experience.
